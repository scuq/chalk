package store

// Phase 11a: per-device MLS KeyPackage stock.
//
// All operations here are server-side. We treat KP bytes as opaque:
// the server doesn't parse the MLS structure (that would require a
// Go MLS library; we'll add Go-side validation in a later phase if
// it becomes needed). Validation that the embedded client_id field
// matches the publishing connection happens at the WS layer, where
// we know the authenticated user_id + device_id.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// KeyPackageRow is one row from key_packages.
type KeyPackageRow struct {
	ID              int64
	DeviceID        uuid.UUID
	Ciphersuite     int
	CredentialType  int
	ClientIDClaimed string
	KeyPackageData  []byte
}

// InsertKeyPackages stores a batch of KPs for the given device.
// Returns the number stored (== len(entries) on success).
//
// Caller is responsible for having validated each entry's
// ClientIDClaimed against the authenticated user+device. The store
// trusts what it's handed.
func (s *Store) InsertKeyPackages(
	ctx context.Context,
	deviceID uuid.UUID,
	entries []KeyPackageRow,
) (int, error) {
	if len(entries) == 0 {
		return 0, nil
	}
	count := 0
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		for _, e := range entries {
			if _, err := tx.Exec(ctx,
				`INSERT INTO key_packages
				   (device_id, ciphersuite, credential_type,
				    client_id_claimed, key_package_data)
				 VALUES ($1, $2, $3, $4, $5)`,
				deviceID, e.Ciphersuite, e.CredentialType,
				e.ClientIDClaimed, e.KeyPackageData,
			); err != nil {
				return fmt.Errorf("insert key_package: %w", err)
			}
			count++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

// CountUnusedKeyPackages returns how many unused KPs the given
// device has on file for the given ciphersuite. Used by clients
// to decide whether to publish more.
func (s *Store) CountUnusedKeyPackages(
	ctx context.Context,
	deviceID uuid.UUID,
	ciphersuite int,
) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM key_packages
		  WHERE device_id = $1 AND ciphersuite = $2
		    AND used_at IS NULL`,
		deviceID, ciphersuite,
	).Scan(&n)
	return n, err
}

// ClaimedKeyPackage is one KP returned by ClaimKeyPackagesForUsers.
type ClaimedKeyPackage struct {
	UserID          uuid.UUID
	DeviceID        uuid.UUID
	ClientIDClaimed string
	Ciphersuite     int
	CredentialType  int
	KeyPackageData  []byte
}

// ClaimKeyPackagesForUsers fetches one unused KP per requested user,
// marks each as used (used_at = NOW()), and returns the claimed
// rows.
//
// Strategy: for each user, pick ONE device that has unused KPs (the
// device with the freshest KP wins by ID DESC -- not perfect, but
// "freshest device that bothered to publish" is a reasonable
// heuristic), then UPDATE ... RETURNING the row.
//
// Users with no unused KPs across any of their devices are silently
// omitted from the result. Callers decide how to surface that
// ("waiting for <user> to come online").
//
// All claims happen in a single transaction so we can't half-claim
// and lose KPs to a partial failure.
func (s *Store) ClaimKeyPackagesForUsers(
	ctx context.Context,
	userIDs []uuid.UUID,
	ciphersuite int,
) ([]ClaimedKeyPackage, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	out := make([]ClaimedKeyPackage, 0, len(userIDs))
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		for _, userID := range userIDs {
			// Find one unused KP for any device belonging to this
			// user. We use ORDER BY id DESC to prefer newer KPs.
			//
			// SELECT ... FOR UPDATE SKIP LOCKED would let concurrent
			// claims for the same user race past each other; for
			// 11a's traffic profile that's overkill -- the outer
			// transaction serializes us per-row already.
			var (
				kpID            int64
				deviceID        uuid.UUID
				clientIDClaimed string
				cs              int
				ct              int
				kpData          []byte
			)
			row := tx.QueryRow(ctx,
				`UPDATE key_packages
				    SET used_at = NOW()
				  WHERE id = (
				    SELECT kp.id
				      FROM key_packages kp
				      JOIN devices d ON d.id = kp.device_id
				     WHERE d.user_id = $1
				       AND kp.ciphersuite = $2
				       AND kp.used_at IS NULL
				     ORDER BY kp.id DESC
				     LIMIT 1
				  )
				 RETURNING id, device_id, client_id_claimed,
				           ciphersuite, credential_type, key_package_data`,
				userID, ciphersuite,
			)
			if err := row.Scan(&kpID, &deviceID, &clientIDClaimed, &cs, &ct, &kpData); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					// No unused KP for this user. Skip silently.
					continue
				}
				return fmt.Errorf("claim KP for user %s: %w", userID, err)
			}
			out = append(out, ClaimedKeyPackage{
				UserID:          userID,
				DeviceID:        deviceID,
				ClientIDClaimed: clientIDClaimed,
				Ciphersuite:     cs,
				CredentialType:  ct,
				KeyPackageData:  kpData,
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// KeyPackage sweep defaults (phase 11c-10). See
// chalk-keypackage-cleanup-concept.md.
const (
	// DefaultKPSweepKeepN is how many newest unused KPs per device the
	// superseded-sweep always preserves (2x the client republish target
	// of 10, for generous headroom).
	DefaultKPSweepKeepN = 20
	// DefaultKPSweepMinAge is the grace period before an unused KP is
	// eligible for the superseded-sweep, so a just-published batch the
	// claim-count hasn't observed yet is never deleted.
	DefaultKPSweepMinAge = 24 * time.Hour
	// DefaultKPUsedRetention is how long consumed (used_at) KPs are kept
	// for audit/debug before reclamation. Used KPs can never be claimed
	// again, so this is pure space management.
	DefaultKPUsedRetention = 7 * 24 * time.Hour
	// DefaultKPSweepInterval is the background sweep cadence.
	DefaultKPSweepInterval = time.Hour
)

// SweepOrphanedKeyPackages reclaims orphaned/stale KP rows under two
// conservative criteria, in a single transaction:
//
//	A (superseded unused): per device, keep the newest keepN unused KPs;
//	   delete older unused ones older than minAge.
//	B (consumed past retention): delete used KPs older than usedRetention.
//
// Returns (supersededDeleted, usedDeleted, err). Never touches a
// device's current newest-N unused KPs, so a live device is never
// starved. Phase 11c-10.
func (s *Store) SweepOrphanedKeyPackages(
	ctx context.Context,
	keepN int,
	minAge time.Duration,
	usedRetention time.Duration,
) (supersededDeleted int64, usedDeleted int64, err error) {
	if keepN < 0 {
		keepN = 0
	}
	minAgeSecs := minAge.Seconds()
	usedRetSecs := usedRetention.Seconds()

	err = s.withTx(ctx, func(tx pgx.Tx) error {
		// Criterion A: superseded unused KPs. Rank each device's unused
		// KPs newest-first; delete those ranked beyond keepN that are
		// also older than minAge. The window-function form is provably
		// per-device and avoids a correlated NOT IN subquery.
		tagA, aErr := tx.Exec(ctx,
			`WITH ranked AS (
			     SELECT id,
			            row_number() OVER (
			              PARTITION BY device_id
			              ORDER BY id DESC
			            ) AS rn,
			            created_at
			       FROM key_packages
			      WHERE used_at IS NULL
			 )
			 DELETE FROM key_packages kp
			  USING ranked r
			  WHERE kp.id = r.id
			    AND r.rn > $1
			    AND r.created_at < NOW() - make_interval(secs => $2)`,
			keepN, minAgeSecs,
		)
		if aErr != nil {
			return fmt.Errorf("sweep superseded unused KPs: %w", aErr)
		}
		supersededDeleted = tagA.RowsAffected()

		// Criterion B: consumed KPs past retention.
		tagB, bErr := tx.Exec(ctx,
			`DELETE FROM key_packages
			  WHERE used_at IS NOT NULL
			    AND used_at < NOW() - make_interval(secs => $1)`,
			usedRetSecs,
		)
		if bErr != nil {
			return fmt.Errorf("sweep consumed KPs: %w", bErr)
		}
		usedDeleted = tagB.RowsAffected()
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return supersededDeleted, usedDeleted, nil
}

// KeyPackageSweepLoop periodically runs SweepOrphanedKeyPackages.
// Mirrors PendingWelcomeSweepLoop (phase 11c-8): runs once immediately,
// then on interval, until ctx is cancelled. logf may be nil. Phase
// 11c-10.
func (s *Store) KeyPackageSweepLoop(
	ctx context.Context,
	interval time.Duration,
	keepN int,
	minAge time.Duration,
	usedRetention time.Duration,
	logf func(string, ...any),
) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	sweep := func() {
		sup, used, err := s.SweepOrphanedKeyPackages(ctx, keepN, minAge, usedRetention)
		if err != nil {
			logf("kp sweep: %v", err)
			return
		}
		if sup > 0 || used > 0 {
			logf("kp sweep: reclaimed %d superseded-unused, %d consumed", sup, used)
		}
	}
	sweep() // once on startup
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}

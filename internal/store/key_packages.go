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

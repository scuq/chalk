package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Passkey is a WebAuthn credential bound to a user.
//
// CredentialID is the WebAuthn credential ID (typically 16-128 bytes,
// authenticator-defined). PublicKey is the CBOR-encoded COSE key the
// auth library hands us. SignCount is the per-credential signature
// counter; the auth library tracks this and rejects authentications
// whose counter is unexpectedly lower than the stored value (a clone
// indicator). Counters of 0 are valid (many platform authenticators
// always return 0).
//
// Transports is the list of WebAuthn transport hints ('usb', 'nfc',
// 'ble', 'internal', 'hybrid'). Used to populate
// allowCredentials.transports for re-auth ceremonies so the browser
// preferences which authenticator to prompt for.
//
// Name is user-chosen at registration time ("my iPhone", "yubikey
// at desk"). May be empty until the user names the passkey from the
// settings panel.
//
// Flags is the raw WebAuthn AuthenticatorFlags octet (UP/UV/BE/BS/…)
// as of the last ceremony. nil means the row predates migration 0042
// and the flags were never recorded; the auth layer adopts the
// asserted flags on the next successful login. The BackupEligible bit
// in particular MUST round-trip: go-webauthn rejects a login whose
// asserted BE differs from the stored one.
type Passkey struct {
	CredentialID []byte
	UserID       uuid.UUID
	PublicKey    []byte
	SignCount    uint64
	Transports   []string
	Name         string
	Flags        *uint8 // nil = unknown (pre-0042 row)
	CreatedAt    time.Time
	LastUsedAt   time.Time // zero value if never used
}

// AddPasskey inserts a new credential bound to userID. The
// credential_id is the primary key; duplicates return an error
// (wrapped). The application should only ever generate one passkey
// per registration ceremony, so duplicate insert is a bug, not a
// race.
//
// transports may be nil; it's stored as an empty array in that case.
// name may be empty.
//
// flags is the raw AuthenticatorFlags octet from the registration
// ceremony (webauthn.Credential.Flags.MsgpByte()). It is always known
// at insert time, so the column is written non-NULL for every row
// created through this path.
func (s *Store) AddPasskey(
	ctx context.Context,
	credentialID []byte,
	userID uuid.UUID,
	publicKey []byte,
	signCount uint64,
	transports []string,
	name string,
	flags byte,
) (Passkey, error) {
	if len(credentialID) == 0 {
		return Passkey{}, fmt.Errorf("AddPasskey: credentialID required")
	}
	if len(publicKey) == 0 {
		return Passkey{}, fmt.Errorf("AddPasskey: publicKey required")
	}
	if transports == nil {
		transports = []string{}
	}
	var nameParam any
	if name != "" {
		nameParam = name
	}
	now := time.Now().UTC()
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO passkeys (
		   credential_id, user_id, public_key, sign_count, transports, name, flags, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		credentialID, userID, publicKey, int64(signCount), transports, nameParam,
		int16(flags), now,
	)
	if err != nil {
		return Passkey{}, fmt.Errorf("add passkey: %w", err)
	}
	storedFlags := flags
	return Passkey{
		CredentialID: credentialID,
		UserID:       userID,
		PublicKey:    publicKey,
		SignCount:    signCount,
		Transports:   transports,
		Name:         name,
		Flags:        &storedFlags,
		CreatedAt:    now,
	}, nil
}

// GetPasskeyByCredentialID fetches the credential row by its WebAuthn
// credential ID. Returns ErrNotFound if absent. The bulk of the
// auth-time work happens here: the library hands us a credential ID
// from the user agent and we resolve it to user_id + public_key.
func (s *Store) GetPasskeyByCredentialID(ctx context.Context, credentialID []byte) (Passkey, error) {
	var pk Passkey
	var name *string
	var lastUsed *time.Time
	var signCount int64
	var flags *int16
	err := s.Pool.QueryRow(ctx,
		`SELECT credential_id, user_id, public_key, sign_count, transports, name, flags, created_at, last_used_at
		   FROM passkeys WHERE credential_id = $1`,
		credentialID,
	).Scan(
		&pk.CredentialID,
		&pk.UserID,
		&pk.PublicKey,
		&signCount,
		&pk.Transports,
		&name,
		&flags,
		&pk.CreatedAt,
		&lastUsed,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Passkey{}, ErrNotFound
	}
	if err != nil {
		return Passkey{}, fmt.Errorf("get passkey: %w", err)
	}
	pk.SignCount = uint64(signCount)
	if name != nil {
		pk.Name = *name
	}
	if lastUsed != nil {
		pk.LastUsedAt = *lastUsed
	}
	pk.Flags = flagsFromColumn(flags)
	return pk, nil
}

// flagsFromColumn narrows the SMALLINT flags column to the octet the
// WebAuthn library round-trips. NULL stays nil (pre-0042 row, unknown).
// Values outside 0..255 can't occur — the column is only ever written
// from a byte — but they're masked rather than trusted.
func flagsFromColumn(v *int16) *uint8 {
	if v == nil {
		return nil
	}
	b := uint8(*v)
	return &b
}

// GetPasskeysForUser returns every credential registered for a user,
// ordered by created_at ascending. Used for two purposes:
//  1. Building the allowCredentials list for an authentication
//     ceremony (server has to tell the browser which credential IDs
//     it knows about for this user).
//  2. The settings panel that lists passkeys for revocation.
func (s *Store) GetPasskeysForUser(ctx context.Context, userID uuid.UUID) ([]Passkey, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT credential_id, user_id, public_key, sign_count, transports, name, flags, created_at, last_used_at
		   FROM passkeys WHERE user_id = $1
		   ORDER BY created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list passkeys: %w", err)
	}
	defer rows.Close()
	out := make([]Passkey, 0)
	for rows.Next() {
		var pk Passkey
		var name *string
		var lastUsed *time.Time
		var signCount int64
		var flags *int16
		if err := rows.Scan(
			&pk.CredentialID,
			&pk.UserID,
			&pk.PublicKey,
			&signCount,
			&pk.Transports,
			&name,
			&flags,
			&pk.CreatedAt,
			&lastUsed,
		); err != nil {
			return nil, fmt.Errorf("scan passkey: %w", err)
		}
		pk.SignCount = uint64(signCount)
		if name != nil {
			pk.Name = *name
		}
		if lastUsed != nil {
			pk.LastUsedAt = *lastUsed
		}
		pk.Flags = flagsFromColumn(flags)
		out = append(out, pk)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	return out, nil
}

// RecordPasskeyLogin persists the post-assertion state of a credential:
// it bumps sign_count, sets last_used_at = now(), and stores the raw
// AuthenticatorFlags octet. The auth library validates that newCount >
// currentCount before calling this; we don't re-check (would race).
// Idempotent on credentialID being gone: returns ErrNotFound but does
// not corrupt anything.
//
// The flags write is not merely a backfill for pre-0042 rows. The
// BackupState bit legitimately changes over a credential's life (a
// passkey gets synced to the cloud after the fact), and go-webauthn's
// storage guidance requires the relying party to track it, so it is
// rewritten on every login.
func (s *Store) RecordPasskeyLogin(ctx context.Context, credentialID []byte, newCount uint64, flags byte) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE passkeys
		    SET sign_count = $1, flags = $2, last_used_at = now()
		  WHERE credential_id = $3`,
		int64(newCount), int16(flags), credentialID,
	)
	if err != nil {
		return fmt.Errorf("record passkey login: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RenamePasskey sets the name field. Empty name clears it (NULL in
// the database). Returns ErrNotFound if the credential is gone.
func (s *Store) RenamePasskey(ctx context.Context, credentialID []byte, name string) error {
	var nameParam any
	if name != "" {
		nameParam = name
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE passkeys SET name = $1 WHERE credential_id = $2`,
		nameParam, credentialID,
	)
	if err != nil {
		return fmt.Errorf("rename passkey: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletePasskey removes a credential. Idempotent: deleting a gone
// credential is a no-op (no error).
//
// Caution: this can leave a user with zero passkeys, which locks
// them out of normal login. The application is responsible for the
// "do not delete the last passkey" check (or for re-prompting the
// user to enroll a new one before they delete the last). The store
// just does the SQL.
func (s *Store) DeletePasskey(ctx context.Context, credentialID []byte) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM passkeys WHERE credential_id = $1`, credentialID,
	)
	if err != nil {
		return fmt.Errorf("delete passkey: %w", err)
	}
	return nil
}

// ErrLastPasskey is returned by DeletePasskeyForUser when the target is
// the user's only remaining passkey. Removing it would strand the
// account on recovery-code-only (a one-time, contended secret), so it's
// refused; the user must enroll another passkey first.
var ErrLastPasskey = errors.New("cannot delete the last passkey")

// DeletePasskeyForUser deletes the passkey with credentialID, but only
// when it belongs to userID and is NOT the user's last passkey. The
// count and delete run in one transaction with the user's passkey rows
// locked FOR UPDATE, so two concurrent deletes can't race the account
// down to zero passkeys.
//
// Returns store.ErrNotFound if no such credential belongs to the user,
// and ErrLastPasskey if it is the user's only passkey.
func (s *Store) DeletePasskeyForUser(ctx context.Context, credentialID []byte, userID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT credential_id FROM passkeys WHERE user_id = $1 FOR UPDATE`, userID)
		if err != nil {
			return fmt.Errorf("lock passkeys: %w", err)
		}
		total := 0
		owned := false
		for rows.Next() {
			var cid []byte
			if err := rows.Scan(&cid); err != nil {
				rows.Close()
				return fmt.Errorf("scan passkey id: %w", err)
			}
			total++
			if bytes.Equal(cid, credentialID) {
				owned = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate passkeys: %w", err)
		}
		if !owned {
			return ErrNotFound
		}
		if total <= 1 {
			return ErrLastPasskey
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM passkeys WHERE credential_id = $1 AND user_id = $2`,
			credentialID, userID); err != nil {
			return fmt.Errorf("delete passkey: %w", err)
		}
		return nil
	})
}

// CountPasskeysForUser returns how many credentials the user has.
// Used by the application's last-passkey-protection check before
// allowing a DeletePasskey.
func (s *Store) CountPasskeysForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	err := s.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM passkeys WHERE user_id = $1`, userID,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count passkeys: %w", err)
	}
	return n, nil
}

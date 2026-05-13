package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// AdminBootstrapToken is a single-use, short-lived token that
// authorizes the admin's WebAuthn passkey enrollment. Created on
// first startup (when no admin row exists) and via the CLI
// subcommand `chalkd admin-bootstrap-token` for reissue.
type AdminBootstrapToken struct {
	Token     []byte
	CreatedAt time.Time
	ExpiresAt time.Time
	UsedAt    time.Time // zero if unused
}

// IsActive reports whether the token has not been used and has not
// expired. The application should treat IsActive == false as "no
// valid bootstrap pending."
func (t AdminBootstrapToken) IsActive() bool {
	if !t.UsedAt.IsZero() {
		return false
	}
	return time.Now().Before(t.ExpiresAt)
}

// AdminBootstrapTokenTTL is the default lifetime of a fresh bootstrap
// token. Centralized so the CLI and the first-run path agree.
const AdminBootstrapTokenTTL = 24 * time.Hour

// CreateAdminBootstrapToken atomically deletes any expired-but-unused
// tokens and inserts a fresh one. Returns the new token (including
// the raw 32 random bytes; the caller is responsible for putting
// these into the bootstrap URL and surfacing them to the operator).
//
// Returns ErrAdminBootstrapActive if an unexpired, unused token
// already exists. This is the partial-unique-index conflict path:
// the caller is responsible for revealing the existing token (via
// some operator-only channel) rather than creating a competing one.
// The CLI presents this as "an active token already exists; rotate
// or wait for it to expire."
func (s *Store) CreateAdminBootstrapToken(ctx context.Context) (AdminBootstrapToken, error) {
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("rand: %w", err)
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Sweep expired-but-unused rows so the partial unique index can
	// accept a new row. This is the only place that GCs the table;
	// there's no background janitor for it because the table is
	// nearly always empty.
	if _, err := tx.Exec(ctx,
		`DELETE FROM admin_bootstrap_tokens
		  WHERE used_at IS NULL AND expires_at <= now()`,
	); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("gc: %w", err)
	}

	now := time.Now().UTC()
	expires := now.Add(AdminBootstrapTokenTTL)

	_, err = tx.Exec(ctx,
		`INSERT INTO admin_bootstrap_tokens (token, created_at, expires_at)
		   VALUES ($1, $2, $3)`,
		tok, now, expires,
	)
	if err != nil {
		// The active-token-exists case surfaces as a unique-constraint
		// violation on admin_bootstrap_tokens_active_idx. Detect it via
		// a cheap string match on the error text rather than depending
		// on pgconn's SQLSTATE codes directly (works across pgx
		// versions).
		if isUniqueViolation(err) {
			return AdminBootstrapToken{}, ErrAdminBootstrapActive
		}
		return AdminBootstrapToken{}, fmt.Errorf("insert bootstrap token: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("commit: %w", err)
	}

	return AdminBootstrapToken{
		Token:     tok,
		CreatedAt: now,
		ExpiresAt: expires,
	}, nil
}

// GetActiveAdminBootstrapToken returns the current active token, if
// any. Returns ErrNotFound when no active token exists. "Active"
// means used_at IS NULL AND expires_at > now(); past tokens are
// invisible to this method.
//
// The application uses this to render the bootstrap URL again after
// a restart, and for the CLI subcommand to detect an existing token
// before offering to rotate.
func (s *Store) GetActiveAdminBootstrapToken(ctx context.Context) (AdminBootstrapToken, error) {
	var t AdminBootstrapToken
	var usedAt *time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT token, created_at, expires_at, used_at
		   FROM admin_bootstrap_tokens
		  WHERE used_at IS NULL AND expires_at > now()
		  LIMIT 1`,
	).Scan(&t.Token, &t.CreatedAt, &t.ExpiresAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminBootstrapToken{}, ErrNotFound
	}
	if err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("get active token: %w", err)
	}
	if usedAt != nil {
		t.UsedAt = *usedAt
	}
	return t, nil
}

// ConsumeAdminBootstrapToken atomically marks the given token used.
// Returns ErrNotFound if the token doesn't exist or has already
// been used or expired. Used by the bootstrap HTTP endpoint after
// the WebAuthn ceremony completes successfully.
func (s *Store) ConsumeAdminBootstrapToken(ctx context.Context, token []byte) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE admin_bootstrap_tokens
		    SET used_at = now()
		  WHERE token = $1
		    AND used_at IS NULL
		    AND expires_at > now()`,
		token,
	)
	if err != nil {
		return fmt.Errorf("consume bootstrap token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RotateAdminBootstrapToken is a convenience that revokes any active
// token (via UPDATE used_at = now()) and creates a fresh one. Used
// by the `chalkd admin-bootstrap-token --force` flag for the case
// where the operator has lost track of the previous token and wants
// a clean rotation.
func (s *Store) RotateAdminBootstrapToken(ctx context.Context) (AdminBootstrapToken, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Revoke any active token by stamping used_at = now(). This frees
	// the partial unique index for the new INSERT.
	if _, err := tx.Exec(ctx,
		`UPDATE admin_bootstrap_tokens
		    SET used_at = now()
		  WHERE used_at IS NULL`,
	); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("revoke active: %w", err)
	}

	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("rand: %w", err)
	}
	now := time.Now().UTC()
	expires := now.Add(AdminBootstrapTokenTTL)
	if _, err := tx.Exec(ctx,
		`INSERT INTO admin_bootstrap_tokens (token, created_at, expires_at)
		   VALUES ($1, $2, $3)`,
		tok, now, expires,
	); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminBootstrapToken{}, fmt.Errorf("commit: %w", err)
	}
	return AdminBootstrapToken{
		Token:     tok,
		CreatedAt: now,
		ExpiresAt: expires,
	}, nil
}

// ErrAdminBootstrapActive is returned by CreateAdminBootstrapToken
// when an unexpired, unused token already exists. The caller is
// responsible for surfacing the existing token (via
// GetActiveAdminBootstrapToken) or using RotateAdminBootstrapToken
// to forcibly replace it.
var ErrAdminBootstrapActive = errors.New("active admin bootstrap token already exists")

// isUniqueViolation matches pgx's unique-constraint error text. We
// use a cheap string match (rather than depending on pgconn's
// SQLSTATE codes directly) so this works across pgx versions.
// Matches both "unique" and "duplicate" forms.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate")
}

package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// User is a chalk account. One person may own multiple devices.
//
// Phase 09b extended this struct with the auth columns added by
// migration 0011: Username (immutable, login key), DisplayName
// (mutable, shown in UI), Email (private, admin-visible only),
// Role, EmailVerifiedAt, and the pending-email-change state.
//
// The Handle field is preserved for backward compatibility with
// the existing wire frames (WelcomePayload.Handle, ChannelMember.Handle,
// FriendSummary.Handle). A later sub-step renames those frames to
// DisplayName; until then Handle == DisplayName by migration 0011's
// backfill and by UpdateDisplayName keeping them in sync.
//
// Phase 06 lifecycle columns (users.status, status_reason,
// status_changed_at, last_seen_at) are NOT carried on this struct;
// they're accessed via dedicated methods or raw SQL where needed.
// Phase 09b doesn't change that.
type User struct {
	ID        uuid.UUID
	Handle    string
	CreatedAt time.Time

	// Phase 09b auth columns.
	Username        string    // immutable, ^[a-z0-9_]{3,32}$, unique
	DisplayName     string    // mutable, free-form
	Email           string    // unique, never shown to other users
	Role            string    // 'user' | 'admin'
	EmailVerifiedAt time.Time // zero value if unverified

	// Pending email change. All three are zero when no change is in
	// flight; all three are non-zero when one is.
	PendingEmail          string
	PendingEmailToken     []byte // 32 random bytes
	PendingEmailExpiresAt time.Time
}

// HasPendingEmail returns true when a verification is in flight.
func (u User) HasPendingEmail() bool {
	return u.PendingEmail != ""
}

// IsAdmin is a small convenience.
func (u User) IsAdmin() bool {
	return u.Role == "admin"
}

// userCols is the column list used by every "fetch one row" path.
// Centralized so changes to the User struct require one Scan() edit
// per query rather than one per file. The order matches scanUserRow.
//
// Optional columns (email_verified_at, pending_email_*) are COALESCE'd
// to sentinel values that scanUserRow detects and zeros out.
const userCols = `id,
  handle::text,
  created_at,
  username::text,
  display_name,
  email::text,
  role,
  COALESCE(email_verified_at, 'epoch'::timestamptz),
  COALESCE(pending_email::text, ''),
  COALESCE(pending_email_token, ''::bytea),
  COALESCE(pending_email_expires_at, 'epoch'::timestamptz)`

// rowScanner is satisfied by both *pgx.Row and *pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanUserRow scans the columns of userCols (in the same order) into
// the destination User. Sentinel-zero values for optional timestamps
// are translated to time.Time{}.
func scanUserRow(s rowScanner, u *User) error {
	var verifiedAt, pendingExpAt time.Time
	err := s.Scan(
		&u.ID,
		&u.Handle,
		&u.CreatedAt,
		&u.Username,
		&u.DisplayName,
		&u.Email,
		&u.Role,
		&verifiedAt,
		&u.PendingEmail,
		&u.PendingEmailToken,
		&pendingExpAt,
	)
	if err != nil {
		return err
	}
	// epoch sentinel translates to zero time.Time.
	if verifiedAt.Unix() > 0 {
		u.EmailVerifiedAt = verifiedAt
	}
	if pendingExpAt.Unix() > 0 {
		u.PendingEmailExpiresAt = pendingExpAt
	}
	// An empty bytea round-trips as a non-nil zero-length slice.
	// Normalize to nil for callers' nil-vs-non-nil checks.
	if len(u.PendingEmailToken) == 0 {
		u.PendingEmailToken = nil
	}
	return nil
}

// CreateUser inserts a new user with the given handle. Returns ErrConflict
// (wrapped) if the handle is taken.
//
// If id is uuid.Nil, a v4 UUID is generated. Otherwise the supplied id is
// used; this is what the test fixture uses to install deterministic UUIDs
// for alice/bob/carol.
//
// Phase 09b note: this method is preserved with its pre-09b signature
// for the tests and fixtures that pre-date real registration. It seeds
// username = handle, display_name = handle, email = handle@localhost.invalid,
// email_verified_at = now(), role = 'user'. Real registration in 09b-3
// uses a different code path that takes explicit username/email/role.
func (s *Store) CreateUser(ctx context.Context, id uuid.UUID, handle string) (User, error) {
	if id == uuid.Nil {
		id = uuid.New()
	}
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`INSERT INTO users (
		   id, handle, username, display_name, email, email_verified_at
		 ) VALUES (
		   $1, $2, $2::citext, $2, ($2 || '@localhost.invalid')::citext, now()
		 )
		   RETURNING `+userCols,
		id, handle,
	), &u)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// UpsertUser inserts or, on handle conflict, updates the existing row's id.
// Used by the test fixture to enforce deterministic UUIDs.
//
// Phase 09b: same backfill of username/display_name/email as CreateUser
// when inserting; on conflict, only the id is updated and other fields
// are left untouched.
func (s *Store) UpsertUser(ctx context.Context, id uuid.UUID, handle string) (User, error) {
	if id == uuid.Nil {
		return User{}, fmt.Errorf("UpsertUser: id required")
	}
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`INSERT INTO users (
		   id, handle, username, display_name, email, email_verified_at
		 ) VALUES (
		   $1, $2, $2::citext, $2, ($2 || '@localhost.invalid')::citext, now()
		 )
		   ON CONFLICT (handle) DO UPDATE SET id = EXCLUDED.id
		   RETURNING `+userCols,
		id, handle,
	), &u)
	if err != nil {
		return User{}, fmt.Errorf("upsert user: %w", err)
	}
	return u, nil
}

// GetUserByID fetches a user by primary key. Returns ErrNotFound if absent.
func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (User, error) {
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE id = $1`, id,
	), &u)
	return u, translateErr(err)
}

// GetUserByHandle fetches a user by handle (case-insensitive via citext).
// Phase 09b: kept for backward compatibility; new code should prefer
// GetUserByUsername which is the post-09b login key. Handle and
// username are equivalent for backfilled rows but will diverge once
// users can change their display_name independently.
func (s *Store) GetUserByHandle(ctx context.Context, handle string) (User, error) {
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE handle = $1`, handle,
	), &u)
	return u, translateErr(err)
}

// GetUserByUsername fetches a user by username (case-insensitive via
// citext). This is the canonical lookup for login.
func (s *Store) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE username = $1`, username,
	), &u)
	return u, translateErr(err)
}

// GetUserByEmail fetches a user by email (case-insensitive via citext).
// Used by admin moderation and email change validation.
func (s *Store) GetUserByEmail(ctx context.Context, email string) (User, error) {
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE email = $1`, email,
	), &u)
	return u, translateErr(err)
}

// UpdateDisplayName changes display_name. Returns ErrNotFound if the
// user does not exist. display_name is unconstrained free-form text;
// callers are responsible for any UI-level sanitization. The pre-09b
// handle column is also updated to match, to keep the existing wire
// frames (which still send Handle) consistent during the transition.
//
// The single bind parameter $1 is cast to text at both call sites so
// PostgreSQL infers a consistent type for the parameter regardless of
// the target column type. Without the explicit ::text on the
// display_name side, PG sees one site as text and one as citext and
// fails type inference with SQLSTATE 42P08.
func (s *Store) UpdateDisplayName(ctx context.Context, userID uuid.UUID, displayName string) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users SET display_name = $1::text, handle = $1::text::citext WHERE id = $2`,
		displayName, userID,
	)
	if err != nil {
		return fmt.Errorf("update display_name: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountUsers is a small helper used by tests and metrics.
func (s *Store) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// HandlesByID returns a map of user_id -> handle for the given user IDs.
// Missing rows are simply absent from the map (caller treats absence as
// "unknown user"). Empty input returns an empty map without hitting PG.
//
// Used in phase 08c to enrich channel summaries and welcome frames with
// human-readable handles so the SPA doesn't have to display raw UUIDs.
//
// Phase 09b note: handle still mirrors display_name via UpdateDisplayName,
// so this method returns the same strings DisplayNamesByID would. The
// wire rename to display_name will switch callers over to the new
// accessor in a later sub-step; both exist now.
func (s *Store) HandlesByID(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error) {
	return s.namesByIDFromColumn(ctx, ids, "handle::text")
}

// DisplayNamesByID is the phase 09b name for HandlesByID. Returns the
// same data (display_name is backfilled from handle and kept in sync
// by UpdateDisplayName). A later sub-step will migrate callers to
// this name and remove HandlesByID.
func (s *Store) DisplayNamesByID(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error) {
	return s.namesByIDFromColumn(ctx, ids, "display_name")
}

// namesByIDFromColumn is the shared implementation behind HandlesByID
// and DisplayNamesByID. col is internal-only (never user input).
func (s *Store) namesByIDFromColumn(ctx context.Context, ids []uuid.UUID, col string) (map[uuid.UUID]string, error) {
	out := make(map[uuid.UUID]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id, `+col+` FROM users WHERE id = ANY($1::uuid[])`,
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", col, err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("scan %s: %w", col, err)
		}
		out[id] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	return out, nil
}

// ---- phase 09c: email change ----------------------------------------

// ErrPendingEmailMismatch is returned by FinalizeEmailChange when the
// submitted token doesn't match the user's stored pending_email_token,
// the pending_email_expires_at has passed, or no change is pending.
// All three conditions surface as the same error to avoid disclosing
// which field disagreed.
var ErrPendingEmailMismatch = errors.New("pending email mismatch")

// SetPendingEmailParams is the input to SetPendingEmail.
type SetPendingEmailParams struct {
	UserID    uuid.UUID
	NewEmail  string
	Token     []byte // 32 random bytes, application-generated
	ExpiresAt time.Time
}

// SetPendingEmail installs a pending email-change for userID. Idempotent
// in the sense that calling it again replaces any prior pending state
// (the user is starting over with a new candidate email). The unique
// partial index on users.pending_email enforces that no two users can
// have the same pending change in flight at once; if it fires, the
// caller gets ErrEmailTaken.
//
// Validation NOT done here (caller's responsibility): email shape,
// blacklist check, collision with users.email. Done at the auth HTTP
// layer where the error mapping is appropriate.
func (s *Store) SetPendingEmail(ctx context.Context, p SetPendingEmailParams) error {
	if p.UserID == uuid.Nil {
		return fmt.Errorf("SetPendingEmail: user_id required")
	}
	if p.NewEmail == "" {
		return fmt.Errorf("SetPendingEmail: new_email required")
	}
	if len(p.Token) == 0 {
		return fmt.Errorf("SetPendingEmail: token required")
	}
	if p.ExpiresAt.IsZero() {
		return fmt.Errorf("SetPendingEmail: expires_at required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users
		    SET pending_email = $2,
		        pending_email_token = $3,
		        pending_email_expires_at = $4
		  WHERE id = $1`,
		p.UserID, p.NewEmail, p.Token, p.ExpiresAt,
	)
	if err != nil {
		// pending_email unique constraint name from migration 0011.
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "users_pending_email_idx") ||
			(strings.Contains(msg, "unique") && strings.Contains(msg, "pending_email")) {
			return ErrEmailTaken
		}
		return fmt.Errorf("set pending email: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClearPendingEmail wipes any pending email-change state for userID.
// Called by the user-cancel path and as cleanup when the change is
// finalized. Idempotent: clearing a user with no pending change is a
// no-op.
func (s *Store) ClearPendingEmail(ctx context.Context, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return fmt.Errorf("ClearPendingEmail: user_id required")
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE users
		    SET pending_email = NULL,
		        pending_email_token = NULL,
		        pending_email_expires_at = NULL
		  WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("clear pending email: %w", err)
	}
	return nil
}

// FinalizeEmailChange atomically:
//   1. Verifies that the user has a pending email-change matching token
//      that hasn't expired.
//   2. Copies pending_email → email, sets email_verified_at = now().
//   3. Clears all pending_email_* fields.
//
// Returns:
//   - the user's ID + the new email on success
//   - ErrPendingEmailMismatch if no row matches (token wrong, expired,
//     or no pending change)
//   - ErrEmailTaken if a race with another user's same-email registration
//     has occurred between SetPendingEmail and finalize (vanishingly
//     rare but possible).
//
// Implementation note: the UPDATE clause matches by token AND
// expires_at > now() AND pending_email IS NOT NULL. If zero rows
// match, ErrPendingEmailMismatch is returned. A unique-violation on
// the new users.email value surfaces as ErrEmailTaken.
func (s *Store) FinalizeEmailChange(ctx context.Context, token []byte) (uuid.UUID, string, error) {
	if len(token) == 0 {
		return uuid.Nil, "", fmt.Errorf("FinalizeEmailChange: token required")
	}
	var userID uuid.UUID
	var newEmail string
	err := s.Pool.QueryRow(ctx,
		`UPDATE users
		    SET email = pending_email,
		        email_verified_at = now(),
		        pending_email = NULL,
		        pending_email_token = NULL,
		        pending_email_expires_at = NULL
		  WHERE pending_email_token = $1
		    AND pending_email IS NOT NULL
		    AND pending_email_expires_at > now()
		  RETURNING id, email::text`,
		token,
	).Scan(&userID, &newEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", ErrPendingEmailMismatch
	}
	if err != nil {
		// Race with another user grabbing the same email between
		// SetPendingEmail and FinalizeEmailChange. The users.email
		// unique index fires.
		if isUserUniqueViolation(err, "email") {
			return uuid.Nil, "", ErrEmailTaken
		}
		return uuid.Nil, "", fmt.Errorf("finalize email change: %w", err)
	}
	return userID, newEmail, nil
}

package store

// Phase 09d-1: admin moderation store methods.
//
// This file holds the database-side operations the admin moderation
// endpoints need:
//
//   BootstrapAdminUser — first-run admin row creation (called from
//     chalkd startup when no admin row exists yet, the operator has
//     set CHALK_ADMIN_USERNAME and _EMAIL, and we're about to mint a
//     one-time bootstrap token so the admin can register a passkey)
//
//   BlockUser / UnblockUser — set / clear users.blocked_at
//   SoftDeleteUser — set users.deleted_at
//   PurgeUser — hard-DELETE the row + cascade + return former
//     identity so the caller can add the email to the blacklist
//
//   ListUsers — paginated list with optional search across username
//     / display_name / email; orders by created_at DESC
//   ListBlacklist — paginated list of email_blacklist
//
// The admin singleton (migration 0011) and the refuse_admin_delete
// + refuse_admin_lifecycle_change triggers (migrations 0011 + 0019)
// enforce the safety invariants at the DB layer. The application
// SHOULD still refuse to block/delete the admin before reaching the
// DB so the user-facing error is a 4xx rather than a 500, but if the
// application slips, the triggers fail closed.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---- Bootstrap ----------------------------------------------------------

// BootstrapAdminUserParams is the input to BootstrapAdminUser.
type BootstrapAdminUserParams struct {
	Username    string // ASCII, matches ^[a-z0-9_]{3,32}$
	Email       string // user-visible email
	DisplayName string // defaults to Username if empty
}

// BootstrapAdminUser inserts the singleton admin row. Called by chalkd
// at startup when no admin row exists yet AND the operator has
// supplied CHALK_ADMIN_USERNAME + CHALK_ADMIN_EMAIL.
//
// The row is created with role='admin', email_verified_at=now() (the
// operator-supplied email is treated as ground truth; there's no
// verification ceremony for the bootstrap path), and NO passkey
// associated yet. The companion CreateAdminBootstrapToken issues a
// short-lived token authorizing passkey enrollment via the
// /api/admin/bootstrap endpoint.
//
// Returns ErrAdminExists if an admin row is already present — i.e.
// the singleton was already bootstrapped. This makes the method safe
// to call unconditionally from startup; the caller decides whether
// to surface the error or treat it as a no-op.
//
// Returns ErrUsernameTaken / ErrEmailTaken if the chosen identity
// collides with a non-admin user (the operator must pick a fresh
// identity or rename the colliding row before bootstrapping).
func (s *Store) BootstrapAdminUser(ctx context.Context, p BootstrapAdminUserParams) (User, error) {
	if p.Username == "" {
		return User{}, fmt.Errorf("BootstrapAdminUser: username required")
	}
	if p.Email == "" {
		return User{}, fmt.Errorf("BootstrapAdminUser: email required")
	}
	display := p.DisplayName
	if display == "" {
		display = p.Username
	}
	id := uuid.New()
	var u User
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// First check: does an admin already exist? We do this in-tx
		// to make the "no admin exists" precondition race-free against
		// concurrent bootstrap attempts. The partial unique index
		// users_single_admin_idx would also catch a second insert, but
		// reporting a clearer error here is better UX.
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
		).Scan(&exists); err != nil {
			return fmt.Errorf("check admin exists: %w", err)
		}
		if exists {
			return ErrAdminExists
		}
		row := tx.QueryRow(ctx,
			`INSERT INTO users (
			   id, handle, username, display_name, email,
			   role, email_verified_at
			 ) VALUES (
			   $1, $2::citext, $2::citext, $3, $4::citext,
			   'admin', now()
			 )
			 RETURNING `+userCols,
			id, p.Username, display, p.Email,
		)
		return scanUserRow(row, &u)
	})
	if err != nil {
		if errors.Is(err, ErrAdminExists) {
			return User{}, err
		}
		if isUserUniqueViolation(err, "username") || isUserUniqueViolation(err, "handle") {
			return User{}, ErrUsernameTaken
		}
		if isUserUniqueViolation(err, "email") {
			return User{}, ErrEmailTaken
		}
		// users_single_admin_idx fires here only if our pre-check
		// raced with another bootstrap (effectively impossible at
		// startup but still possible if a second chalkd is being
		// brought up against the same DB). Map to ErrAdminExists.
		if isUniqueViolation(err) && strings.Contains(strings.ToLower(err.Error()), "single_admin") {
			return User{}, ErrAdminExists
		}
		return User{}, fmt.Errorf("bootstrap admin: %w", err)
	}
	return u, nil
}

// ErrAdminExists is returned by BootstrapAdminUser when an admin row
// is already present. The startup path treats this as "already
// bootstrapped, do nothing further" rather than as a fatal error.
var ErrAdminExists = errors.New("admin user already exists")

// GetAdminUser returns the singleton admin row. Returns ErrNotFound
// if no admin has been bootstrapped yet. The users_single_admin_idx
// from migration 0011 guarantees at most one row matches; the
// LIMIT 1 is defense against schema drift.
//
// Used by the admin-bootstrap HTTP path to resolve the admin
// identity from a bootstrap token without exposing the underlying
// pool to the auth package.
func (s *Store) GetAdminUser(ctx context.Context) (User, error) {
	var u User
	err := scanUserRow(s.Pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE role = 'admin' LIMIT 1`,
	), &u)
	return u, translateErr(err)
}

// ---- Moderation: block / unblock / soft-delete --------------------------

// ErrUserBlocked is returned by login / recovery paths when the
// target user has a non-NULL blocked_at. Status: 403.
var ErrUserBlocked = errors.New("user is blocked")

// ErrUserDeleted is returned when the target user has a non-NULL
// deleted_at. Status: 410.
var ErrUserDeleted = errors.New("user has been deleted")

// ErrCannotModifyAdmin is returned by the admin-moderation paths when
// the operator tries to block / soft-delete / purge the admin user.
// The DB-side triggers also enforce this; the explicit application
// check makes the user-facing error a clean 409 instead of a 500.
var ErrCannotModifyAdmin = errors.New("cannot modify admin user")

// BlockUser sets users.blocked_at = now() for userID. Returns
// ErrNotFound if no such user, ErrCannotModifyAdmin if userID is
// the admin row.
//
// Idempotent: re-blocking an already-blocked user is a no-op
// (blocked_at is not updated to a new timestamp because the first
// block stamp is the more interesting audit value).
func (s *Store) BlockUser(ctx context.Context, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return fmt.Errorf("BlockUser: userID required")
	}
	// Application-level admin guard. The DB trigger also fires, but
	// the message text from the trigger is RAISE EXCEPTION which we'd
	// surface as a generic 500. Catch the admin case here first.
	var role string
	err := s.Pool.QueryRow(ctx,
		`SELECT role FROM users WHERE id = $1`, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lookup user role: %w", err)
	}
	if role == "admin" {
		return ErrCannotModifyAdmin
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users
		    SET blocked_at = COALESCE(blocked_at, now())
		  WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("block user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UnblockUser clears users.blocked_at for userID. Returns ErrNotFound
// if no such user. Idempotent: unblocking a not-blocked user is a
// no-op.
func (s *Store) UnblockUser(ctx context.Context, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return fmt.Errorf("UnblockUser: userID required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users SET blocked_at = NULL WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("unblock user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SoftDeleteUser sets users.deleted_at = now() for userID. The user
// row stays so the email remains claimed and messages.sender_id
// stays valid. Returns ErrNotFound if no such user,
// ErrCannotModifyAdmin if userID is the admin row.
//
// Idempotent: re-soft-deleting is a no-op.
func (s *Store) SoftDeleteUser(ctx context.Context, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return fmt.Errorf("SoftDeleteUser: userID required")
	}
	var role string
	err := s.Pool.QueryRow(ctx,
		`SELECT role FROM users WHERE id = $1`, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lookup user role: %w", err)
	}
	if role == "admin" {
		return ErrCannotModifyAdmin
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users
		    SET deleted_at = COALESCE(deleted_at, now())
		  WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("soft delete user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Purge --------------------------------------------------------------

// PurgedUser captures the identity of a hard-deleted user so the
// caller can add the email to the blacklist after the DELETE
// commits.
type PurgedUser struct {
	UserID      uuid.UUID
	Username    string
	DisplayName string
	Email       string
}

// PurgeUser hard-deletes the users row for userID. Cascading FKs
// (sessions, passkeys, recovery_codes, invites, friends, channel
// members, presence) wipe related data; messages.sender_id is set
// to NULL via the ON DELETE SET NULL from migration 0009 so the
// message bodies survive but become orphaned (displayed as
// "(deleted)" in the UI).
//
// Returns the identity that was deleted (so the caller can add the
// email to email_blacklist), ErrNotFound if the row was already
// gone, or ErrCannotModifyAdmin if userID is the admin row (the
// refuse_admin_delete trigger would also fire; the application
// guard makes the user-facing error a clean 409).
//
// PurgeUser does NOT itself touch email_blacklist; that's a
// separate step the HTTP handler runs after a successful purge.
// Keeping them separate means a transient blacklist failure
// doesn't undo the purge.
func (s *Store) PurgeUser(ctx context.Context, userID uuid.UUID) (PurgedUser, error) {
	if userID == uuid.Nil {
		return PurgedUser{}, fmt.Errorf("PurgeUser: userID required")
	}
	var pu PurgedUser
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx,
			`SELECT id, username::text, display_name, email::text, role
			   FROM users WHERE id = $1`,
			userID,
		).Scan(&pu.UserID, &pu.Username, &pu.DisplayName, &pu.Email, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lookup user: %w", err)
		}
		if role == "admin" {
			return ErrCannotModifyAdmin
		}
		// The DELETE cascades via FKs to all dependent tables. The
		// messages table has ON DELETE SET NULL on sender_id so
		// message bodies survive.
		tag, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
		if err != nil {
			return fmt.Errorf("delete user: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// Raced with another purge — extremely unlikely given
			// admin-only access, but report cleanly.
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return PurgedUser{}, err
	}
	return pu, nil
}

// ---- Listing ------------------------------------------------------------

// ListUsersParams paginates ListUsers. Limit caps at 200 per page to
// keep query/response sizes predictable; the caller can paginate
// with Offset for larger admin sweeps. Search, when non-empty, is
// a case-insensitive substring match against username, display_name,
// and email; an empty Search returns all users.
type ListUsersParams struct {
	Search string
	Limit  int
	Offset int
}

// UserSummary is the admin-list wire shape. Includes the
// moderation timestamps so the admin UI can render status badges
// without a per-row follow-up query. Does NOT include the passkey
// list or session count; those are out of scope for the bulk list.
type UserSummary struct {
	ID              uuid.UUID
	Username        string
	DisplayName     string
	Email           string
	Role            string
	CreatedAt       time.Time
	EmailVerifiedAt time.Time // zero if unverified
	BlockedAt       time.Time // zero if not blocked
	DeletedAt       time.Time // zero if not soft-deleted
}

// IsBlocked is a small convenience.
func (u UserSummary) IsBlocked() bool { return !u.BlockedAt.IsZero() }

// IsDeleted is a small convenience.
func (u UserSummary) IsDeleted() bool { return !u.DeletedAt.IsZero() }

// ListUsersResult bundles the page slice and the total count so the
// admin UI can render pagination controls without a second call.
type ListUsersResult struct {
	Users []UserSummary
	Total int64
}

// ListUsers returns a paginated page of users. Search, if set, is
// case-insensitive substring match across username, display_name,
// and email. Total is the COUNT(*) for the same WHERE clause so
// callers can implement pagination UI.
//
// The two queries (count + select) are run in the same transaction
// at READ COMMITTED so a row inserted between them might or might
// not appear in both — that's acceptable for an admin list; the
// next page load will show the consistent view.
func (s *Store) ListUsers(ctx context.Context, p ListUsersParams) (ListUsersResult, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	offset := p.Offset
	if offset < 0 {
		offset = 0
	}
	search := strings.TrimSpace(p.Search)

	// The search expression is built once and used in both queries.
	// We pass it as $1; the like_safe helper escapes the user-supplied
	// % and _ so they're treated as literals rather than wildcards.
	var (
		whereClause string
		args        []any
	)
	if search != "" {
		whereClause = `WHERE (username::text ILIKE $1
		                 OR display_name ILIKE $1
		                 OR email::text ILIKE $1)`
		args = append(args, "%"+likeEscape(search)+"%")
	}

	var result ListUsersResult
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		countSQL := `SELECT count(*) FROM users ` + whereClause
		if err := tx.QueryRow(ctx, countSQL, args...).Scan(&result.Total); err != nil {
			return fmt.Errorf("count users: %w", err)
		}

		// $N positioning: if search is set we already used $1; limit
		// and offset get $2 and $3. Otherwise they're $1 and $2.
		limArgs := append([]any(nil), args...)
		var limPlaceholder, offPlaceholder string
		switch len(limArgs) {
		case 0:
			limArgs = append(limArgs, limit, offset)
			limPlaceholder, offPlaceholder = "$1", "$2"
		case 1:
			limArgs = append(limArgs, limit, offset)
			limPlaceholder, offPlaceholder = "$2", "$3"
		}

		listSQL := `SELECT id, username::text, display_name, email::text, role,
		                   created_at,
		                   COALESCE(email_verified_at, 'epoch'::timestamptz),
		                   COALESCE(blocked_at, 'epoch'::timestamptz),
		                   COALESCE(deleted_at, 'epoch'::timestamptz)
		              FROM users ` + whereClause + `
		           ORDER BY created_at DESC
		              LIMIT ` + limPlaceholder + ` OFFSET ` + offPlaceholder
		rows, err := tx.Query(ctx, listSQL, limArgs...)
		if err != nil {
			return fmt.Errorf("list users: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var u UserSummary
			var verifiedAt, blockedAt, deletedAt time.Time
			if err := rows.Scan(
				&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role,
				&u.CreatedAt,
				&verifiedAt, &blockedAt, &deletedAt,
			); err != nil {
				return fmt.Errorf("scan user: %w", err)
			}
			// epoch sentinel → zero time, same convention scanUserRow
			// uses for the optional timestamps in users.go.
			if verifiedAt.Unix() > 0 {
				u.EmailVerifiedAt = verifiedAt
			}
			if blockedAt.Unix() > 0 {
				u.BlockedAt = blockedAt
			}
			if deletedAt.Unix() > 0 {
				u.DeletedAt = deletedAt
			}
			result.Users = append(result.Users, u)
		}
		return rows.Err()
	})
	if err != nil {
		return ListUsersResult{}, err
	}
	if result.Users == nil {
		result.Users = []UserSummary{} // never return nil so JSON serializes as []
	}
	return result, nil
}

// likeEscape doubles % and _ so a user-supplied search string with
// SQL LIKE wildcards is treated as a literal. ILIKE in PG honors
// backslash-escapes by default. We also escape backslashes so the
// caller doesn't have to think about it.
func likeEscape(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}

// ---- Blacklist listing --------------------------------------------------

// ListBlacklistParams paginates ListBlacklist. Same limit cap as
// ListUsers (200).
type ListBlacklistParams struct {
	Limit  int
	Offset int
}

// ListBlacklistResult bundles the page + total.
type ListBlacklistResult struct {
	Entries []BlacklistEntry
	Total   int64
}

// ListBlacklist returns a paginated page of email_blacklist entries,
// newest first. AddedBy is resolved via JOIN where possible; if the
// admin who added the entry was later deleted, AddedBy is uuid.Nil
// (the row's ON DELETE SET NULL fires on the FK).
func (s *Store) ListBlacklist(ctx context.Context, p ListBlacklistParams) (ListBlacklistResult, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	offset := p.Offset
	if offset < 0 {
		offset = 0
	}
	var result ListBlacklistResult
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM email_blacklist`,
		).Scan(&result.Total); err != nil {
			return fmt.Errorf("count blacklist: %w", err)
		}
		rows, err := tx.Query(ctx,
			`SELECT email::text, reason, added_at,
			        COALESCE(added_by, '00000000-0000-0000-0000-000000000000'::uuid),
			        COALESCE(former_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
			        COALESCE(former_username::text, '')
			   FROM email_blacklist
			  ORDER BY added_at DESC
			  LIMIT $1 OFFSET $2`,
			limit, offset,
		)
		if err != nil {
			return fmt.Errorf("list blacklist: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var e BlacklistEntry
			if err := rows.Scan(
				&e.Email, &e.Reason, &e.AddedAt,
				&e.AddedBy, &e.FormerUserID, &e.FormerUsername,
			); err != nil {
				return fmt.Errorf("scan blacklist: %w", err)
			}
			result.Entries = append(result.Entries, e)
		}
		return rows.Err()
	})
	if err != nil {
		return ListBlacklistResult{}, err
	}
	if result.Entries == nil {
		result.Entries = []BlacklistEntry{}
	}
	return result, nil
}

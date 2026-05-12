package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// User is a chalk account. One person may own multiple devices.
type User struct {
	ID        uuid.UUID
	Handle    string
	CreatedAt time.Time
}

// CreateUser inserts a new user with the given handle. Returns ErrConflict
// (wrapped) if the handle is taken.
//
// If id is uuid.Nil, a v4 UUID is generated. Otherwise the supplied id is
// used; this is what the test fixture uses to install deterministic UUIDs
// for alice/bob/carol.
func (s *Store) CreateUser(ctx context.Context, id uuid.UUID, handle string) (User, error) {
	if id == uuid.Nil {
		id = uuid.New()
	}
	var u User
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO users (id, handle) VALUES ($1, $2)
		   RETURNING id, handle::text, created_at`,
		id, handle,
	).Scan(&u.ID, &u.Handle, &u.CreatedAt)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// UpsertUser inserts or, on handle conflict, updates the existing row's id.
// Used by the test fixture to enforce deterministic UUIDs.
func (s *Store) UpsertUser(ctx context.Context, id uuid.UUID, handle string) (User, error) {
	if id == uuid.Nil {
		return User{}, fmt.Errorf("UpsertUser: id required")
	}
	var u User
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO users (id, handle) VALUES ($1, $2)
		   ON CONFLICT (handle) DO UPDATE SET id = EXCLUDED.id
		   RETURNING id, handle::text, created_at`,
		id, handle,
	).Scan(&u.ID, &u.Handle, &u.CreatedAt)
	if err != nil {
		return User{}, fmt.Errorf("upsert user: %w", err)
	}
	return u, nil
}

// GetUserByID fetches a user by primary key. Returns ErrNotFound if absent.
func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (User, error) {
	var u User
	err := s.Pool.QueryRow(ctx,
		`SELECT id, handle::text, created_at FROM users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Handle, &u.CreatedAt)
	return u, translateErr(err)
}

// GetUserByHandle fetches a user by handle (case-insensitive via citext).
func (s *Store) GetUserByHandle(ctx context.Context, handle string) (User, error) {
	var u User
	err := s.Pool.QueryRow(ctx,
		`SELECT id, handle::text, created_at FROM users WHERE handle = $1`, handle,
	).Scan(&u.ID, &u.Handle, &u.CreatedAt)
	return u, translateErr(err)
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
// Phase 09 will replace handles with passkey-derived usernames; the
// signature stays the same -- handle is still just a single string.
func (s *Store) HandlesByID(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error) {
	out := make(map[uuid.UUID]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	// pgx supports passing a []uuid.UUID directly as a single parameter
	// for the ANY($1) idiom; both ANY($1::uuid[]) and the unnest form work.
	// We prefer ANY for clarity.
	rows, err := s.Pool.Query(ctx,
		`SELECT id, handle FROM users WHERE id = ANY($1::uuid[])`,
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("query handles: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var handle string
		if err := rows.Scan(&id, &handle); err != nil {
			return nil, fmt.Errorf("scan handle: %w", err)
		}
		out[id] = handle
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	return out, nil
}

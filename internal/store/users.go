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

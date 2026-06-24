// Package store is chalk's data layer. It wraps a pgxpool.Pool and exposes
// typed methods for users, devices, and (in later phases) channels, messages,
// keypackages, blobs, and friendships.
//
// Style choices:
//   - No ORM. Raw SQL with prepared statements.
//   - Methods are organized by entity in separate files (users.go, devices.go).
//   - All methods take context.Context; callers control cancellation/timeouts.
//   - Errors wrap the pgx error with package context so callers don't need
//     to import pgx to check ErrNoRows -- we expose ErrNotFound here instead.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a single-row lookup misses.
var ErrNotFound = errors.New("not found")

// Store is the chalk data layer. Hold one per process and share via DI.
type Store struct {
	Pool *pgxpool.Pool
}

// Open creates a Store from a Postgres URL. Caller must Close when done.
//
// The pool is sized at max(4, 2*numCPU) by default and probes the database
// before returning so a misconfigured DB_URL fails immediately rather than
// at first query.
func Open(ctx context.Context, dbURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	// Defaults; phase 12 makes these tunable via Config.
	if cfg.MaxConns < 4 {
		cfg.MaxConns = 4
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return &Store{Pool: pool}, nil
}

// Close releases the pool. Idempotent.
func (s *Store) Close() {
	if s == nil || s.Pool == nil {
		return
	}
	s.Pool.Close()
	s.Pool = nil
}

// withTx runs fn inside a transaction. Helper for store methods that need
// multi-statement atomicity. Rolls back if fn returns an error or panics.
func (s *Store) withTx(ctx context.Context, fn func(pgx.Tx) error) (err error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

// translateErr maps pgx-specific errors to our package's exported errors.
// Use at the boundary of every store method that does a single-row lookup.
func translateErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

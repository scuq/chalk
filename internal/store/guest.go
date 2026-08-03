package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 80-3: Guest is the data layer for connections serving an ephemeral guest
// (docs/PHASE-80-EPHEMERAL.md). It is a SEPARATE TYPE holding only the
// restricted chalk_guest pool, on purpose: the guest path cannot reach for a
// privileged *Store method by mistake -- that is a compile error, not a
// runtime one -- and a *Guest method cannot forget the SET LOCALs, because
// withTx is the only way it touches the database.
//
// The fence itself lives in Postgres (migration 0050): the chalk_guest role
// has no grant at all on sessions, user_auth, friendships, attachments and
// the rest, and FORCE row-level security scopes every reachable shared table
// to the one channel named by the transaction-local settings below. This
// type is how the server holds that role's pool; the application-level frame
// allowlist (80-9) is defence in depth on top.
type Guest struct {
	pool *pgxpool.Pool
}

// OpenGuest creates a Guest from the CHALK_DB_URL_GUEST connection string
// (the chalk_guest role). Caller must Close when done.
//
// The pool is deliberately small: guest traffic is one voice room's worth of
// people, not the whole deployment.
func OpenGuest(ctx context.Context, dbURL string) (*Guest, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse guest db url: %w", err)
	}
	if cfg.MaxConns < 2 {
		cfg.MaxConns = 2
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create guest pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping guest db: %w", err)
	}
	return &Guest{pool: pool}, nil
}

// Close releases the pool. Idempotent.
func (g *Guest) Close() {
	if g == nil || g.pool == nil {
		return
	}
	g.pool.Close()
	g.pool = nil
}

// withTx runs fn inside a transaction with the guest identity pinned via
// SET LOCAL, which every 0050 policy reads. set_config(..., true) is the
// parameterizable spelling of SET LOCAL: transaction-scoped, so pgxpool
// connection reuse cannot leak the identity into the next borrower, and a
// transaction opened any other way sees NULL settings -> zero rows.
func (g *Guest) withTx(ctx context.Context, guestUser, guestChannel uuid.UUID, fn func(pgx.Tx) error) (err error) {
	if guestUser == uuid.Nil || guestChannel == uuid.Nil {
		return fmt.Errorf("guest tx: missing guest identity (user=%s channel=%s)", guestUser, guestChannel)
	}
	tx, err := g.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin guest tx: %w", err)
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
	if _, err = tx.Exec(ctx,
		`SELECT set_config('chalk.guest_user', $1, true),
		        set_config('chalk.guest_channel', $2, true)`,
		guestUser.String(), guestChannel.String(),
	); err != nil {
		return fmt.Errorf("set guest identity: %w", err)
	}
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit guest tx: %w", err)
	}
	return nil
}

package store

// Shared scaffolding for store tests that need a real Postgres: a scratch
// database built from the full migration chain plus the runtime partition
// machinery. Skips without CHALK_TEST_PGURL (the integration convention),
// e.g. CHALK_TEST_PGURL=postgres://chalk:chalk@localhost:5432/chalk against
// the dev container.

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	chalk "github.com/scuq/chalk"
	"github.com/scuq/chalk/internal/migrate"
)

// openProbeDB creates (and on cleanup drops) the scratch database name,
// applies every migration and ensures current-month partitions, returning an
// owner pool connected to it.
func openProbeDB(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	src := os.Getenv("CHALK_TEST_PGURL")
	if src == "" {
		t.Skip("CHALK_TEST_PGURL not set; test needs a live Postgres")
	}
	ctx := context.Background()

	u, err := url.Parse(src)
	if err != nil {
		t.Fatalf("parse CHALK_TEST_PGURL: %v", err)
	}
	admin := *u
	admin.Path = "/postgres"
	adminConn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	if _, err := adminConn.Exec(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
		t.Fatalf("drop probe db: %v", err)
	}
	if _, err := adminConn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create probe db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminConn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		_ = adminConn.Close(context.Background())
	})

	probe := *u
	probe.Path = "/" + name
	pool, err := pgxpool.New(ctx, probe.String())
	if err != nil {
		t.Fatalf("connect probe db: %v", err)
	}
	t.Cleanup(pool.Close)

	migs, err := migrate.Load(chalk.Migrations, chalk.MigrationsDir)
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	if _, err := migrate.Run(ctx, pool, migs, func(string, ...any) {}); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	s := &Store{Pool: pool}
	if err := s.EnsureMessagePartitions(ctx, time.Now().UTC()); err != nil {
		t.Fatalf("ensure message partitions: %v", err)
	}
	if err := s.EnsureAttachmentPartitions(ctx, time.Now().UTC()); err != nil {
		t.Fatalf("ensure attachment partitions: %v", err)
	}
	return pool
}

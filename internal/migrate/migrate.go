// Package migrate runs the embedded SQL migrations in order, idempotently.
//
// Migrations live in /migrations as numbered .sql files. They are embedded
// into the chalkd binary and applied at startup (or via `chalkd --migrate-only`,
// added in phase 12). Each migration runs inside its own transaction; a
// schema_migrations table records what's been applied.
//
// Migrations are forward-only. Down migrations are not provided; if a rollback
// is needed, restore from a Postgres snapshot. This is a deliberate choice:
// down migrations are routinely wrong, especially for data-bearing changes,
// and the project doesn't need them.
package migrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tracker is the schema migration ledger.
const trackerSQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT         PRIMARY KEY,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  duration_ms BIGINT       NOT NULL
);
`

// Migration represents a single SQL file to apply.
type Migration struct {
	// Version is the file's numeric prefix (e.g. "0001"). Sortable lexicographically.
	Version string
	// Name is the descriptive part of the filename (e.g. "init").
	Name string
	// SQL is the entire file contents.
	SQL string
}

// FullName returns "version_name", which is what's stored in schema_migrations.
func (m Migration) FullName() string {
	if m.Name == "" {
		return m.Version
	}
	return m.Version + "_" + m.Name
}

// Load parses the supplied filesystem into an ordered slice of migrations.
// Files must be named like "NNNN_description.sql" (e.g. "0001_init.sql").
// Files not matching this pattern are ignored with no error, allowing
// README.md or .gitkeep to live alongside.
//
// fsys is typically the package-level embed.FS exposed by package chalk
// (it satisfies io/fs.FS), but any io/fs.FS works -- handy for unit tests.
func Load(fsys fs.FS, dir string) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations dir %q: %w", dir, err)
	}
	var out []Migration
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		base := strings.TrimSuffix(name, ".sql")
		parts := strings.SplitN(base, "_", 2)
		if len(parts) < 1 || parts[0] == "" {
			continue
		}
		// Reject anything where the prefix isn't all digits; we want strict
		// ordering. A file like "draft_foo.sql" would be ambiguous.
		for _, r := range parts[0] {
			if r < '0' || r > '9' {
				return nil, fmt.Errorf("migration %q: prefix must be numeric", name)
			}
		}
		body, err := fs.ReadFile(fsys, dir+"/"+name)
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", name, err)
		}
		m := Migration{Version: parts[0], SQL: string(body)}
		if len(parts) == 2 {
			m.Name = parts[1]
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Version < out[j].Version
	})
	// Detect duplicate versions early.
	for i := 1; i < len(out); i++ {
		if out[i].Version == out[i-1].Version {
			return nil, fmt.Errorf("duplicate migration version %q", out[i].Version)
		}
	}
	return out, nil
}

// Result describes one applied migration.
type Result struct {
	Migration Migration
	Skipped   bool
	Duration  time.Duration
}

// Run applies all pending migrations against the pool. Already-applied
// migrations are skipped. Application is logged via the supplied logf.
func Run(ctx context.Context, pool *pgxpool.Pool, ms []Migration, logf func(string, ...any)) ([]Result, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}

	// Ensure the tracker exists.
	if _, err := pool.Exec(ctx, trackerSQL); err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	applied, err := loadApplied(ctx, pool)
	if err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(ms))
	for _, m := range ms {
		if _, ok := applied[m.FullName()]; ok {
			logf("migration %s already applied, skipping", m.FullName())
			results = append(results, Result{Migration: m, Skipped: true})
			continue
		}
		start := time.Now()
		if err := applyOne(ctx, pool, m); err != nil {
			return results, fmt.Errorf("apply %s: %w", m.FullName(), err)
		}
		dur := time.Since(start)
		logf("applied migration %s in %s", m.FullName(), dur.Round(time.Millisecond))
		results = append(results, Result{Migration: m, Duration: dur})
	}
	return results, nil
}

// applyOne runs a single migration in a transaction, recording it in the
// tracker. If the migration's SQL contains its own BEGIN/COMMIT (as our
// 0001_init.sql does), pgx is fine with the nesting because it uses
// SAVEPOINTs for nested transactions through Begin().
//
// Subtle: many migration libraries forbid an explicit transaction inside the
// migration file, but our migrations DO use BEGIN/COMMIT for clarity and
// because they may be applied via raw psql during debugging. To support both
// scenarios cleanly we strip a leading "BEGIN;" / trailing "COMMIT;" pair
// before wrapping in our own transaction. This keeps the contract simple:
// "the migration file may or may not contain its own BEGIN/COMMIT; either way
// it will be applied atomically."
func applyOne(ctx context.Context, pool *pgxpool.Pool, m Migration) error {
	sqlText := stripTransactionWrappers(m.SQL)

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	start := time.Now()
	if _, err := tx.Exec(ctx, sqlText); err != nil {
		return err
	}
	dur := time.Since(start)

	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, duration_ms) VALUES ($1, $2)
		   ON CONFLICT (version) DO NOTHING`,
		m.FullName(), dur.Milliseconds(),
	); err != nil {
		return fmt.Errorf("record: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// stripTransactionWrappers removes a single leading BEGIN; and trailing
// COMMIT; if both are present. Whitespace and comments before/after them
// are tolerated. If the file doesn't have wrappers, it's returned unchanged.
//
// We don't try to be clever -- if the file has multiple BEGIN/COMMIT blocks
// or has them in the middle of statements, we leave it alone. The user gets
// the natural pgx error in that case, which is more useful than a silent
// rewrite.
func stripTransactionWrappers(s string) string {
	lines := strings.Split(s, "\n")
	first, last := -1, -1
	for i, line := range lines {
		// Normalize: trim outer whitespace, drop a trailing semicolon (or
		// stacked ";;"), trim again. This handles "BEGIN;", "  BEGIN ; ",
		// "begin ;" and similar permutations -- but not "BEGIN; STMT;" on
		// one line, which is left alone because "BEGIN; STMT" doesn't end
		// in a semicolon and so isn't normalized to "BEGIN".
		t := strings.TrimSpace(line)
		t = strings.TrimRight(t, ";")
		t = strings.TrimSpace(t)
		if first < 0 && strings.EqualFold(t, "BEGIN") {
			first = i
		}
		if strings.EqualFold(t, "COMMIT") {
			last = i
		}
	}
	if first < 0 || last < 0 || last <= first {
		return s
	}
	// Replace those two lines with empty strings; preserves line numbers in
	// any error messages from pgx.
	lines[first] = ""
	lines[last] = ""
	return strings.Join(lines, "\n")
}

func loadApplied(ctx context.Context, pool *pgxpool.Pool) (map[string]struct{}, error) {
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("query schema_migrations: %w", err)
	}
	defer rows.Close()
	m := map[string]struct{}{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		m[v] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return m, nil
}

// ErrNoMigrations is returned when the embedded fs is empty.
var ErrNoMigrations = errors.New("no migrations found")

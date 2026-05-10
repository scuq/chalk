package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PartitionMonths controls how many months ahead we keep partitions
// pre-created. We always keep at least the current month and one ahead so a
// month-boundary race doesn't drop a write. A daily housekeeping loop
// re-runs the create to be defensive against being down at boundary time.
const PartitionMonths = 2

// partitionAdvisoryLock is a stable 64-bit key used with
// pg_advisory_xact_lock to serialize concurrent partition creation across
// chalkd instances. The numeric value itself is arbitrary; it just has to
// be the same value across every chalkd that talks to this database.
//
// (ASCII for "chalkPAR" interpreted as a big-endian int64.)
const partitionAdvisoryLock int64 = 0x6368616c6b504152

// EnsureMessagePartitions creates the messages_YYYY_MM partition for the
// current month and the next PartitionMonths-1 months ahead.
//
// Idempotent: re-runs are no-ops thanks to CREATE TABLE IF NOT EXISTS.
// Safe under concurrency from multiple chalkd instances thanks to an
// advisory transaction lock.
//
// All bounds are UTC. Partitions cover [first-of-month, first-of-next-month).
// This matches `messages.ts DEFAULT now()` on a Postgres instance configured
// with timezone=UTC (the default in every official Postgres docker image
// and what we recommend in deployment.md).
func (s *Store) EnsureMessagePartitions(ctx context.Context, now time.Time) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Serialize concurrent creators across instances.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, partitionAdvisoryLock); err != nil {
			return fmt.Errorf("partition lock: %w", err)
		}

		base := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		for i := 0; i < PartitionMonths; i++ {
			from := base.AddDate(0, i, 0)
			to := from.AddDate(0, 1, 0)
			name := fmt.Sprintf("messages_%04d_%02d", from.Year(), int(from.Month()))

			// DDL can't take placeholders, so bounds are formatted as SQL
			// literals. quoteTimestamp emits 'YYYY-MM-DD HH:MM:SSZ' which
			// Postgres accepts unambiguously for timestamptz.
			ddl := fmt.Sprintf(
				`CREATE TABLE IF NOT EXISTS %s PARTITION OF messages
				   FOR VALUES FROM (%s) TO (%s)`,
				quoteIdent(name),
				quoteTimestamp(from),
				quoteTimestamp(to),
			)
			if _, err := tx.Exec(ctx, ddl); err != nil {
				return fmt.Errorf("create partition %s: %w", name, err)
			}
		}
		return nil
	})
}

// PartitionMaintenanceLoop runs EnsureMessagePartitions once immediately and
// then every interval until ctx is canceled. Errors are logged but do not
// exit the loop; partition creation failures should not bring chalkd down.
//
// Typical use: launched as a goroutine from server startup with a 24-hour
// interval. That gives us 30+ tries before any month boundary.
func (s *Store) PartitionMaintenanceLoop(ctx context.Context, interval time.Duration, logf func(string, ...any)) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if err := s.EnsureMessagePartitions(ctx, time.Now().UTC()); err != nil {
		logf("partition init: %v", err)
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if err := s.EnsureMessagePartitions(ctx, now.UTC()); err != nil {
				logf("partition maintenance: %v", err)
			}
		}
	}
}

// quoteIdent wraps a SQL identifier in double quotes, escaping any embedded
// double quotes. Equivalent to PG's quote_ident().
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// quoteTimestamp formats a time as 'YYYY-MM-DD HH:MM:SSZ' (ISO 8601 with
// explicit Z). Postgres accepts this for timestamptz columns regardless of
// the session's timezone setting.
func quoteTimestamp(t time.Time) string {
	return `'` + t.UTC().Format("2006-01-02 15:04:05Z") + `'`
}

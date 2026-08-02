package chalkctl

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

// 73-1: `chalkctl metrics` -- what the database can tell you about its own
// performance, for free.
//
// Every figure here comes out of Postgres' cumulative statistics views, which
// are in-memory counters the server maintains whether anyone reads them or
// not. Reading them costs a catalog lookup and no table I/O, so this command
// can be run on a busy production host without being part of the problem.
//
// That constraint rules things out, and the exclusions matter more than the
// inclusions:
//
//   - NO `count(*)`. Row counts come from n_live_tup, the planner's estimate.
//     Counting 20 million messages to print one number would be the single
//     most expensive thing this command did.
//   - NO pgstattuple / pg_buffercache. Both give better bloat and cache
//     numbers by reading every page of the table.
//   - NO sum(octet_length(ciphertext)). Attachment volume comes from the
//     partition's on-disk size instead.
//
// Counters are cumulative since the last stats reset, which makes a single
// reading good for "how big / how bloated" and useless for "how busy". That
// is what --sample is for: two readings a few seconds apart, subtracted.

// MetricsOptions configures a metrics run.
type MetricsOptions struct {
	Cfg    Config
	Sample time.Duration // 0 = one-shot; otherwise the window between readings
	Podman *Podman
	Out    io.Writer
}

func (o *MetricsOptions) defaults() {
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
}

// Snapshot is one reading of the database's statistics views.
type Snapshot struct {
	At          time.Time
	DB          dbStats
	Tables      []tableStats
	Activity    activityStats
	Unused      []indexStats
	Checkpoints checkpointStats
	Statements  []statementStats // empty unless pg_stat_statements is installed
	HasStmts    bool
}

type dbStats struct {
	Version        string  `json:"version"`
	VersionNum     int     `json:"version_num"`
	SizeBytes      int64   `json:"db_size"`
	Backends       int     `json:"numbackends"`
	MaxConnections int     `json:"max_connections"`
	Commits        int64   `json:"commits"`
	Rollbacks      int64   `json:"rollbacks"`
	BlksRead       int64   `json:"blks_read"`
	BlksHit        int64   `json:"blks_hit"`
	TempFiles      int64   `json:"temp_files"`
	TempBytes      int64   `json:"temp_bytes"`
	Deadlocks      int64   `json:"deadlocks"`
	StatsReset     *string `json:"stats_reset"`
	IOTiming       string  `json:"io_timing"`
	UptimeSeconds  int64   `json:"uptime_s"`
}

type tableStats struct {
	Name           string  `json:"name"`
	TotalBytes     int64   `json:"total_bytes"`
	IndexBytes     int64   `json:"index_bytes"`
	Live           int64   `json:"live"`
	Dead           int64   `json:"dead"`
	SeqScan        int64   `json:"seq_scan"`
	SeqTupRead     int64   `json:"seq_tup_read"`
	IdxScan        int64   `json:"idx_scan"`
	Ins            int64   `json:"ins"`
	Upd            int64   `json:"upd"`
	Del            int64   `json:"del"`
	LastAutovacuum *string `json:"last_autovacuum"`
}

type activityStats struct {
	States          map[string]int `json:"states"`
	LongestXactSec  int            `json:"longest_xact_s"`
	LongestIdleXact int            `json:"longest_idle_in_xact_s"`
	Waiting         int            `json:"waiting"`
}

type indexStats struct {
	Table string `json:"tbl"`
	Index string `json:"idx"`
	Bytes int64  `json:"bytes"`
}

type checkpointStats struct {
	Timed     int64   `json:"timed"`
	Requested int64   `json:"requested"`
	WriteMS   float64 `json:"write_ms"`
	Buffers   int64   `json:"buffers"`
}

type statementStats struct {
	Calls   int64   `json:"calls"`
	TotalMS float64 `json:"total_ms"`
	MeanMS  float64 `json:"mean_ms"`
	Rows    int64   `json:"rows"`
	Query   string  `json:"query"`
}

// Metrics collects and prints a report. With Sample set it takes two readings
// and reports the difference, which turns cumulative counters into rates.
func Metrics(o MetricsOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}

	first, err := collect(o.Podman)
	if err != nil {
		return err
	}
	if o.Sample <= 0 {
		report(o.Out, o.Cfg, first, nil, 0)
		return nil
	}

	fmt.Fprintf(o.Out, "sampling for %s...\n\n", o.Sample)
	time.Sleep(o.Sample)
	second, err := collect(o.Podman)
	if err != nil {
		return err
	}
	report(o.Out, o.Cfg, second, first, o.Sample)
	return nil
}

// enablePgStatStatements creates the extension once the library is loaded.
// CREATE EXTENSION IF NOT EXISTS is idempotent, so re-running init is safe;
// it fails only if the unit is not actually preloading the library.
func enablePgStatStatements(p *Podman) error {
	if err := waitForPostgres(p, 30*time.Second); err != nil {
		return err
	}
	var buf bytes.Buffer
	return p.ExecOut(&buf, pgContainer, "psql", "-U", "chalk", "-d", "chalk", "-XqtAc",
		"CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
}

// psqlJSON runs one query inside the Postgres container and decodes the single
// JSON value it returns. Every query is written to produce exactly one row of
// one JSON column, which sidesteps parsing psql's tabular output -- and with
// it every question about separators inside a query string.
func psqlJSON(p *Podman, sql string, into any) error {
	var buf bytes.Buffer
	// -X ignores ~/.psqlrc, -tA gives an unaligned, untitled single value.
	if err := p.ExecOut(&buf, pgContainer,
		"psql", "-U", "chalk", "-d", "chalk", "-XtAc", sql); err != nil {
		return err
	}
	out := bytes.TrimSpace(buf.Bytes())
	if len(out) == 0 {
		return fmt.Errorf("empty result for metrics query")
	}
	return json.Unmarshal(out, into)
}

func collect(p *Podman) (*Snapshot, error) {
	s := &Snapshot{At: time.Now().UTC()}
	if err := psqlJSON(p, qDatabase, &s.DB); err != nil {
		return nil, fmt.Errorf("database stats: %w (is chalk-postgres running?)", err)
	}
	if err := psqlJSON(p, qTables, &s.Tables); err != nil {
		return nil, fmt.Errorf("table stats: %w", err)
	}
	if err := psqlJSON(p, qActivity, &s.Activity); err != nil {
		return nil, fmt.Errorf("activity: %w", err)
	}
	if err := psqlJSON(p, qUnusedIndexes, &s.Unused); err != nil {
		return nil, fmt.Errorf("index stats: %w", err)
	}
	// pg_stat_checkpointer replaced these columns in pg_stat_bgwriter in PG17.
	q := qCheckpointsPre17
	if s.DB.VersionNum >= 170000 {
		q = qCheckpoints17
	}
	if err := psqlJSON(p, q, &s.Checkpoints); err != nil {
		return nil, fmt.Errorf("checkpoint stats: %w", err)
	}

	// pg_stat_statements is opt-in (it costs a little on every statement), so
	// its absence is the normal case, not an error.
	if err := psqlJSON(p, qHasStatements, &s.HasStmts); err != nil {
		return nil, fmt.Errorf("extension probe: %w", err)
	}
	if s.HasStmts {
		if err := psqlJSON(p, qStatements, &s.Statements); err != nil {
			return nil, fmt.Errorf("statement stats: %w", err)
		}
	}
	return s, nil
}

const qDatabase = `
SELECT json_build_object(
  -- server_version carries a packaging suffix ("16.13 (Debian ...)"); the
  -- number alone is what belongs in a one-line header.
  'version', split_part(current_setting('server_version'), ' ', 1),
  'version_num', current_setting('server_version_num')::int,
  'db_size', pg_database_size(current_database()),
  'numbackends', d.numbackends,
  'max_connections', current_setting('max_connections')::int,
  'commits', d.xact_commit, 'rollbacks', d.xact_rollback,
  'blks_read', d.blks_read, 'blks_hit', d.blks_hit,
  'temp_files', d.temp_files, 'temp_bytes', d.temp_bytes,
  'deadlocks', d.deadlocks, 'stats_reset', d.stats_reset,
  'io_timing', current_setting('track_io_timing'),
  'uptime_s', extract(epoch from now() - pg_postmaster_start_time())::bigint)
FROM pg_stat_database d WHERE d.datname = current_database()`

const qTables = `
SELECT coalesce(json_agg(t ORDER BY t.total_bytes DESC), '[]') FROM (
  SELECT s.relname AS name,
         pg_total_relation_size(s.relid) AS total_bytes,
         pg_indexes_size(s.relid) AS index_bytes,
         s.n_live_tup AS live, s.n_dead_tup AS dead,
         s.seq_scan, s.seq_tup_read, coalesce(s.idx_scan, 0) AS idx_scan,
         s.n_tup_ins AS ins, s.n_tup_upd AS upd, s.n_tup_del AS del,
         s.last_autovacuum
  FROM pg_stat_user_tables s) t`

const qActivity = `
SELECT json_build_object(
 'states', (SELECT coalesce(json_object_agg(coalesce(state, 'unknown'), n), '{}')
            FROM (SELECT state, count(*) n FROM pg_stat_activity
                  WHERE datname = current_database() GROUP BY state) s),
 'longest_xact_s', (SELECT coalesce(max(extract(epoch from now() - xact_start)), 0)::int
                    FROM pg_stat_activity
                    WHERE datname = current_database() AND xact_start IS NOT NULL),
 'longest_idle_in_xact_s', (SELECT coalesce(max(extract(epoch from now() - state_change)), 0)::int
                    FROM pg_stat_activity
                    WHERE datname = current_database() AND state = 'idle in transaction'),
 'waiting', (SELECT count(*) FROM pg_stat_activity
             WHERE datname = current_database() AND state = 'active'
               AND wait_event_type IS NOT NULL))`

// Constraint-backing indexes are excluded: an index that enforces a primary
// key or a uniqueness rule is not a candidate for dropping however rarely it
// is read, so listing it would be noise the reader has to learn to ignore.
const qUnusedIndexes = `
SELECT coalesce(json_agg(t ORDER BY t.bytes DESC), '[]') FROM (
  SELECT s.relname AS tbl, s.indexrelname AS idx, pg_relation_size(s.indexrelid) AS bytes
  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique) t`

const qCheckpointsPre17 = `
SELECT json_build_object('timed', checkpoints_timed, 'requested', checkpoints_req,
  'write_ms', checkpoint_write_time, 'buffers', buffers_checkpoint) FROM pg_stat_bgwriter`

const qCheckpoints17 = `
SELECT json_build_object('timed', num_timed, 'requested', num_requested,
  'write_ms', write_time, 'buffers', buffers_written) FROM pg_stat_checkpointer`

// to_json, not a bare boolean: psql prints those as t/f, which is not JSON.
const qHasStatements = `
SELECT to_json(count(*) > 0) FROM pg_extension WHERE extname = 'pg_stat_statements'`

const qStatements = `
SELECT coalesce(json_agg(t ORDER BY t.total_ms DESC), '[]') FROM (
  SELECT s.calls, s.total_exec_time AS total_ms, s.mean_exec_time AS mean_ms, s.rows,
         left(regexp_replace(s.query, '\s+', ' ', 'g'), 110) AS query
  FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
  WHERE d.datname = current_database()
  ORDER BY s.total_exec_time DESC LIMIT 10) t`

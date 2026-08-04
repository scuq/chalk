# Phase 73 — chalkctl metrics

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.0.
**Tag:** `#chalkctl` → `tools/where.sh -g chalkctl`

## Why

"The server feels slow" needed an answer that does not require installing a
monitoring stack next to a single-box deployment.

The decision: report **only what Postgres already counts for itself** — its own
statistics views. Nothing is instrumented, nothing is sampled by default, and
asking costs essentially nothing, so it is safe to run on a busy server. That
constrains what can be reported, and the constraint picked the right things:
database size, cache hit ratio, month-by-month growth, and the four symptoms
that actually explain a slow chalk — idle-in-transaction work abandoned by a
connection that walked away, sequential scans on tables that should have an
index, dead-tuple bloat, and lock waits.

Two escapes from "since the server started":

- `--sample 30s` diffs the counters over a window and reports what is happening
  *now*.
- Per-query timings need `pg_stat_statements`, which costs a little on every
  query, so it is opt-in at server setup rather than assumed.

## What landed

- **73-1 / 73-2** — `chalkctl metrics` reading Postgres' statistics views, the
  sampling mode, and the report renderer.

## Where it lives

`internal/chalkctl/metrics.go`, `metrics_report.go`, `config.go`, `render.go`.

package chalkctl

import (
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 73-1: turning the statistics views into a page someone can act on.
//
// The ordering is deliberate: the things that explain a slow server come
// first, and the inventory comes last. Sections with nothing to report print
// nothing at all -- an empty "unused indexes" heading trains the eye to skip
// the section on the day it is not empty.

// cacheRatioMinBlocks is how many block accesses have to have happened before
// the cache hit ratio is worth commenting on -- roughly 800 MiB of 8 KiB
// blocks, well past the cold-start period on any real deployment.
const cacheRatioMinBlocks = 100000

// report writes the human-readable dump. When prev is non-nil, every
// cumulative counter is shown as the difference between the two readings over
// window; gauges (sizes, row counts, connections) always show the later value.
func report(w io.Writer, cfg Config, now, prev *Snapshot, window time.Duration) {
	d := now
	if prev != nil {
		d = delta(prev, now)
	}

	host := cfg.Domain
	if host == "" {
		host = "this host"
	}
	fmt.Fprintf(w, "chalkctl metrics: %s -- %s\n", host, now.At.Format("2006-01-02 15:04:05 MST"))
	fmt.Fprintf(w, "postgres %s, up %s\n", now.DB.Version, humanDuration(time.Duration(now.DB.UptimeSeconds)*time.Second))
	if prev != nil {
		fmt.Fprintf(w, "rates measured over a %s window; sizes and row counts are current\n", window)
	} else {
		fmt.Fprintf(w, "counters are cumulative since %s; run with --sample 30s for rates\n", statsSince(now.DB.StatsReset))
	}

	reportDatabase(w, now, d, window)
	reportActivity(w, now)
	reportPressure(w, now, d, window)
	reportSeqScans(w, d)
	reportBloat(w, now)
	reportUnusedIndexes(w, now)
	reportGrowth(w, now)
	reportTables(w, now)
	reportStatements(w, now, d, window)
}

func reportDatabase(w io.Writer, now, d *Snapshot, window time.Duration) {
	fmt.Fprintf(w, "\ndatabase\n")
	fmt.Fprintf(w, "  size                  %s\n", humanBytes(now.DB.SizeBytes))

	reads := d.DB.BlksRead + d.DB.BlksHit
	if reads > 0 {
		ratio := 100 * float64(d.DB.BlksHit) / float64(reads)
		note := ""
		// Below ~99% means the working set no longer fits in shared_buffers
		// plus the page cache, which shows up as latency long before it shows
		// up as an error. Only worth saying once enough blocks have been read
		// for the ratio to mean anything: a server that started a minute ago
		// has a cold cache by definition, and flagging that is a false alarm
		// that teaches the reader to distrust the line.
		if ratio < 99 && reads > cacheRatioMinBlocks {
			note = "  <- low; the working set may no longer fit in memory"
		}
		fmt.Fprintf(w, "  cache hit ratio       %.2f%%%s\n", ratio, note)
	}

	total := d.DB.Commits + d.DB.Rollbacks
	if total > 0 {
		fmt.Fprintf(w, "  transactions          %s commits, %s rollbacks%s\n",
			humanCount(d.DB.Commits), humanCount(d.DB.Rollbacks), perSecond(total, window))
	}
	if d.DB.Deadlocks > 0 {
		fmt.Fprintf(w, "  deadlocks             %d  <- two writers taking the same rows in opposite orders\n", d.DB.Deadlocks)
	}
	if d.DB.TempFiles > 0 {
		fmt.Fprintf(w, "  temp file spills      %d (%s)  <- queries exceeding work_mem, sorting on disk\n",
			d.DB.TempFiles, humanBytes(d.DB.TempBytes))
	}
	if now.DB.IOTiming != "on" {
		fmt.Fprintf(w, "  io timing             off (set track_io_timing=on to see time spent reading blocks)\n")
	}
}

func reportActivity(w io.Writer, now *Snapshot) {
	fmt.Fprintf(w, "\nconnections\n")
	states := make([]string, 0, len(now.Activity.States))
	for s := range now.Activity.States {
		states = append(states, s)
	}
	sort.Strings(states)
	parts := make([]string, 0, len(states))
	for _, s := range states {
		parts = append(parts, fmt.Sprintf("%d %s", now.Activity.States[s], s))
	}
	fmt.Fprintf(w, "  in use                %d of %d", now.DB.Backends, now.DB.MaxConnections)
	if len(parts) > 0 {
		fmt.Fprintf(w, "  (%s)", strings.Join(parts, ", "))
	}
	fmt.Fprintln(w)
	if now.Activity.LongestXactSec > 5 {
		fmt.Fprintf(w, "  longest transaction   %s\n", humanDuration(time.Duration(now.Activity.LongestXactSec)*time.Second))
	}
	// Idle-in-transaction is the one that hurts: it holds its snapshot, which
	// stops autovacuum reclaiming any row version newer than it anywhere in
	// the database.
	if now.Activity.LongestIdleXact > 30 {
		fmt.Fprintf(w, "  idle in transaction   %s  <- blocks autovacuum database-wide while it sits there\n",
			humanDuration(time.Duration(now.Activity.LongestIdleXact)*time.Second))
	}
	if now.Activity.Waiting > 0 {
		fmt.Fprintf(w, "  waiting on a lock     %d\n", now.Activity.Waiting)
	}
}

func reportPressure(w io.Writer, now, d *Snapshot, window time.Duration) {
	c := d.Checkpoints
	if c.Timed+c.Requested == 0 {
		return
	}
	fmt.Fprintf(w, "\ncheckpoints\n")
	fmt.Fprintf(w, "  timed / requested     %d / %d\n", c.Timed, c.Requested)
	// A "requested" checkpoint is one forced by WAL volume rather than the
	// clock. Mostly-requested means max_wal_size is too small for the write
	// rate, and the resulting I/O bursts are felt as latency spikes.
	if c.Requested > c.Timed && c.Requested > 2 {
		fmt.Fprintf(w, "                        ^ mostly forced by WAL volume; consider raising max_wal_size\n")
	}
}

// reportSeqScans is the "missing index" signal: a table that is big AND is
// being read start-to-finish. Small tables are excluded because a sequential
// scan of a few hundred rows is the correct plan and flagging it would bury
// the case that matters.
func reportSeqScans(w io.Writer, d *Snapshot) {
	const minRowsPerScan = 1000
	type row struct {
		t             tableStats
		rowsPerScan   int64
		seqPercentage float64
	}
	var rows []row
	for _, t := range d.Tables {
		if t.SeqScan == 0 || t.SeqTupRead/max64(t.SeqScan, 1) < minRowsPerScan {
			continue
		}
		share := 100 * float64(t.SeqScan) / float64(t.SeqScan+t.IdxScan)
		rows = append(rows, row{t, t.SeqTupRead / max64(t.SeqScan, 1), share})
	}
	if len(rows) == 0 {
		return
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].t.SeqTupRead > rows[j].t.SeqTupRead })
	fmt.Fprintf(w, "\ntables being read start-to-finish  (candidates for an index)\n")
	fmt.Fprintf(w, "  %-32s %10s %14s %8s\n", "table", "seq scans", "rows/scan", "of reads")
	for i, r := range rows {
		if i == 8 {
			fmt.Fprintf(w, "  ... and %d more\n", len(rows)-i)
			break
		}
		fmt.Fprintf(w, "  %-32s %10s %14s %7.0f%%\n",
			r.t.Name, humanCount(r.t.SeqScan), humanCount(r.rowsPerScan), r.seqPercentage)
	}
}

func reportBloat(w io.Writer, now *Snapshot) {
	type row struct {
		t   tableStats
		pct float64
	}
	var rows []row
	for _, t := range now.Tables {
		if t.Live+t.Dead < 10000 {
			continue // percentages on tiny tables are noise
		}
		pct := 100 * float64(t.Dead) / float64(t.Live+t.Dead)
		if pct >= 20 {
			rows = append(rows, row{t, pct})
		}
	}
	if len(rows) == 0 {
		return
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].pct > rows[j].pct })
	fmt.Fprintf(w, "\ndead rows autovacuum has not reclaimed\n")
	for _, r := range rows {
		last := "never vacuumed"
		if r.t.LastAutovacuum != nil {
			last = "last " + shortTimestamp(*r.t.LastAutovacuum)
		}
		fmt.Fprintf(w, "  %-32s %5.0f%% dead of %s rows  (%s)\n",
			r.t.Name, r.pct, humanCount(r.t.Live+r.t.Dead), last)
	}
}

// reportUnusedIndexes lists indexes that have never been read since the stats
// were reset. Each one is pure cost: every insert and update maintains it, and
// nothing reads it. The caveat is stated inline rather than assumed, because
// acting on a short window would be a mistake.
func reportUnusedIndexes(w io.Writer, now *Snapshot) {
	var total int64
	shown := 0
	for _, ix := range now.Unused {
		if ix.Bytes < 1<<20 {
			continue // sub-megabyte indexes are not worth anyone's attention
		}
		if shown == 0 {
			fmt.Fprintf(w, "\nindexes never read since %s\n", statsSince(now.DB.StatsReset))
		}
		if shown < 8 {
			fmt.Fprintf(w, "  %-32s %10s  on %s\n", ix.Index, humanBytes(ix.Bytes), ix.Table)
		}
		shown++
		total += ix.Bytes
	}
	if shown == 0 {
		return
	}
	if shown > 8 {
		fmt.Fprintf(w, "  ... and %d more\n", shown-8)
	}
	fmt.Fprintf(w, "  %s of index maintained on every write for no reads --\n", humanBytes(total))
	fmt.Fprintf(w, "  but only over the window above; a rarely-used index looks identical to a dead one.\n")
}

func reportGrowth(w io.Writer, now *Snapshot) {
	// messages and attachments are partitioned by month, so the partition
	// sizes ARE the growth curve -- no history to store, no counting to do.
	months := map[string]map[string]int64{}
	for _, t := range now.Tables {
		table, month, ok := partitionMonth(t.Name)
		if !ok {
			continue
		}
		if months[month] == nil {
			months[month] = map[string]int64{}
		}
		months[month][table] += t.TotalBytes
	}
	if len(months) == 0 {
		return
	}
	keys := make([]string, 0, len(months))
	for m := range months {
		keys = append(keys, m)
	}
	sort.Strings(keys)
	fmt.Fprintf(w, "\ngrowth by month  (monthly partitions, on disk)\n")
	fmt.Fprintf(w, "  %-10s %12s %12s\n", "month", "messages", "attachments")
	for _, m := range keys {
		fmt.Fprintf(w, "  %-10s %12s %12s\n", m,
			humanBytes(months[m]["messages"]), humanBytes(months[m]["attachments"]))
	}
}

func reportTables(w io.Writer, now *Snapshot) {
	if len(now.Tables) == 0 {
		return
	}
	fmt.Fprintf(w, "\nlargest tables\n")
	fmt.Fprintf(w, "  %-32s %10s %10s %10s\n", "table", "total", "indexes", "rows (est)")
	for i, t := range now.Tables {
		if i == 10 {
			break
		}
		fmt.Fprintf(w, "  %-32s %10s %10s %10s\n",
			t.Name, humanBytes(t.TotalBytes), humanBytes(t.IndexBytes), humanCount(t.Live))
	}
}

func reportStatements(w io.Writer, now, d *Snapshot, window time.Duration) {
	if !now.HasStmts {
		fmt.Fprintf(w, "\nper-query timings are not collected on this host.\n")
		fmt.Fprintf(w, "  enable them with: chalkctl init --force --pg-stat-statements  (restarts postgres)\n")
		return
	}
	if len(d.Statements) == 0 {
		return
	}
	fmt.Fprintf(w, "\nqueries by total time\n")
	fmt.Fprintf(w, "  %10s %10s %10s  %s\n", "total", "calls", "mean", "query")
	for i, s := range d.Statements {
		if i == 8 {
			break
		}
		fmt.Fprintf(w, "  %10s %10s %8.1fms  %s\n",
			humanDuration(time.Duration(s.TotalMS)*time.Millisecond), humanCount(s.Calls), s.MeanMS, s.Query)
	}
}

// delta subtracts the earlier reading's counters from the later one's, leaving
// gauges alone. Tables and statements are matched by name; anything that
// appears only in the later reading is carried through as-is.
func delta(prev, now *Snapshot) *Snapshot {
	out := *now
	out.DB.Commits -= prev.DB.Commits
	out.DB.Rollbacks -= prev.DB.Rollbacks
	out.DB.BlksRead -= prev.DB.BlksRead
	out.DB.BlksHit -= prev.DB.BlksHit
	out.DB.TempFiles -= prev.DB.TempFiles
	out.DB.TempBytes -= prev.DB.TempBytes
	out.DB.Deadlocks -= prev.DB.Deadlocks
	out.Checkpoints.Timed -= prev.Checkpoints.Timed
	out.Checkpoints.Requested -= prev.Checkpoints.Requested
	out.Checkpoints.Buffers -= prev.Checkpoints.Buffers
	out.Checkpoints.WriteMS -= prev.Checkpoints.WriteMS

	before := make(map[string]tableStats, len(prev.Tables))
	for _, t := range prev.Tables {
		before[t.Name] = t
	}
	out.Tables = make([]tableStats, len(now.Tables))
	for i, t := range now.Tables {
		if b, ok := before[t.Name]; ok {
			t.SeqScan -= b.SeqScan
			t.SeqTupRead -= b.SeqTupRead
			t.IdxScan -= b.IdxScan
			t.Ins -= b.Ins
			t.Upd -= b.Upd
			t.Del -= b.Del
		}
		out.Tables[i] = t
	}

	stmts := make(map[string]statementStats, len(prev.Statements))
	for _, s := range prev.Statements {
		stmts[s.Query] = s
	}
	out.Statements = nil
	for _, s := range now.Statements {
		if b, ok := stmts[s.Query]; ok {
			s.Calls -= b.Calls
			s.TotalMS -= b.TotalMS
		}
		if s.Calls > 0 {
			out.Statements = append(out.Statements, s)
		}
	}
	sort.Slice(out.Statements, func(i, j int) bool {
		return out.Statements[i].TotalMS > out.Statements[j].TotalMS
	})
	return &out
}

var partitionRe = regexp.MustCompile(`^(messages|attachments)_(\d{4})_(\d{2})$`)

// partitionMonth splits "messages_2026_08" into its table and "2026-08".
func partitionMonth(name string) (table, month string, ok bool) {
	m := partitionRe.FindStringSubmatch(name)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2] + "-" + m[3], true
}

func statsSince(reset *string) string {
	if reset == nil || *reset == "" {
		return "the server last started (never reset)"
	}
	return shortTimestamp(*reset)
}

// shortTimestamp trims a Postgres timestamptz to minute precision.
func shortTimestamp(ts string) string {
	if t, err := time.Parse(time.RFC3339, strings.Replace(ts, " ", "T", 1)); err == nil {
		return t.Format("2006-01-02 15:04")
	}
	if len(ts) >= 16 {
		return ts[:16]
	}
	return ts
}

func perSecond(n int64, window time.Duration) string {
	if window <= 0 || n <= 0 {
		return ""
	}
	return fmt.Sprintf("  (%.0f/s)", float64(n)/window.Seconds())
}

func humanCount(n int64) string {
	switch {
	case n < 0:
		return "0"
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 1000000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	case n < 1000000000:
		return fmt.Sprintf("%.1fM", float64(n)/1000000)
	}
	return fmt.Sprintf("%.1fB", float64(n)/1000000000)
}

func humanDuration(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%d days", int(d.Hours()/24))
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

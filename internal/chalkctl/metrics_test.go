package chalkctl

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// devPGContainer is the dev Postgres from CLAUDE.md's command list. The live
// tests below skip when it is not running, so `go test ./...` from a fresh
// checkout still passes.
func devPGContainer() string {
	if c := os.Getenv("CHALK_TEST_PG_CONTAINER"); c != "" {
		return c
	}
	return "chalk-dev-pg"
}

// runQuery executes one of the q* constants against a real Postgres and
// returns its raw output.
func runQuery(t *testing.T, sql string) []byte {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available; skipping live metrics query test")
	}
	cmd := exec.Command("docker", "exec", "-i", devPGContainer(),
		"psql", "-U", "chalk", "-d", "chalk", "-XtAc", sql)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		if strings.Contains(errBuf.String(), "No such container") {
			t.Skipf("%s is not running; skipping live metrics query test", devPGContainer())
		}
		t.Fatalf("query failed: %v\n%s\nSQL: %s", err, errBuf.String(), sql)
	}
	return bytes.TrimSpace(out.Bytes())
}

// Each query must produce exactly one JSON value that unmarshals into the
// struct it feeds. This is the SELECT/scan three-site rule in its metrics
// form: the SQL, the JSON keys and the struct tags all have to agree, and
// `go build` proves none of it.
func TestMetricsQueriesMatchTheirStructs(t *testing.T) {
	var db dbStats
	if err := json.Unmarshal(runQuery(t, qDatabase), &db); err != nil {
		t.Fatalf("qDatabase: %v", err)
	}
	if db.VersionNum == 0 || db.SizeBytes == 0 || db.MaxConnections == 0 {
		t.Errorf("qDatabase returned zero values, so a key does not match a tag: %+v", db)
	}

	var tables []tableStats
	if err := json.Unmarshal(runQuery(t, qTables), &tables); err != nil {
		t.Fatalf("qTables: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("qTables returned nothing; the dev database has no user tables?")
	}
	var named, sized int
	for _, tb := range tables {
		if tb.Name != "" {
			named++
		}
		if tb.TotalBytes > 0 {
			sized++
		}
	}
	if named != len(tables) || sized == 0 {
		t.Errorf("qTables keys do not match the struct tags (%d/%d named, %d sized)", named, len(tables), sized)
	}

	var act activityStats
	if err := json.Unmarshal(runQuery(t, qActivity), &act); err != nil {
		t.Fatalf("qActivity: %v", err)
	}
	if len(act.States) == 0 {
		t.Error("qActivity found no connections, but this query is one")
	}

	var unused []indexStats
	if err := json.Unmarshal(runQuery(t, qUnusedIndexes), &unused); err != nil {
		t.Fatalf("qUnusedIndexes: %v", err)
	}

	var hasStmts bool
	if err := json.Unmarshal(runQuery(t, qHasStatements), &hasStmts); err != nil {
		t.Fatalf("qHasStatements: %v", err)
	}

	// The checkpoint columns moved between major versions; whichever branch
	// applies to the server under test must be the one that parses.
	q := qCheckpointsPre17
	if db.VersionNum >= 170000 {
		q = qCheckpoints17
	}
	var cp checkpointStats
	if err := json.Unmarshal(runQuery(t, q), &cp); err != nil {
		t.Fatalf("checkpoints (server %d): %v", db.VersionNum, err)
	}
	if cp.Timed == 0 && cp.Requested == 0 {
		t.Logf("no checkpoints recorded yet on server %d", db.VersionNum)
	}
}

// The metrics command must never do anything that costs real I/O -- that is
// the whole premise of running it on a busy host.
func TestMetricsQueriesAreCheap(t *testing.T) {
	all := map[string]string{
		"qDatabase": qDatabase, "qTables": qTables, "qActivity": qActivity,
		"qUnusedIndexes": qUnusedIndexes, "qCheckpointsPre17": qCheckpointsPre17,
		"qCheckpoints17": qCheckpoints17, "qHasStatements": qHasStatements,
		"qStatements": qStatements,
	}
	// count(*) over a chalk table, pgstattuple and octet_length sums all read
	// every page. count(*) over a catalog or pg_stat_activity is fine, so the
	// check is for scans of the application's own tables.
	banned := []string{"pgstattuple", "pg_buffercache", "octet_length", "FROM messages", "FROM attachments"}
	for name, sql := range all {
		for _, b := range banned {
			if strings.Contains(sql, b) {
				t.Errorf("%s contains %q, which reads table data -- metrics must stay free", name, b)
			}
		}
	}
}

// Live end-to-end: real statistics through the real formatter. Catches the
// formatting faults fixtures cannot, like a column that only misaligns once a
// table name is long or a counter is large.
func TestMetricsReportAgainstLiveDatabase(t *testing.T) {
	var snap Snapshot
	if err := json.Unmarshal(runQuery(t, qDatabase), &snap.DB); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(runQuery(t, qTables), &snap.Tables); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(runQuery(t, qActivity), &snap.Activity); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(runQuery(t, qUnusedIndexes), &snap.Unused); err != nil {
		t.Fatal(err)
	}
	snap.At = time.Now().UTC()

	var buf bytes.Buffer
	report(&buf, Config{Domain: "chat.example.org"}, &snap, nil, 0)
	out := buf.String()
	for _, want := range []string{"chalkctl metrics:", "database", "size", "connections", "largest tables"} {
		if !strings.Contains(out, want) {
			t.Errorf("report is missing %q:\n%s", want, out)
		}
	}
	t.Logf("live report:\n%s", out)
}

func TestPartitionMonth(t *testing.T) {
	cases := []struct{ in, table, month string }{
		{"messages_2026_08", "messages", "2026-08"},
		{"attachments_2026_12", "attachments", "2026-12"},
	}
	for _, c := range cases {
		tbl, m, ok := partitionMonth(c.in)
		if !ok || tbl != c.table || m != c.month {
			t.Errorf("partitionMonth(%q) = %q,%q,%v", c.in, tbl, m, ok)
		}
	}
	for _, bad := range []string{"messages", "users", "attachment_chunks", "messages_2026", "messages_2026_8"} {
		if _, _, ok := partitionMonth(bad); ok {
			t.Errorf("partitionMonth(%q) matched, but it is not a monthly partition", bad)
		}
	}
}

// --sample subtracts counters and leaves gauges alone. Getting that backwards
// would report a database that shrank to nothing, or rates equal to lifetime
// totals -- both plausible-looking and both wrong.
func TestDeltaSubtractsCountersNotGauges(t *testing.T) {
	prev := &Snapshot{
		DB:     dbStats{Commits: 1000, BlksHit: 500, BlksRead: 10, SizeBytes: 900, Backends: 3},
		Tables: []tableStats{{Name: "messages_2026_08", SeqScan: 5, IdxScan: 100, Live: 400, TotalBytes: 111}},
	}
	now := &Snapshot{
		DB:     dbStats{Commits: 1200, BlksHit: 800, BlksRead: 12, SizeBytes: 1000, Backends: 4},
		Tables: []tableStats{{Name: "messages_2026_08", SeqScan: 9, IdxScan: 130, Live: 550, TotalBytes: 222}},
	}
	d := delta(prev, now)

	if d.DB.Commits != 200 || d.DB.BlksHit != 300 || d.DB.BlksRead != 2 {
		t.Errorf("counters not subtracted: %+v", d.DB)
	}
	if d.DB.SizeBytes != 1000 || d.DB.Backends != 4 {
		t.Errorf("gauges must show the later reading, got size=%d backends=%d", d.DB.SizeBytes, d.DB.Backends)
	}
	if d.Tables[0].SeqScan != 4 || d.Tables[0].IdxScan != 30 {
		t.Errorf("table counters not subtracted: %+v", d.Tables[0])
	}
	if d.Tables[0].Live != 550 || d.Tables[0].TotalBytes != 222 {
		t.Errorf("table gauges must show the later reading: %+v", d.Tables[0])
	}
}

// A table that appears only in the later reading (a partition created between
// the two) must carry through whole rather than being dropped or negated.
func TestDeltaKeepsTablesNewInTheSecondReading(t *testing.T) {
	prev := &Snapshot{Tables: []tableStats{{Name: "messages_2026_08", SeqScan: 5}}}
	now := &Snapshot{Tables: []tableStats{
		{Name: "messages_2026_08", SeqScan: 7},
		{Name: "messages_2026_09", SeqScan: 3},
	}}
	d := delta(prev, now)
	if len(d.Tables) != 2 {
		t.Fatalf("expected both tables, got %d", len(d.Tables))
	}
	if d.Tables[1].SeqScan != 3 {
		t.Errorf("a table new in the second reading should keep its own counter, got %d", d.Tables[1].SeqScan)
	}
}

func TestReportFlagsLowCacheHitRatio(t *testing.T) {
	const warning = "may no longer fit in memory"
	base := dbStats{Version: "18.0", SizeBytes: 1 << 30, MaxConnections: 100}

	low := base
	low.BlksHit, low.BlksRead = 900000, 100000 // 90%, well past the materiality floor
	var buf bytes.Buffer
	report(&buf, Config{Domain: "x"}, &Snapshot{DB: low}, nil, 0)
	if !strings.Contains(buf.String(), warning) {
		t.Errorf("a 90%% cache hit ratio must be called out:\n%s", buf.String())
	}

	high := base
	high.BlksHit, high.BlksRead = 9999000, 1000 // 99.99%
	buf.Reset()
	report(&buf, Config{Domain: "x"}, &Snapshot{DB: high}, nil, 0)
	if strings.Contains(buf.String(), warning) {
		t.Errorf("a 99.99%% ratio must not be flagged:\n%s", buf.String())
	}

	// A server that started a minute ago has a cold cache by definition.
	// Flagging that is a false alarm, and false alarms are how a reader learns
	// to ignore the line that matters.
	cold := base
	cold.BlksHit, cold.BlksRead = 900, 100 // also 90%, but on 1000 blocks
	buf.Reset()
	report(&buf, Config{Domain: "x"}, &Snapshot{DB: cold}, nil, 0)
	if strings.Contains(buf.String(), warning) {
		t.Errorf("a cold cache on a just-started server must not be flagged:\n%s", buf.String())
	}
}

// A sequential scan of a small table is the right plan; flagging it would bury
// the big-table case that actually needs an index.
func TestReportSeqScanIgnoresSmallTables(t *testing.T) {
	s := &Snapshot{
		DB: dbStats{Version: "18.0", MaxConnections: 100},
		Tables: []tableStats{
			{Name: "instances", SeqScan: 5000, SeqTupRead: 15000, IdxScan: 0},           // 3 rows/scan
			{Name: "messages_2026_08", SeqScan: 40, SeqTupRead: 8000000, IdxScan: 1000}, // 200k rows/scan
		},
	}
	var buf bytes.Buffer
	report(&buf, Config{Domain: "x"}, s, nil, 0)
	out := buf.String()
	if !strings.Contains(out, "messages_2026_08") || !strings.Contains(out, "start-to-finish") {
		t.Errorf("a table read 200k rows at a time must be flagged:\n%s", out)
	}
	seq := out[strings.Index(out, "start-to-finish"):]
	if strings.Contains(seq[:strings.Index(seq+"\n\n", "\n\n")], "instances") {
		t.Errorf("a 3-row table must not be flagged as needing an index:\n%s", out)
	}
}

func TestReportTellsYouHowToGetQueryTimings(t *testing.T) {
	s := &Snapshot{DB: dbStats{Version: "18.0", MaxConnections: 100}, HasStmts: false}
	var buf bytes.Buffer
	report(&buf, Config{Domain: "x"}, s, nil, 0)
	if !strings.Contains(buf.String(), "--pg-stat-statements") {
		t.Errorf("when timings are off, the report must say how to turn them on:\n%s", buf.String())
	}
}

func TestHumanCountAndDuration(t *testing.T) {
	counts := map[int64]string{0: "0", 999: "999", 1500: "1.5k", 2500000: "2.5M", 3200000000: "3.2B"}
	for in, want := range counts {
		if got := humanCount(in); got != want {
			t.Errorf("humanCount(%d) = %q, want %q", in, got, want)
		}
	}
	durs := map[time.Duration]string{
		500 * time.Millisecond: "500ms",
		90 * time.Second:       "1m",
		3 * time.Hour:          "3h",
		72 * time.Hour:         "3 days",
	}
	for in, want := range durs {
		if got := humanDuration(in); got != want {
			t.Errorf("humanDuration(%s) = %q, want %q", in, got, want)
		}
	}
}

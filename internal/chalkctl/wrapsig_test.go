package chalkctl

// 82-9: readiness for CHALK_WRAP_SIG_REQUIRED=true.
//
// The verdict is deliberately split from the psql call so it can be asserted
// without a database. What is NOT covered here is the SQL itself, which needs
// a live Postgres -- the queries are asserted for shape (see
// TestWrapSigQueriesScopeToLiveCurrentVersions) and exercised for real by the
// end-to-end run in docs/PHASE-82-SIGNEDWRAP.md.

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestWrapSigReadyVerdict(t *testing.T) {
	cases := []struct {
		name string
		r    WrapSigReport
		want bool
	}{
		{
			name: "nothing unsigned is ready",
			r:    WrapSigReport{Totals: wrapSigTotals{UnsignedWraps: 0, TotalWraps: 40, Channels: 9}},
			want: true,
		},
		{
			name: "a single unsigned wrap blocks",
			r:    WrapSigReport{Totals: wrapSigTotals{UnsignedWraps: 1, TotalWraps: 40}},
			want: false,
		},
		{
			// An empty deployment has nothing to strand. Reporting "not ready"
			// for a server with no channels would be a permanent false blocker.
			name: "an empty deployment is ready",
			r:    WrapSigReport{Totals: wrapSigTotals{}},
			want: true,
		},
		{
			// Guest links are not gated: the redeem path copies an already-parked
			// wrap rather than minting a new one, so an outstanding unsigned link
			// keeps working after the flip and must not hold the operator back.
			name: "outstanding unsigned guest links do not block",
			r: WrapSigReport{
				Totals:         wrapSigTotals{UnsignedWraps: 0, TotalWraps: 12},
				UnsignedGuests: 5,
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.r.Ready(); got != tc.want {
				t.Errorf("Ready() = %v, want %v", got, tc.want)
			}
		})
	}
}

// The two scoping decisions that make the verdict meaningful rather than
// permanently red. Asserted against the query text because a live Postgres is
// not available here, and a silent drift in either would produce a command
// that always says "not ready" -- which an operator would learn to ignore.
func TestWrapSigQueriesScopeToLiveCurrentVersions(t *testing.T) {
	for _, q := range []struct{ name, sql string }{
		{"totals", qWrapSigTotals},
		{"lagging", qWrapSigLagging},
	} {
		// Only the channel's CURRENT key version: clients never re-fetch an
		// old version's wrap, so an unsigned one there can block nobody.
		if !strings.Contains(q.sql, "k.key_version = c.current_key_version") {
			t.Errorf("%s query must scope to the current key version:\n%s", q.name, q.sql)
		}
		// Expired channels are pending hard-deletion by chalkd's janitor.
		if !strings.Contains(q.sql, "c.expires_at IS NULL OR c.expires_at > now()") {
			t.Errorf("%s query must exclude expired channels:\n%s", q.name, q.sql)
		}
		// "Unsigned" is suite < 2 -- the property is "does the suite
		// authenticate its producer", not an ordering accident.
		if !strings.Contains(q.sql, "k.wrap_suite < 2") {
			t.Errorf("%s query must count suite < 2 as unsigned:\n%s", q.name, q.sql)
		}
	}
}

// Every table alias a query dereferences must be one it actually declares.
// `go build` proves nothing about SQL, and the lagging query shipped selecting
// u.handle with no users join -- valid Go, "missing FROM-clause entry for
// table u" the first time an operator ran it against a real deployment.
func TestWrapSigQueriesDeclareEveryAlias(t *testing.T) {
	for _, q := range []struct{ name, sql string }{
		{"totals", qWrapSigTotals},
		{"lagging", qWrapSigLagging},
		{"invites", qWrapSigInvites},
	} {
		if bad := undeclaredAliases(q.sql); len(bad) > 0 {
			t.Errorf("%s query references alias(es) %v it never joins:\n%s", q.name, bad, q.sql)
		}
	}

	// The query as it shipped, so the check above cannot quietly stop checking.
	broken := `SELECT array_agg(u.handle) FROM channels c
	  JOIN channel_keys k ON k.channel_id = c.id;`
	if bad := undeclaredAliases(broken); len(bad) != 1 || bad[0] != "u" {
		t.Errorf("undeclaredAliases missed the shipped bug: got %v, want [u]", bad)
	}
}

var (
	sqlDeclaredAlias = regexp.MustCompile(`(?i)(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)`)
	sqlUsedAlias     = regexp.MustCompile(`\b(\w+)\.\w+`)
	// The subquery wrappers close with `) t` / `) r`, declared by no FROM/JOIN.
	sqlClosingAlias = regexp.MustCompile(`\)\s*(\w+)\s*;?\s*$`)
)

func undeclaredAliases(sql string) []string {
	have := map[string]bool{}
	for _, m := range sqlDeclaredAlias.FindAllStringSubmatch(sql, -1) {
		have[strings.ToLower(m[2])] = true
	}
	for _, line := range strings.Split(sql, "\n") {
		if m := sqlClosingAlias.FindStringSubmatch(line); m != nil {
			have[strings.ToLower(m[1])] = true
		}
	}
	var bad []string
	seen := map[string]bool{}
	for _, m := range sqlUsedAlias.FindAllStringSubmatch(sql, -1) {
		alias := strings.ToLower(m[1])
		if !have[alias] && !seen[alias] {
			seen[alias] = true
			bad = append(bad, alias)
		}
	}
	return bad
}

func TestCurrentWrapSigSetting(t *testing.T) {
	dir := t.TempDir()
	write := func(body string) string {
		p := filepath.Join(dir, "chalk.env")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	// Absent must not read as a plain "false": an env file that predates 82-6
	// simply has not been backfilled by `chalkctl update` yet, and telling the
	// operator those are the same thing hides a missing upgrade step.
	if got := currentWrapSigSetting(write("CHALK_PG_PASSWORD=x\n")); got != "false (unset)" {
		t.Errorf("absent = %q, want %q", got, "false (unset)")
	}
	if got := currentWrapSigSetting(write("CHALK_WRAP_SIG_REQUIRED=false\n")); got != "false" {
		t.Errorf("explicit false = %q", got)
	}
	if got := currentWrapSigSetting(write("CHALK_WRAP_SIG_REQUIRED=true\n")); got != "true" {
		t.Errorf("true = %q", got)
	}
	if got := currentWrapSigSetting(filepath.Join(dir, "nope.env")); !strings.HasPrefix(got, "unknown") {
		t.Errorf("missing file = %q, want an 'unknown' answer", got)
	}
}

// enable/disable write both files and restart. The restart matters: the flag
// is read at boot, so skipping it would leave the operator believing
// enforcement is on while chalkd is still accepting unsigned wraps.
func TestWrapSigSetWritesBothFilesAndRestarts(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	cfgPath := filepath.Join(dir, "chalkctl.conf")
	if err := os.WriteFile(envPath, []byte("CHALK_WRAP_SIG_REQUIRED=false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte("WRAP_SIG_REQUIRED=false\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	restarted := 0
	var out bytes.Buffer
	o := WrapSigOptions{
		EnvPath:    envPath,
		ConfigPath: cfgPath,
		Out:        &out,
		Restart:    func() error { restarted++; return nil },
	}
	o.defaults()

	if err := setWrapSig(o, "true"); err != nil {
		t.Fatalf("setWrapSig: %v", err)
	}
	if restarted != 1 {
		t.Errorf("restarts = %d, want 1", restarted)
	}
	if got := currentWrapSigSetting(envPath); got != "true" {
		t.Errorf("env after enable = %q", got)
	}
	cfg, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cfg), "WRAP_SIG_REQUIRED=true") {
		t.Errorf("config not updated, so a later `init --force` would revert the choice:\n%s", cfg)
	}

	// And back off again -- the way out if enabling stranded someone.
	if err := setWrapSig(o, "false"); err != nil {
		t.Fatalf("setWrapSig off: %v", err)
	}
	if got := currentWrapSigSetting(envPath); got != "false" {
		t.Errorf("env after disable = %q", got)
	}

	// The operator has to be able to tell, from the output alone, that the
	// restart happened -- the flag is read at boot, so "wrote the file" is not
	// the same as "it is in force".
	if !strings.Contains(out.String(), "restarted chalkd") {
		t.Errorf("output must report the restart:\n%s", out.String())
	}
}

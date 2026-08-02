package integration

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/scuq/chalk/internal/chalkctl"
)

// 72-4: the half of `chalkctl restore` that go build proves nothing about.
//
// The archive format is covered by unit tests; what needs a real Postgres is
// whether a chalk dump taken with chalkctl.PGDumpArgs actually loads back
// through chalkctl.RestoreWipeSQL + chalkctl.PSQLLoadArgs -- extensions,
// partitioned tables, the schema_migrations rows chalkd reads on boot, and the
// all-or-nothing guarantee a failed restore depends on.
//
// It drives psql/pg_dump directly rather than through podman: the SQL is the
// subject, the container is not.

func pgTool(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH; skipping dump/restore integration test", name)
	}
	return path
}

// scratchDBURL creates an empty database beside the test one and returns its
// URL, dropping it on cleanup.
func scratchDBURL(t *testing.T, src string) string {
	t.Helper()
	u, err := url.Parse(src)
	if err != nil {
		t.Fatalf("parse CHALK_TEST_PGURL: %v", err)
	}
	name := "chalk_restore_probe"

	admin := *u
	admin.Path = "/postgres"
	run := func(sql string) {
		t.Helper()
		cmd := exec.Command("psql", admin.String(), "-qtAc", sql)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("psql %q: %v\n%s", sql, err, out)
		}
	}
	run("DROP DATABASE IF EXISTS " + name)
	run("CREATE DATABASE " + name)
	t.Cleanup(func() {
		cmd := exec.Command("psql", admin.String(), "-qtAc", "DROP DATABASE IF EXISTS "+name)
		_ = cmd.Run()
	})

	dst := *u
	dst.Path = "/" + name
	return dst.String()
}

func scalar(t *testing.T, dbURL, sql string) string {
	t.Helper()
	out, err := exec.Command("psql", dbURL, "-tAc", sql).CombinedOutput()
	if err != nil {
		t.Fatalf("psql %q: %v\n%s", sql, err, out)
	}
	return strings.TrimSpace(string(out))
}

// loadDump feeds RestoreWipeSQL + the dump into psql exactly as Restore does.
func loadDump(dbURL string, dump []byte) ([]byte, error) {
	args := append([]string{dbURL}, chalkctl.PSQLLoadArgs...)
	cmd := exec.CommandContext(context.Background(), "psql", args...)
	cmd.Stdin = bytes.NewReader(append([]byte(chalkctl.RestoreWipeSQL), dump...))
	return cmd.CombinedOutput()
}

func TestDumpRestoreRoundTrip(t *testing.T) {
	src := dbURL(t)
	pgTool(t, "pg_dump")
	pgTool(t, "psql")

	dumpPath := filepath.Join(t.TempDir(), "db.sql")
	f, err := os.Create(dumpPath)
	if err != nil {
		t.Fatal(err)
	}
	dumpArgs := append([]string{src}, chalkctl.PGDumpArgs...)
	cmd := exec.Command("pg_dump", dumpArgs...)
	cmd.Stdout = f
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		f.Close()
		t.Fatalf("pg_dump: %v\n%s", err, errBuf.String())
	}
	f.Close()
	dump, err := os.ReadFile(dumpPath)
	if err != nil {
		t.Fatal(err)
	}

	dst := scratchDBURL(t, src)
	if out, err := loadDump(dst, dump); err != nil {
		t.Fatalf("load into empty database: %v\n%s", err, out)
	}

	// chalkd reads schema_migrations on boot to decide what to apply; a
	// restore that loses those rows makes it re-run migrations against a
	// schema that already has them.
	const tableCount = `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`
	for _, probe := range []struct{ what, sql string }{
		{"tables", tableCount},
		{"migrations", `SELECT count(*) FROM schema_migrations`},
		{"users", `SELECT count(*) FROM users`},
		{"extensions", `SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension`},
	} {
		want, got := scalar(t, src, probe.sql), scalar(t, dst, probe.sql)
		if want != got {
			t.Errorf("%s after restore = %q, source has %q", probe.what, got, want)
		}
	}

	// The real restore target is not empty: init has already run chalkd once,
	// so the schema exists. Loading again must simply replace it.
	if out, err := loadDump(dst, dump); err != nil {
		t.Fatalf("reload over a populated schema: %v\n%s", err, out)
	}
	if want, got := scalar(t, src, tableCount), scalar(t, dst, tableCount); want != got {
		t.Errorf("tables after reload = %q, want %q", got, want)
	}

	// A failed load must leave the database untouched -- the operator's way
	// back from a corrupt archive is that the old data is still there.
	before := scalar(t, dst, tableCount)
	if out, err := loadDump(dst, []byte("SELECT this_column_does_not_exist;\n")); err == nil {
		t.Fatalf("a bogus dump loaded without error:\n%s", out)
	}
	if after := scalar(t, dst, tableCount); after != before {
		t.Errorf("failed load left %s tables, want the original %s -- the load is not atomic", after, before)
	}
}

func TestRestoreWipeSQLDropsTheSchema(t *testing.T) {
	// Guards the two statements themselves: a restore that only dropped
	// tables would leave functions, types and extensions from a newer schema
	// behind, which is precisely what the dump cannot then recreate.
	for _, want := range []string{"DROP SCHEMA", "CASCADE", "CREATE SCHEMA public"} {
		if !strings.Contains(chalkctl.RestoreWipeSQL, want) {
			t.Errorf("RestoreWipeSQL is missing %q: %s", want, chalkctl.RestoreWipeSQL)
		}
	}
	if !strings.Contains(fmt.Sprint(chalkctl.PSQLLoadArgs), "--single-transaction") {
		t.Errorf("PSQLLoadArgs must keep --single-transaction: %v", chalkctl.PSQLLoadArgs)
	}
}

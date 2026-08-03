package chalkctl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRolesSQL(t *testing.T) {
	sql := rolesSQL("app-pw", "guest-pw")
	for _, want := range []string{
		"CREATE ROLE chalk_app",
		"CREATE ROLE chalk_guest",
		"ALTER ROLE chalk_app LOGIN PASSWORD 'app-pw'",
		"ALTER ROLE chalk_guest LOGIN PASSWORD 'guest-pw'",
		// Membership is what lets chalkd (as chalk_app) run migrations and
		// partition DDL against owner-created tables. chalk_guest must NOT
		// get it -- the RLS fence depends on chalk_guest not being an owner.
		"GRANT chalk TO chalk_app",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("rolesSQL missing %q:\n%s", want, sql)
		}
	}
	if strings.Contains(sql, "GRANT chalk TO chalk_guest") {
		t.Error("chalk_guest must never be a member of the owner role")
	}
}

func TestPGQuoteLiteral(t *testing.T) {
	if got := pgQuoteLiteral("plain"); got != "'plain'" {
		t.Errorf("plain: got %s", got)
	}
	if got := pgQuoteLiteral("o'brien"); got != "'o''brien'" {
		t.Errorf("quote doubling: got %s", got)
	}
}

func TestRewriteDBURLUser(t *testing.T) {
	got, err := rewriteDBURLUser(
		"postgres://chalk:oldpw@postgres:5432/chalk?sslmode=disable", "chalk_app", "newpw")
	if err != nil {
		t.Fatal(err)
	}
	want := "postgres://chalk_app:newpw@postgres:5432/chalk?sslmode=disable"
	if got != want {
		t.Errorf("got %s, want %s", got, want)
	}

	// A customized host/db/options must survive the repoint.
	got, err = rewriteDBURLUser(
		"postgres://chalk:pw@db.internal:5433/chalkprod?sslmode=require", "chalk_guest", "gpw")
	if err != nil {
		t.Fatal(err)
	}
	if got != "postgres://chalk_guest:gpw@db.internal:5433/chalkprod?sslmode=require" {
		t.Errorf("customized URL mangled: %s", got)
	}

	if _, err := rewriteDBURLUser("not a url at all%%", "u", "p"); err == nil {
		t.Error("garbage URL should error")
	}
}

// TestEnsureDBRolesEnvBackfill exercises the update/restore upgrade path
// against a pre-phase-80 env file. Podman.Bin is stubbed with `true`, so the
// pg_isready wait and the psql exec both no-op successfully -- the assertions
// are about what lands in the env file.
func TestEnsureDBRolesEnvBackfill(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), "chalk.env")
	orig := "# header\nCHALK_PG_PASSWORD=ownerpw\nCHALK_DB_URL=postgres://chalk:ownerpw@postgres:5432/chalk?sslmode=disable\n"
	if err := os.WriteFile(envPath, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Podman{Bin: "true"}

	appPw, guestPw, err := ensureDBRolesEnv(envPath, p, os.Stderr)
	if err != nil {
		t.Fatal(err)
	}
	if appPw == "" || guestPw == "" || appPw == guestPw {
		t.Fatalf("bad generated passwords: app=%q guest=%q", appPw, guestPw)
	}

	got, err := readEnvSecrets(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if got["CHALK_PG_APP_PASSWORD"] != appPw || got["CHALK_PG_GUEST_PASSWORD"] != guestPw {
		t.Error("role passwords not persisted to the env file")
	}
	if got["CHALK_DB_URL"] != "postgres://chalk_app:"+appPw+"@postgres:5432/chalk?sslmode=disable" {
		t.Errorf("CHALK_DB_URL not repointed at chalk_app: %s", got["CHALK_DB_URL"])
	}
	if got["CHALK_DB_URL_GUEST"] != "postgres://chalk_guest:"+guestPw+"@postgres:5432/chalk?sslmode=disable" {
		t.Errorf("CHALK_DB_URL_GUEST wrong: %s", got["CHALK_DB_URL_GUEST"])
	}
	// The owner password/URL basis is untouched.
	if got["CHALK_PG_PASSWORD"] != "ownerpw" {
		t.Error("owner password must not change")
	}

	// Second run: everything present -> preserved verbatim.
	appPw2, guestPw2, err := ensureDBRolesEnv(envPath, p, os.Stderr)
	if err != nil {
		t.Fatal(err)
	}
	if appPw2 != appPw || guestPw2 != guestPw {
		t.Error("present role passwords must be preserved, not regenerated")
	}
}

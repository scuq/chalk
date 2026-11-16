package chalkctl

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 139-2: the review instance. The tests that matter most are the production
// guards: nothing of production ever carries CHALK_REVIEW_MODE, and nothing
// of the review instance names a container, volume, network, or file of
// production.

func prodParams() InitParams {
	return InitParams{
		Domain: "chalk.example.org", Image: "ghcr.io/x/chalk", Version: "v1", Digest: "sha256:abc",
		PostgresTag: "18-alpine", CaddyTag: "2-alpine", CoturnTag: "4.14.0-r0-alpine",
		VoiceEnabled: true, PGPassword: "PGSECRET", TurnSecret: "TURNSECRET",
		PGAppPassword: "APPSECRET", PGGuestPassword: "GUESTSECRET",
		TOTPEncKey: "TOTPKEYX", ServerIDKey: "SERVERIDX", AdminBootstrapToken: "ADMINBOOTX",
		ChalkctlPath: "/usr/local/bin/chalkctl", AdminUsername: "admin", AdminEmail: "admin@example.org",
		OpenRegistration: true, PublicIP: "203.0.113.7", TurnMinPort: TurnMinPort, TurnMaxPort: TurnMaxPort,
	}
}

func TestProductionFilesNeverCarryReviewMode(t *testing.T) {
	for _, review := range []ReviewConf{{}, {Domain: "demo.example.org", Up: true}, {Domain: "demo.example.org"}} {
		p := prodParams()
		p.ReviewDomain, p.ReviewUp = review.Domain, review.Up
		all := append([]string{}, unitTemplates...)
		all = append(all, "Caddyfile", "chalk.env", "chalk-update.service", "chalk-update.timer")
		for _, name := range all {
			data, err := renderTemplate(name, p)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if strings.Contains(string(data), "CHALK_REVIEW_MODE") {
				t.Errorf("%s (review %+v) contains CHALK_REVIEW_MODE", name, review)
			}
		}
	}
	// The templates themselves, whatever the data.
	for _, name := range append(append([]string{}, unitTemplates...), "chalk.env", "Caddyfile") {
		raw, err := Templates.ReadFile("templates/" + name + ".tmpl")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "REVIEW_MODE") {
			t.Errorf("templates/%s.tmpl contains REVIEW_MODE", name)
		}
	}
}

func TestProductionEnvKeepsItsDatabaseHost(t *testing.T) {
	data, err := renderTemplate("chalk.env", prodParams())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"CHALK_DB_URL=postgres://chalk_app:APPSECRET@postgres:5432/chalk?sslmode=disable",
		"CHALK_DB_URL_GUEST=postgres://chalk_guest:GUESTSECRET@postgres:5432/chalk?sslmode=disable",
	} {
		if !strings.Contains(string(data), want) {
			t.Errorf("production env lacks %q", want)
		}
	}
}

func TestReviewEnvIsMarkedAndUsesTheReviewDatabase(t *testing.T) {
	p := prodParams()
	p.Domain, p.DBHost = "demo.example.org", reviewPGContainer
	data, err := reviewEnv(p)
	if err != nil {
		t.Fatal(err)
	}
	env := string(data)
	if !strings.Contains(env, "\nCHALK_REVIEW_MODE=1\n") {
		t.Error("review env lacks CHALK_REVIEW_MODE=1")
	}
	if !strings.Contains(env, "@postgres-review:5432/") || strings.Contains(env, "@postgres:5432/") {
		t.Error("review env does not point only at postgres-review")
	}
	if !strings.Contains(env, "CHALK_RP_ID=demo.example.org") {
		t.Error("review env does not use the review domain as RP ID")
	}
}

func TestReviewUnitsNameNothingOfProduction(t *testing.T) {
	rp := ReviewParams{Image: "ghcr.io/x/chalk", Version: "v1", Digest: "sha256:abc",
		PostgresTag: "18-alpine", VoiceEnabled: true, TurnDomain: "chalk.example.org", Up: true}
	forbidden := []string{
		"chalk.network", "ContainerName=postgres\n", "ContainerName=chalkd\n",
		"chalk-pgdata", "chalk-blobs.volume", "/etc/chalk/chalk.env", "chalk-postgres.service",
		"NetworkName=chalk\n",
	}
	for _, name := range reviewUnitTemplates {
		data, err := renderTemplateData(name, rp)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, f := range forbidden {
			if strings.Contains(string(data), f) {
				t.Errorf("%s names %q of production", name, strings.TrimSpace(f))
			}
		}
	}
	chalkd, _ := renderTemplateData("chalkd-review.container", rp)
	for _, want := range []string{
		"ContainerName=chalkd-review", "Network=chalk-review.network",
		"EnvironmentFile=/etc/chalk/review.env", "Image=ghcr.io/x/chalk@sha256:abc",
		"CHALK_TURN_URLS=turn:chalk.example.org:3478",
	} {
		if !strings.Contains(string(chalkd), want) {
			t.Errorf("chalkd-review.container lacks %q", want)
		}
	}
}

func TestReviewUnitsStartAtBootOnlyWhenUp(t *testing.T) {
	for _, up := range []bool{true, false} {
		rp := ReviewParams{Image: "i", Digest: "d", PostgresTag: "18", Up: up}
		for _, name := range []string{"chalkd-review.container", "chalk-review-postgres.container"} {
			data, err := renderTemplateData(name, rp)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Contains(string(data), "WantedBy=default.target"); got != up {
				t.Errorf("%s with Up=%v: WantedBy present = %v", name, up, got)
			}
		}
	}
}

func TestCaddyfileReviewBlock(t *testing.T) {
	render := func(rc ReviewConf, maint bool) string {
		t.Helper()
		data, err := renderTemplate("Caddyfile", InitParams{Domain: "chalk.example.org",
			Maintenance: maint, MaintenanceMessage: "x", ReviewDomain: rc.Domain, ReviewUp: rc.Up})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	none := render(ReviewConf{}, false)
	if strings.Contains(none, "chalkd-review") || strings.Contains(none, "demo server") {
		t.Error("Caddyfile without a review instance has review lines")
	}
	up := render(ReviewConf{Domain: "demo.example.org", Up: true}, false)
	if !strings.Contains(up, "demo.example.org {") || !strings.Contains(up, "reverse_proxy chalkd-review:8443") {
		t.Error("Caddyfile with the review instance up does not proxy chalkd-review")
	}
	if !strings.Contains(up, "reverse_proxy chalkd:8443") {
		t.Error("the production block lost its proxy")
	}
	down := render(ReviewConf{Domain: "demo.example.org"}, false)
	if strings.Contains(down, "chalkd-review") || !strings.Contains(down, `respond "the demo server is off." 503`) {
		t.Error("Caddyfile with the review instance down does not serve the off page")
	}
	// Production maintenance does not take the review instance down.
	maint := render(ReviewConf{Domain: "demo.example.org", Up: true}, true)
	if !strings.Contains(maint, "reverse_proxy chalkd-review:8443") {
		t.Error("production maintenance changed the review block")
	}
}

func TestCaddyUnitJoinsTheReviewNetworkOnlyWithAReviewInstance(t *testing.T) {
	without, err := renderTemplate("chalk-caddy.container", InitParams{CaddyTag: "2-alpine"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(without), "chalk-review") {
		t.Error("Caddy unit names chalk-review without a review instance")
	}
	with, _ := renderTemplate("chalk-caddy.container", InitParams{CaddyTag: "2-alpine", ReviewDomain: "demo.example.org"})
	if !strings.Contains(string(with), "Network=chalk.network\n") || !strings.Contains(string(with), "Network=chalk-review.network\n") {
		t.Errorf("Caddy unit with a review instance is not on both networks:\n%s", with)
	}
}

func TestReviewConfRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "review.conf")
	if c, err := LoadReviewConf(path); err != nil || c.Exists() {
		t.Fatalf("missing file: %+v, %v", c, err)
	}
	want := ReviewConf{Domain: "demo.example.org", Up: true}
	if err := want.Save(path); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadReviewConf(path); err != nil || got != want {
		t.Fatalf("round trip: %+v, %v; want %+v", got, err, want)
	}
}

func TestReviewMigrateArgsTargetTheReviewNetwork(t *testing.T) {
	args := strings.Join(reviewMigrateArgs("/etc/chalk/review.env", "ghcr.io/x/chalk", "sha256:abc"), " ")
	for _, want := range []string{"--network chalk-review", "--env-file /etc/chalk/review.env",
		"ghcr.io/x/chalk@sha256:abc", "--migrate-only"} {
		if !strings.Contains(args, want) {
			t.Errorf("migrate args %q lack %q", args, want)
		}
	}
	if reviewPGContainer == pgContainer {
		t.Fatal("the review Postgres container is the production container")
	}
}

// reviewFixture is a production deployment on disk, in temp dirs, for the
// --no-start runs of the review commands.
func reviewFixture(t *testing.T) ReviewOptions {
	t.Helper()
	dir := t.TempDir()
	o := ReviewOptions{
		Cfg: Config{Domain: "chalk.example.org", Image: "ghcr.io/x/chalk", PostgresTag: "18-alpine",
			CaddyTag: "2-alpine", VoiceEnabled: true, LinkPreviewEnabled: true},
		StatePath:      filepath.Join(dir, "state.json"),
		EnvPath:        filepath.Join(dir, "chalk.env"),
		ReviewConfPath: filepath.Join(dir, "review.conf"),
		ReviewEnvPath:  filepath.Join(dir, "review.env"),
		QuadletDir:     filepath.Join(dir, "quadlet"),
		CaddyfileAt:    filepath.Join(dir, "Caddyfile"),
		NoStart:        true,
		Out:            &strings.Builder{},
	}
	if err := (State{CurrentVersion: "v1", CurrentDigest: "sha256:abc"}).Save(o.StatePath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(o.EnvPath, []byte("CHALK_TURN_SECRET=TURNSECRET\nCHALK_TOTP_ENC_KEY=PRODKEY\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return o
}

func TestReviewInitWritesTheInstance(t *testing.T) {
	o := reviewFixture(t)
	err := ReviewInit(o, ReviewInitOptions{Domain: "demo.example.org", AdminUsername: "demoadmin", AdminEmail: "a@example.org"})
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(o.ReviewEnvPath)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("review env: %v, mode %v", err, fi.Mode())
	}
	env, _ := readEnvSecrets(o.ReviewEnvPath)
	if env["CHALK_REVIEW_MODE"] != "1" || env["CHALK_OPEN_REGISTRATION"] != "true" {
		t.Errorf("review env: mode %q, registration %q", env["CHALK_REVIEW_MODE"], env["CHALK_OPEN_REGISTRATION"])
	}
	if env["CHALK_TURN_SECRET"] != "TURNSECRET" {
		t.Error("review env does not share the TURN secret of production")
	}
	if env["CHALK_TOTP_ENC_KEY"] == "" || env["CHALK_TOTP_ENC_KEY"] == "PRODKEY" {
		t.Error("review env must have its own TOTP key")
	}
	if env["CHALK_EPHEMERAL_ENABLED"] != "false" {
		t.Error("guest links are on in the review instance")
	}
	prod, _ := os.ReadFile(o.EnvPath)
	if strings.Contains(string(prod), "REVIEW") {
		t.Error("review init changed the env file of production")
	}
	for _, name := range append(append([]string{}, reviewUnitTemplates...), caddyUnit) {
		if _, err := os.Stat(filepath.Join(o.QuadletDir, name)); err != nil {
			t.Errorf("missing %s: %v", name, err)
		}
	}
	caddyfile, _ := os.ReadFile(o.CaddyfileAt)
	if !strings.Contains(string(caddyfile), "reverse_proxy chalkd-review:8443") {
		t.Error("Caddyfile does not proxy the review instance")
	}
	if rc, _ := LoadReviewConf(o.ReviewConfPath); rc != (ReviewConf{Domain: "demo.example.org", Up: true}) {
		t.Errorf("review.conf = %+v", rc)
	}

	// A second init refuses.
	if err := ReviewInit(o, ReviewInitOptions{Domain: "demo.example.org", AdminUsername: "x", AdminEmail: "a@example.org"}); err == nil {
		t.Error("a second review init did not refuse")
	}
}

func TestReviewInitRefusesTheProductionDomain(t *testing.T) {
	o := reviewFixture(t)
	err := ReviewInit(o, ReviewInitOptions{Domain: "CHALK.example.org", AdminUsername: "x", AdminEmail: "a@example.org"})
	if err == nil {
		t.Fatal("review init accepted the domain of production")
	}
	if _, serr := os.Stat(o.ReviewEnvPath); serr == nil {
		t.Error("a refused init wrote the review env")
	}
}

func TestReviewDownUpKeepsThePin(t *testing.T) {
	o := reviewFixture(t)
	if err := ReviewInit(o, ReviewInitOptions{Domain: "demo.example.org", AdminUsername: "x", AdminEmail: "a@example.org"}); err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(o.QuadletDir, reviewChalkdUnit)
	if err := repinUnitImage(unit, "ghcr.io/x/chalk", "sha256:new"); err != nil {
		t.Fatal(err)
	}
	if err := ReviewSetUp(o, false); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(unit)
	if !strings.Contains(string(data), "Image=ghcr.io/x/chalk@sha256:new") {
		t.Error("review down lost the image pin")
	}
	if strings.Contains(string(data), "WantedBy=") {
		t.Error("a down review instance still starts at boot")
	}
	caddyfile, _ := os.ReadFile(o.CaddyfileAt)
	if !strings.Contains(string(caddyfile), "the demo server is off.") {
		t.Error("review down did not write the off page")
	}
	if err := ReviewSetUp(o, true); err != nil {
		t.Fatal(err)
	}
	caddyfile, _ = os.ReadFile(o.CaddyfileAt)
	if !strings.Contains(string(caddyfile), "reverse_proxy chalkd-review:8443") {
		t.Error("review up did not write the proxy")
	}
}

func TestReviewRegistrationAndRemove(t *testing.T) {
	o := reviewFixture(t)
	if err := ReviewInit(o, ReviewInitOptions{Domain: "demo.example.org", AdminUsername: "x", AdminEmail: "a@example.org"}); err != nil {
		t.Fatal(err)
	}
	if err := ReviewRegistration(o, false); err != nil {
		t.Fatal(err)
	}
	env, _ := readEnvSecrets(o.ReviewEnvPath)
	if env["CHALK_OPEN_REGISTRATION"] != "false" {
		t.Errorf("registration = %q, want false", env["CHALK_OPEN_REGISTRATION"])
	}

	o.Confirm = func(string) bool { return false }
	if err := ReviewRemove(o); err == nil {
		t.Fatal("remove went on without confirmation")
	}
	o.Confirm = func(string) bool { return true }
	if err := ReviewRemove(o); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{o.ReviewEnvPath, o.ReviewConfPath, filepath.Join(o.QuadletDir, reviewChalkdUnit)} {
		if _, err := os.Stat(path); err == nil {
			t.Errorf("%s is still there after remove", path)
		}
	}
	caddy, _ := os.ReadFile(filepath.Join(o.QuadletDir, caddyUnit))
	caddyfile, _ := os.ReadFile(o.CaddyfileAt)
	if strings.Contains(string(caddy), "chalk-review") || strings.Contains(string(caddyfile), "demo.example.org") {
		t.Error("remove left review lines in the Caddy unit or the Caddyfile")
	}
}

func TestRepinReviewWithoutAReviewInstanceDoesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := repinReview(dir, filepath.Join(dir, "review.conf"), "i", "d", t.Logf); err != nil {
		t.Fatal(err)
	}
}

// Caddy itself must accept the Caddyfile with the review block, up and down,
// with and without production maintenance.
func TestCaddyfileWithReviewBlockValidates(t *testing.T) {
	for _, c := range []struct {
		up, maint bool
	}{{true, false}, {false, false}, {true, true}} {
		data, err := renderTemplate("Caddyfile", InitParams{Domain: "chalk.example.org",
			Maintenance: c.maint, MaintenanceMessage: "back soon",
			ReviewDomain: "demo.example.org", ReviewUp: c.up})
		if err != nil {
			t.Fatal(err)
		}
		if out, err := caddyValidate(t, string(data)); err != nil {
			t.Errorf("caddy rejects the Caddyfile (review up=%v, maintenance=%v): %v\n%s", c.up, c.maint, err, out)
		}
	}
}

// writeCaddy renders the Caddy unit with CaddyTag and ReviewDomain only. If
// the template read another field, `chalkctl review` would render it empty.
func TestCaddyUnitTemplateReadsOnlyWhatReviewSupplies(t *testing.T) {
	raw, err := Templates.ReadFile("templates/chalk-caddy.container.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"CaddyTag": true, "ReviewDomain": true}
	for _, m := range regexp.MustCompile(`\{\{-?\s*(?:if\s+)?\.(\w+)`).FindAllStringSubmatch(string(raw), -1) {
		if !allowed[m[1]] {
			t.Errorf("chalk-caddy.container.tmpl reads .%s, which `chalkctl review` does not supply", m[1])
		}
	}
}

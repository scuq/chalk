package chalkctl

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func renderCaddyfile(t *testing.T, maintenance bool, message string) string {
	t.Helper()
	return renderCaddyfileFor(t, "chat.example.org", maintenance, message)
}

func renderCaddyfileFor(t *testing.T, domain string, maintenance bool, message string) string {
	t.Helper()
	b, err := renderTemplate("Caddyfile", InitParams{
		Domain:             domain,
		Maintenance:        maintenance,
		MaintenanceMessage: message,
	})
	if err != nil {
		t.Fatalf("render Caddyfile: %v", err)
	}
	return string(b)
}

func TestCaddyfileNormalModeProxies(t *testing.T) {
	got := renderCaddyfile(t, false, "")
	if !strings.Contains(got, "reverse_proxy chalkd:8443") {
		t.Errorf("normal mode must proxy chalkd:\n%s", got)
	}
	// handle_errors legitimately responds 503 in normal mode, so the markers
	// have to be ones only the maintenance branch can produce.
	for _, unwanted := range []string{"maintenance", "Retry-After", "<!doctype html>", "@health"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("normal mode leaked maintenance markup (%q):\n%s", unwanted, got)
		}
	}
}

func TestCaddyfileMaintenanceModeServesNotice(t *testing.T) {
	got := renderCaddyfile(t, true, "back by 14:00 UTC")
	if strings.Contains(got, "header_up Host") {
		t.Errorf("maintenance mode must not proxy the app:\n%s", got)
	}
	if !strings.Contains(got, "back by 14:00 UTC") {
		t.Errorf("the operator's message is missing:\n%s", got)
	}
	if !strings.Contains(got, `Retry-After "300"`) {
		t.Errorf("a 503 without Retry-After tells clients nothing about coming back:\n%s", got)
	}
	if !strings.Contains(got, "` 503") {
		t.Errorf("the notice must be served with 503, not 200:\n%s", got)
	}
}

// update and restore both poll /healthz to decide whether the app came back.
// If maintenance swallowed it they would health-check the maintenance page and
// roll back a perfectly good deployment.
func TestCaddyfileMaintenanceKeepsHealthzReachable(t *testing.T) {
	got := renderCaddyfile(t, true, "")
	if !strings.Contains(got, "@health path /healthz") {
		t.Fatalf("maintenance mode must still route /healthz to chalkd:\n%s", got)
	}
	health := got[strings.Index(got, "@health"):]
	if !strings.Contains(health[:strings.Index(health, "handle {")], "reverse_proxy chalkd:8443") {
		t.Fatalf("/healthz is matched but not proxied:\n%s", got)
	}
}

// 85-4: the access log is site-level, so it has to survive the mode switch --
// a maintenance window is exactly when the operator wants to see what is still
// arriving. Placement above the switch is what guarantees it.
func TestCaddyfileLogsBothModes(t *testing.T) {
	for _, maintenance := range []bool{false, true} {
		got := renderCaddyfile(t, maintenance, "back by 14:00 UTC")
		block := strings.Index(got, "\tlog {")
		if block < 0 {
			t.Fatalf("maintenance=%v: no access-log block:\n%s", maintenance, got)
		}
		if !strings.Contains(got[block:], "output stderr") || !strings.Contains(got[block:], "format json") {
			t.Errorf("maintenance=%v: the log block must be JSON on stderr (journald):\n%s", maintenance, got)
		}
		// log_credentials would put session cookies in the journal.
		if regexp.MustCompile(`(?m)^\s*log_credentials`).MatchString(got) {
			t.Errorf("maintenance=%v: log_credentials un-redacts Cookie and Authorization:\n%s", maintenance, got)
		}
	}
}

// Caddy reads braces in a respond body as placeholders, which is why the page
// styles every element inline instead of carrying a <style> block.
func TestCaddyfileNoticeHasNoCSSBraces(t *testing.T) {
	got := renderCaddyfile(t, true, "")
	start := strings.Index(got, "respond `")
	end := strings.Index(got[start:], "` 503")
	if start < 0 || end < 0 {
		t.Fatalf("could not find the respond body:\n%s", got)
	}
	body := got[start+len("respond `") : start+end]
	if strings.ContainsAny(body, "{}") {
		t.Errorf("the maintenance page contains a brace, which Caddy reads as a placeholder:\n%s", body)
	}
}

// writeCaddyfile (the maint path) fills in only Domain, Maintenance and
// MaintenanceMessage -- it has no business reconstructing secrets. If the
// Caddyfile template ever reads another field, that field would silently
// render EMPTY on every `maint on`/`maint off`, so the template's field set is
// pinned here rather than left to be discovered in production.
func TestCaddyfileTemplateReadsOnlyWhatMaintSupplies(t *testing.T) {
	raw, err := Templates.ReadFile("templates/Caddyfile.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"Domain": true, "Maintenance": true, "MaintenanceMessage": true}
	for _, m := range regexp.MustCompile(`\{\{-?\s*(?:if\s+)?\.(\w+)`).FindAllStringSubmatch(string(raw), -1) {
		if !allowed[m[1]] {
			t.Errorf("Caddyfile.tmpl reads .%s, which writeCaddyfile does not supply -- "+
				"`chalkctl maint` would render it empty", m[1])
		}
	}
}

func TestMaintenanceMessageHTML(t *testing.T) {
	if got, err := MaintenanceMessageHTML(""); err != nil || got != DefaultMaintenanceMessage {
		t.Errorf("empty message: got %q, %v", got, err)
	}
	if got, err := MaintenanceMessageHTML("  spaced  "); err != nil || got != "spaced" {
		t.Errorf("trim: got %q, %v", got, err)
	}
	// A tag in the message must land on the page as text, not as markup.
	got, err := MaintenanceMessageHTML(`back soon <script>alert(1)</script>`)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "<script>") {
		t.Errorf("message was not escaped: %q", got)
	}
	// A backtick would close the Caddyfile string early and turn the rest of
	// the page into config.
	if _, err := MaintenanceMessageHTML("uh `oh`"); err == nil {
		t.Error("a backtick in the message was accepted")
	}
	if _, err := MaintenanceMessageHTML("two\nlines"); err == nil {
		t.Error("a multi-line message was accepted")
	}
}

func TestMaintenanceMessageSurvivesRenderEscaped(t *testing.T) {
	msg, err := MaintenanceMessageHTML(`moving & upgrading <soon>`)
	if err != nil {
		t.Fatal(err)
	}
	got := renderCaddyfile(t, true, msg)
	if strings.Contains(got, "<soon>") {
		t.Errorf("escaped message was un-escaped by rendering:\n%s", got)
	}
	if !strings.Contains(got, "&amp;") {
		t.Errorf("expected the escaped ampersand in the rendered page:\n%s", got)
	}
}

// caddyValidate runs `caddy validate` over content, using a local caddy binary
// if there is one and the pinned image otherwise. The Caddyfile's brace and
// quoting rules are Caddy's, not ours, so asserting on the rendered text alone
// would only prove we render what we expect -- not that Caddy accepts it.
func caddyValidate(t *testing.T, content string) ([]byte, error) {
	t.Helper()
	if bin, err := exec.LookPath("caddy"); err == nil {
		dir := t.TempDir()
		path := filepath.Join(dir, "Caddyfile")
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return exec.Command(bin, "validate", "--adapter", "caddyfile", "--config", path).CombinedOutput()
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("neither caddy nor docker available; skipping Caddyfile validation")
	}
	cmd := exec.Command("docker", "run", "--rm", "-i", "docker.io/library/caddy:"+DefaultCaddyTag,
		"caddy", "validate", "--adapter", "caddyfile", "--config", "/dev/stdin")
	cmd.Stdin = strings.NewReader(content)
	return cmd.CombinedOutput()
}

// Validation proves Caddy accepts the config; this proves it serves what the
// config was written to serve. The distinguishing check is /healthz: it must
// come back as a proxy failure (chalkd is absent here), NOT as the notice --
// if the maintenance handler swallowed it, update and restore would health-
// check the notice and roll back a healthy deployment.
func TestCaddyfileMaintenanceServesTheNotice(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available; skipping served-response test")
	}
	const msg = "moving to a new server, back by 14:00 UTC"
	// ":80" as the site address serves plain HTTP for any host, which keeps
	// the test off automatic HTTPS (a real domain would redirect to :443 and
	// try to issue a certificate) while exercising the same handlers.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Caddyfile"),
		[]byte(renderCaddyfileFor(t, ":80", true, msg)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	out, err := exec.Command("docker", "run", "-d", "--rm", "-p", "127.0.0.1::80",
		"-v", filepath.Join(dir, "Caddyfile")+":/etc/caddy/Caddyfile:ro",
		"docker.io/library/caddy:"+DefaultCaddyTag).CombinedOutput()
	if err != nil {
		t.Skipf("could not start caddy under docker (%v):\n%s", err, out)
	}
	id := strings.TrimSpace(string(out))
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", id).Run() })

	portOut, err := exec.Command("docker", "port", id, "80/tcp").Output()
	if err != nil {
		t.Fatalf("docker port: %v", err)
	}
	hostPort := strings.TrimSpace(strings.Split(string(portOut), "\n")[0])
	base := "http://" + hostPort

	client := &http.Client{Timeout: 3 * time.Second}
	var resp *http.Response
	for i := 0; i < 40; i++ {
		if resp, err = client.Get(base + "/"); err == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("caddy never answered on %s: %v", base, err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("notice status = %d, want 503", resp.StatusCode)
	}
	if got := resp.Header.Get("Retry-After"); got != "300" {
		t.Errorf("Retry-After = %q, want 300", got)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	if !strings.Contains(string(body), msg) {
		t.Errorf("the notice did not carry the operator's message:\n%s", body)
	}
	if !strings.Contains(string(body), "chalk is under maintenance") {
		t.Errorf("the notice body is not the maintenance page:\n%s", body)
	}

	hresp, err := client.Get(base + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	hbody, _ := io.ReadAll(hresp.Body)
	hresp.Body.Close()
	if strings.Contains(string(hbody), "chalk is under maintenance") {
		t.Errorf("/healthz was answered by the maintenance page; update/restore would roll back:\n%s", hbody)
	}
	if hresp.StatusCode != http.StatusBadGateway {
		t.Logf("/healthz returned %d (chalkd is absent here; only the notice would be wrong)", hresp.StatusCode)
	}

	// 85-4: piggybacks on the container already running rather than starting a
	// second one. Rendering the log block proves nothing about whether Caddy
	// writes anything; only a real request through a real Caddy does.
	var logs string
	for i := 0; i < 40; i++ {
		out, err := exec.Command("docker", "logs", id).CombinedOutput()
		if err == nil && strings.Contains(string(out), `"msg":"handled request"`) {
			logs = string(out)
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if logs == "" {
		t.Fatal("two requests produced no access-log entry; the log block is not in effect")
	}
	if !strings.Contains(logs, `"uri":"/healthz"`) {
		t.Errorf("the /healthz request was not logged:\n%s", logs)
	}
}

func TestCaddyfileValidatesInBothModes(t *testing.T) {
	for _, tc := range []struct {
		name        string
		maintenance bool
		message     string
	}{
		{"normal", false, ""},
		{"maintenance", true, "moving to a new server, back by 14:00 UTC"},
		{"maintenance-escaped", true, "tea &amp; biscuits &lt;br&gt;"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := caddyValidate(t, renderCaddyfile(t, tc.maintenance, tc.message))
			if err != nil {
				t.Fatalf("caddy rejected the generated Caddyfile: %v\n%s", err, out)
			}
			if bytes.Contains(bytes.ToLower(out), []byte("error")) {
				t.Fatalf("caddy reported an error validating the Caddyfile:\n%s", out)
			}
		})
	}
}

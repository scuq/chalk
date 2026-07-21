package chalkctl

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// UpdateOptions configures an update.
type UpdateOptions struct {
	Cfg       Config
	Version   string   // target tag; "" -> cfg.Channel (e.g. "stable")
	Verifier  Verifier // cosign or noop
	Podman    *Podman
	StatePath string
	Out       io.Writer

	// HealthURL is polled after the swap; default https://<domain>/healthz.
	HealthURL string
	// HealthTimeout bounds the post-swap health poll (default 60s).
	HealthTimeout time.Duration
	// SkipHealth disables the health gate (and thus auto-rollback).
	SkipHealth bool
}

func (o *UpdateOptions) defaults() {
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	if o.StatePath == "" {
		o.StatePath = DefaultStatePath
	}
	if o.Version == "" {
		o.Version = firstNonEmpty(o.Cfg.Channel, "stable")
	}
	if o.HealthURL == "" && o.Cfg.Domain != "" {
		o.HealthURL = "https://" + o.Cfg.Domain + "/healthz"
	}
	if o.HealthTimeout == 0 {
		o.HealthTimeout = 60 * time.Second
	}
}

func (o *UpdateOptions) logf(format string, a ...any) {
	fmt.Fprintf(o.Out, "  "+format+"\n", a...)
}

// Update pulls the target chalk image, verifies its signature, pins the new
// digest, restarts chalkd onto it, and health-checks. On health failure it
// rolls chalkd back to the previous digest. Only the chalk app is swapped;
// postgres/coturn are untouched (their tags are pinned by init).
//
// This makes the weekly auto-update timer functional (it calls `chalkctl
// update`), and gives a manual path to move versions without a full re-init.
func Update(o UpdateOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	st, ok, err := LoadState(o.StatePath)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("not initialized (%s missing) -- run `chalkctl init` first", o.StatePath)
	}

	imageTag := o.Cfg.Image + ":" + o.Version
	fmt.Fprintf(o.Out, "chalkctl update: %s -> %s\n", st.CurrentVersion, o.Version)

	// verify
	o.logf("verifier: %s", o.Verifier.Describe())
	o.logf("verifying %s...", imageTag)
	if err := o.Verifier.Verify(imageTag); err != nil {
		return fmt.Errorf("signature verification failed (pass --skip-verify to override): %w", err)
	}

	// pull + resolve new digest
	o.logf("pulling %s...", imageTag)
	if err := o.Podman.Pull(imageTag); err != nil {
		return err
	}
	newDigest, err := o.Podman.ResolveDigest(imageTag)
	if err != nil {
		return err
	}
	if newDigest == st.CurrentDigest {
		o.logf("already at %s (%s); nothing to do", o.Version, shortDigest(newDigest))
		return nil
	}
	o.logf("new digest: %s", newDigest)

	// The chalkd unit is pinned by digest in its Image= line. Re-pin by
	// rewriting the one line, then restart. We keep the OLD digest so a
	// health failure can roll back.
	oldDigest := st.CurrentDigest
	if err := repinChalkdImage(o.Cfg.Image, newDigest); err != nil {
		return fmt.Errorf("re-pin chalkd unit: %w", err)
	}
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	o.logf("restarting chalkd onto new image...")
	if _, err := Systemctl("restart", "chalkd.service"); err != nil {
		return o.rollback(oldDigest, fmt.Sprintf("restart failed: %v", err))
	}

	// health gate
	if !o.SkipHealth {
		o.logf("waiting for health at %s (up to %s)...", o.HealthURL, o.HealthTimeout)
		if err := pollHealth(o.HealthURL, o.HealthTimeout); err != nil {
			return o.rollback(oldDigest, fmt.Sprintf("health check failed: %v", err))
		}
		o.logf("healthy.")
	}

	// persist new state (with previous digest for `rollback`)
	st.PreviousDigest = oldDigest
	st.CurrentDigest = newDigest
	st.CurrentVersion = o.Version
	st.UpdatedAt = time.Now().UTC()
	if err := st.Save(o.StatePath); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "done. updated to %s (%s).\n", o.Version, shortDigest(newDigest))
	return nil
}

// rollback re-pins chalkd to the previous digest and restarts, then returns an
// error describing why the update was rolled back.
func (o UpdateOptions) rollback(prevDigest, reason string) error {
	if prevDigest == "" {
		return fmt.Errorf("%s -- and no previous digest to roll back to; chalkd may be down, check `journalctl -u chalkd`", reason)
	}
	o.logf("ROLLING BACK to %s (%s)", shortDigest(prevDigest), reason)
	if err := repinChalkdImage(o.Cfg.Image, prevDigest); err != nil {
		return fmt.Errorf("%s; rollback re-pin ALSO failed: %w -- manual intervention needed", reason, err)
	}
	_, _ = Systemctl("daemon-reload")
	if _, err := Systemctl("restart", "chalkd.service"); err != nil {
		return fmt.Errorf("%s; rollback restart failed: %w -- manual intervention needed", reason, err)
	}
	return fmt.Errorf("update rolled back: %s", reason)
}

// pollHealth GETs url until it returns 2xx or the timeout elapses.
func pollHealth(url string, timeout time.Duration) error {
	if url == "" {
		return nil // no domain configured; skip silently
	}
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			last = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			last = err
		}
		time.Sleep(2 * time.Second)
	}
	if last == nil {
		last = fmt.Errorf("timeout")
	}
	return last
}

func shortDigest(d string) string {
	d = trimPrefix(d, "sha256:")
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

func trimPrefix(s, p string) string {
	if len(s) >= len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}

// repinChalkdImage rewrites the Image= line in the chalkd Quadlet unit to
// point at image@digest, preserving the rest of the file. Digest-pinning by
// rewriting one line (rather than re-rendering the whole unit) keeps update
// surgical -- it touches only what changes.
func repinChalkdImage(image, digest string) error {
	path := DefaultQuadletDir + "/chalkd.container"
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := splitLines(string(b))
	found := false
	for i, ln := range lines {
		if hasPrefix(ln, "Image=") {
			lines[i] = "Image=" + image + "@" + digest
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no Image= line in %s", path)
	}
	return os.WriteFile(path, []byte(joinLines(lines)), 0o644)
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func joinLines(lines []string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "\n"
		}
		out += l
	}
	return out
}

func hasPrefix(s, p string) bool {
	return len(s) >= len(p) && s[:len(p)] == p
}

package auth

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func newSecLogDeps(on bool) (*HTTPDeps, *bytes.Buffer) {
	var buf bytes.Buffer
	d := &HTTPDeps{Logger: log.New(&buf, "", 0), SecurityLog: on}
	d.initSecurityLog()
	return d, &buf
}

func TestSecLogRespectsSwitch(t *testing.T) {
	d, buf := newSecLogDeps(true)
	d.secLog("totp_lockout_armed user=%s", "alice")
	if !strings.Contains(buf.String(), "security: totp_lockout_armed user=alice") {
		t.Errorf("event not logged: %q", buf.String())
	}

	off, offBuf := newSecLogDeps(false)
	off.secLog("totp_lockout_armed user=%s", "alice")
	off.secLogThrottled("k", "rate_limited ip=%s", "10.0.0.1")
	if offBuf.Len() != 0 {
		t.Errorf("CHALK_OPLOG_SECURITY=false must silence everything, got %q", offBuf.String())
	}
}

// The throttle is what makes it safe to log an event an attacker can provoke
// in a loop: the first offence is recorded, the flood behind it is not.
func TestSecLogThrottledCollapsesRepeats(t *testing.T) {
	d, buf := newSecLogDeps(true)
	for i := 0; i < 50; i++ {
		d.secLogThrottled("ratelimit|anon|10.0.0.1", "rate_limited ip=%s", "10.0.0.1")
	}
	if n := strings.Count(buf.String(), "rate_limited"); n != 1 {
		t.Errorf("50 denials from one address produced %d lines, want 1", n)
	}
}

// Throttling must be per key, or a noisy attacker would mask the first sign of
// a second one.
func TestSecLogThrottledIsPerKey(t *testing.T) {
	d, buf := newSecLogDeps(true)
	d.secLogThrottled("ratelimit|anon|10.0.0.1", "rate_limited ip=%s", "10.0.0.1")
	d.secLogThrottled("ratelimit|anon|10.0.0.1", "rate_limited ip=%s", "10.0.0.1")
	d.secLogThrottled("ratelimit|anon|10.0.0.2", "rate_limited ip=%s", "10.0.0.2")

	out := buf.String()
	if n := strings.Count(out, "rate_limited"); n != 2 {
		t.Errorf("want one line per address (2), got %d: %q", n, out)
	}
	if !strings.Contains(out, "10.0.0.2") {
		t.Errorf("the second address was swallowed: %q", out)
	}
}

// secLog must never be the reason a request panics, so a deps with no limiter
// built (a test, or a mount path that skipped init) still has to work.
func TestSecLogWithoutInit(t *testing.T) {
	var buf bytes.Buffer
	d := &HTTPDeps{Logger: log.New(&buf, "", 0), SecurityLog: true}
	d.secLogThrottled("k", "login_failed username=%q", "bob")
	if !strings.Contains(buf.String(), "login_failed") {
		t.Errorf("uninitialized limiter must not swallow the event: %q", buf.String())
	}
}

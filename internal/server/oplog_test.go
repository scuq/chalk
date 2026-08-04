package server

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A zero threshold must hand the handler back unwrapped, so the disabled case
// costs nothing per request -- not even a wrapper frame.
func TestSlowRequestLoggerDisabled(t *testing.T) {
	var buf bytes.Buffer
	var gotWriter http.ResponseWriter
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotWriter = w
		time.Sleep(5 * time.Millisecond)
	})
	slowRequestLogger(inner, 0, log.New(&buf, "", 0)).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))

	if _, wrapped := gotWriter.(*statusWriter); wrapped {
		t.Error("threshold 0 still wrapped the ResponseWriter")
	}
	if buf.Len() != 0 {
		t.Errorf("threshold 0 must log nothing, got %q", buf.String())
	}
}

func TestSlowRequestLoggerLogsOnlySlow(t *testing.T) {
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	slow := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.WriteHeader(http.StatusTeapot)
	})
	h := slowRequestLogger(slow, 10*time.Millisecond, logger)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/slow", nil))

	out := buf.String()
	if !strings.Contains(out, "slow request: POST /api/slow") {
		t.Errorf("slow request not logged: %q", out)
	}
	// The captured status is the part most easily lost to a wrapper that
	// forgets WriteHeader.
	if !strings.Contains(out, "status=418") {
		t.Errorf("status not captured: %q", out)
	}

	buf.Reset()
	fast := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	slowRequestLogger(fast, time.Hour, logger).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/fast", nil))
	if buf.Len() != 0 {
		t.Errorf("a fast request must log nothing, got %q", buf.String())
	}
}

// A handler that never calls WriteHeader still answers 200; the wrapper has to
// report that rather than 0.
func TestSlowRequestLoggerDefaultStatus(t *testing.T) {
	var buf bytes.Buffer
	h := slowRequestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}), time.Nanosecond, log.New(&buf, "", 0))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	if !strings.Contains(buf.String(), "status=200") {
		t.Errorf("implicit 200 not reported: %q", buf.String())
	}
}

// /ws must bypass the wrapper entirely. A WebSocket is long-lived (so it would
// log on every disconnect) and the upgrade needs the raw ResponseWriter.
func TestSlowRequestLoggerSkipsWebSocket(t *testing.T) {
	var buf bytes.Buffer
	var gotWriter http.ResponseWriter
	h := slowRequestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotWriter = w
		time.Sleep(5 * time.Millisecond)
	}), time.Nanosecond, log.New(&buf, "", 0))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/ws", nil))

	if buf.Len() != 0 {
		t.Errorf("/ws must not produce a slow-request line, got %q", buf.String())
	}
	if _, wrapped := gotWriter.(*statusWriter); wrapped {
		t.Error("/ws handler got a wrapped ResponseWriter; the upgrade needs the real one")
	}
}

func TestLogSnapshot(t *testing.T) {
	var buf bytes.Buffer
	s := &Server{hub: NewHub(), logger: log.New(&buf, "", 0)}

	alice := NewConn("c1", "dev-a", "u-alice", nil)
	alice.Username, alice.RemoteIP, alice.DeviceType = "alice", "203.0.113.7", "desktop"
	alice.SetRTT(41 * time.Millisecond)

	guest := NewConn("c2", "dev-g", "u-guest", nil)
	guest.Username, guest.RemoteIP, guest.DeviceType = "visitor", "198.51.100.2", "phone"
	guest.IsGuest = true

	s.hub.Register(alice)
	s.hub.Register(guest)
	s.logSnapshot(context.Background())

	out := buf.String()
	if !strings.Contains(out, "snapshot: conns=2 users=2 guests=1") {
		t.Errorf("summary line wrong: %q", out)
	}
	if !strings.Contains(out, "user=alice dev=desktop ip=203.0.113.7") {
		t.Errorf("alice's line missing: %q", out)
	}
	if !strings.Contains(out, "rtt=41ms") {
		t.Errorf("round-trip not reported: %q", out)
	}
	if !strings.Contains(out, "user=visitor dev=phone ip=198.51.100.2") {
		t.Errorf("guest's line missing: %q", out)
	}
	if !strings.Contains(out, "guest") {
		t.Errorf("guest not marked: %q", out)
	}
	// No store wired: the summary must simply omit database health rather
	// than print a zero that reads as a healthy pool.
	if strings.Contains(out, "db_rtt") || strings.Contains(out, "pool=") {
		t.Errorf("store-less server reported database health: %q", out)
	}
}

// Sorted output is what makes two consecutive snapshots comparable by eye; the
// hub's maps iterate in randomized order.
func TestLogSnapshotIsOrdered(t *testing.T) {
	var buf bytes.Buffer
	s := &Server{hub: NewHub(), logger: log.New(&buf, "", 0)}
	for _, name := range []string{"carol", "alice", "bob"} {
		c := NewConn("conn-"+name, "dev-"+name, "u-"+name, nil)
		c.Username = name
		s.hub.Register(c)
	}
	s.logSnapshot(context.Background())

	out := buf.String()
	a, b, c := strings.Index(out, "user=alice"), strings.Index(out, "user=bob"), strings.Index(out, "user=carol")
	if a < 0 || b < 0 || c < 0 || !(a < b && b < c) {
		t.Errorf("connections not sorted by username: %q", out)
	}
}

func TestConnRTT(t *testing.T) {
	c := NewConn("", "dev", "user", nil)
	if c.RTT() != 0 {
		t.Errorf("a fresh conn has no measurement, got %s", c.RTT())
	}
	c.SetRTT(42 * time.Millisecond)
	if c.RTT() != 42*time.Millisecond {
		t.Errorf("RTT = %s, want 42ms", c.RTT())
	}
}

func TestShortDurAndRTTString(t *testing.T) {
	if got := shortDur(1500 * time.Microsecond); got != "1.5ms" {
		t.Errorf("shortDur(1.5ms) = %s", got)
	}
	// Longer spans round to the second so a connection age stays readable.
	if got := shortDur(72*time.Minute + 400*time.Millisecond); got != "1h12m0s" {
		t.Errorf("shortDur(1h12m0.4s) = %s", got)
	}
	if got := rttString(0); got != "?" {
		t.Errorf("an unmeasured RTT should read as ?, got %s", got)
	}
	if got := orUnknown(""); got != "?" {
		t.Errorf("orUnknown(\"\") = %s", got)
	}
}

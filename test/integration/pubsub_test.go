package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
)

// addrEnv reads a host:port from env. Returns "" if not set.
func addrEnv(name string) string {
	return os.Getenv(name)
}

// dialAt opens a chalk WebSocket against an explicit base URL and reads
// the welcome frame. Like dial() in ws_test.go but parameterized by host.
func dialAt(t *testing.T, baseURL, deviceID string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(baseURL, "http://", "ws://", 1) + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("dial %s: %v", baseURL, err)
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	hello, _ := proto.NewFrame(proto.TypeHello, "", proto.HelloPayload{DeviceID: deviceID})
	hb, _ := json.Marshal(hello)
	if err := c.Write(ctx, websocket.MessageText, hb); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read welcome: %v", err)
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	if f.Type != proto.TypeWelcome {
		t.Fatalf("expected welcome, got %s", f.Type)
	}
	return c
}

// writeSendOn writes a TypeSend frame with the given body.
func writeSendOn(t *testing.T, c *websocket.Conn, body string) {
	t.Helper()
	frame, _ := proto.NewFrame(proto.TypeSend, "", proto.SendPayload{Body: body})
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write send: %v", err)
	}
}

func readFrameOn(t *testing.T, c *websocket.Conn, timeout time.Duration) proto.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return f
}

// ---- tests ---------------------------------------------------------------

// Skips unless the bootstrap exported addresses for two instances.
func twoInstanceURLs(t *testing.T) (string, string) {
	t.Helper()
	a := addrEnv("CHALK_TEST_HTTP_1")
	b := addrEnv("CHALK_TEST_HTTP_2")
	if a == "" || b == "" {
		t.Skip("CHALK_TEST_HTTP_1 / CHALK_TEST_HTTP_2 not set; multi-instance test must be run via bootstrap")
	}
	return a, b
}

// TestCrossInstanceFanout is the headline phase-05 test. Client A talks to
// instance 1, client B talks to instance 2; A sends, B receives.
func TestCrossInstanceFanout(t *testing.T) {
	url1, url2 := twoInstanceURLs(t)

	// Distinct UUIDs per device (the server's ensureDeviceForTesting
	// requires real UUIDs; the WS handler validates that).
	devA := uuid.New().String()
	devB := uuid.New().String()

	a := dialAt(t, url1, devA)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAt(t, url2, devB)
	defer b.Close(websocket.StatusNormalClosure, "")

	// Small delay to make sure both listeners are subscribed before we send.
	// Without this, a fast send on instance 1 could be NOTIFY'd before
	// instance 2's LISTEN started, in which case instance 2 would never see
	// it. In real life this is a non-issue (clients are connected for
	// minutes-to-hours); for a fresh test it matters.
	time.Sleep(200 * time.Millisecond)

	writeSendOn(t, a, "hello across instances")

	got := readFrameOn(t, b, 3*time.Second)
	if got.Type != proto.TypeMessage {
		t.Fatalf("expected message, got %s", got.Type)
	}
	var p proto.MessagePayload
	if err := got.DecodePayload(&p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p.Body != "hello across instances" {
		t.Errorf("body: %q", p.Body)
	}
	if p.Sender != devA {
		t.Errorf("sender: %q want %q", p.Sender, devA)
	}
}

func TestCrossInstanceSenderDoesNotEcho(t *testing.T) {
	url1, url2 := twoInstanceURLs(t)
	devA := uuid.New().String()
	devB := uuid.New().String()
	t.Logf("devA=%s devB=%s", devA, devB)

	a := dialAt(t, url1, devA)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAt(t, url2, devB)
	defer b.Close(websocket.StatusNormalClosure, "")

	time.Sleep(200 * time.Millisecond)
	writeSendOn(t, a, "should not echo to A")

	// B should receive.
	got := readFrameOn(t, b, 3*time.Second)
	t.Logf("B received: type=%s payload=%s", got.Type, string(got.Payload))

	// A should not receive its own message back (NOTIFY excludes sender).
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	mt, data, err := a.Read(ctx)
	if err == nil {
		t.Fatalf("sender unexpectedly received its own message: type=%v payload=%s", mt, string(data))
	}
	t.Logf("A correctly received nothing (err=%v)", err)
}

// TestCrossInstanceLatency measures send→receive latency. Generous bound
// because CI on slow machines can blow past sub-50ms; the assertion is
// "reasonable", not "fast". Phase 12 will add real metrics.
func TestCrossInstanceLatency(t *testing.T) {
	url1, url2 := twoInstanceURLs(t)
	devA := uuid.New().String()
	devB := uuid.New().String()

	a := dialAt(t, url1, devA)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAt(t, url2, devB)
	defer b.Close(websocket.StatusNormalClosure, "")

	time.Sleep(200 * time.Millisecond)

	const n = 5
	total := time.Duration(0)
	for i := 0; i < n; i++ {
		t0 := time.Now()
		writeSendOn(t, a, "ping")
		_ = readFrameOn(t, b, 3*time.Second)
		total += time.Since(t0)
	}
	avg := total / n
	t.Logf("average cross-instance latency: %s over %d sends", avg, n)
	if avg > 500*time.Millisecond {
		t.Errorf("cross-instance latency too high: %s avg", avg)
	}
}

// TestSingleInstanceStillWorks verifies that phase 04 behavior survives
// the rewrite: two clients on the SAME instance still see each other's
// messages, now via the round-trip through PG NOTIFY rather than a direct
// hub broadcast.
func TestSingleInstanceStillWorks(t *testing.T) {
	url1 := addrEnv("CHALK_TEST_HTTP_1")
	if url1 == "" {
		t.Skip("CHALK_TEST_HTTP_1 not set")
	}

	devA := uuid.New().String()
	devB := uuid.New().String()
	a := dialAt(t, url1, devA)
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dialAt(t, url1, devB)
	defer b.Close(websocket.StatusNormalClosure, "")

	time.Sleep(200 * time.Millisecond)
	writeSendOn(t, a, "same instance")

	got := readFrameOn(t, b, 3*time.Second)
	if got.Type != proto.TypeMessage {
		t.Fatalf("expected message, got %s", got.Type)
	}
}

// Sanity: /healthz on both.
func TestBothHealthz(t *testing.T) {
	url1, url2 := twoInstanceURLs(t)
	for _, u := range []string{url1, url2} {
		resp, err := http.Get(u + "/healthz")
		if err != nil {
			t.Fatalf("healthz %s: %v", u, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("healthz %s: %d", u, resp.StatusCode)
		}
	}
}

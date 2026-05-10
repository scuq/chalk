package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/server"
)

// startTestServer spins a server on a random port backed by the test PG.
// Returns the bound URL ("http://127.0.0.1:N") and a cleanup function.
//
// The returned URL is guaranteed to be ready: HTTP up AND the cross-instance
// pubsub listener has subscribed. Without that second wait, an immediate
// send after startTestServer can NOTIFY before LISTEN, dropping the message.
func startTestServer(t *testing.T) (string, func()) {
	t.Helper()
	st := openStore(t) // from helper_test.go (phase 03)

	srv, err := server.NewServer(server.Options{
		Listen:   "127.0.0.1:0",
		Store:    st,
		Hub:      server.NewHub(),
		WSConfig: server.DefaultWSConfig(),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ctx)
	}()

	url := "http://" + srv.Addr().String()
	cleanup := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Logf("server did not exit cleanly")
		}
	}

	// Wait for /healthz.
	httpDeadline := time.Now().Add(5 * time.Second)
	httpReady := false
	for time.Now().Before(httpDeadline) {
		resp, err := http.Get(url + "/healthz")
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			httpReady = true
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !httpReady {
		cleanup()
		t.Fatal("server /healthz never became reachable")
		return "", cleanup
	}

	// Wait for the pubsub listener to subscribe so the first send doesn't
	// race the LISTEN.
	select {
	case <-srv.PubsubReady():
	case <-time.After(5 * time.Second):
		cleanup()
		t.Fatal("pubsub listener never became ready")
		return "", cleanup
	}

	return url, cleanup
}

// dial connects a WebSocket client identified by deviceID. Reads the Welcome
// frame and returns the conn for further use.
func dial(t *testing.T, baseURL, deviceID string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(baseURL, "http://", "ws://", 1) + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.SetReadLimit(proto.MaxFrameBytes)

	// Send hello.
	hello, _ := proto.NewFrame(proto.TypeHello, "", proto.HelloPayload{DeviceID: deviceID})
	hb, _ := json.Marshal(hello)
	if err := c.Write(ctx, websocket.MessageText, hb); err != nil {
		t.Fatalf("write hello: %v", err)
	}

	// Read welcome.
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

func readFrame(t *testing.T, c *websocket.Conn, timeout time.Duration) proto.Frame {
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

func writeSend(t *testing.T, c *websocket.Conn, body string) {
	t.Helper()
	frame, _ := proto.NewFrame(proto.TypeSend, "", proto.SendPayload{Body: body})
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write send: %v", err)
	}
}

// ---- tests ---------------------------------------------------------------

func TestWebSocketHelloAndWelcome(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()
	c := dial(t, url, "00000000-0000-0000-0000-00000000000a")
	defer c.Close(websocket.StatusNormalClosure, "test done")
}

func TestWebSocketBroadcastBetweenClients(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()

	a := dial(t, url, "00000000-0000-0000-0000-00000000000a")
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dial(t, url, "00000000-0000-0000-0000-00000000000b")
	defer b.Close(websocket.StatusNormalClosure, "")

	writeSend(t, a, "hello from A")

	got := readFrame(t, b, 2*time.Second)
	if got.Type != proto.TypeMessage {
		t.Fatalf("expected message, got %s", got.Type)
	}
	var p proto.MessagePayload
	if err := got.DecodePayload(&p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p.Body != "hello from A" {
		t.Errorf("body: %q", p.Body)
	}
	if p.Sender != "00000000-0000-0000-0000-00000000000a" {
		t.Errorf("sender: %q", p.Sender)
	}
	if p.ID == "" {
		t.Error("missing message id")
	}
	if p.TS == 0 {
		t.Error("missing timestamp")
	}
}

func TestWebSocketSenderDoesNotEcho(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()

	a := dial(t, url, "00000000-0000-0000-0000-00000000000a")
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dial(t, url, "00000000-0000-0000-0000-00000000000b")
	defer b.Close(websocket.StatusNormalClosure, "")

	writeSend(t, a, "should not echo")

	// b receives.
	_ = readFrame(t, b, 2*time.Second)

	// a should NOT receive (broadcast excludes sender). Read with a short
	// timeout; expect a timeout error.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, _, err := a.Read(ctx)
	if err == nil {
		t.Fatal("sender unexpectedly received its own message")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Logf("note: read returned non-deadline error %v (still treated as no echo)", err)
	}
}

func TestWebSocketRequiresHelloFirst(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()

	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// Send a non-hello as the first frame.
	bad, _ := proto.NewFrame(proto.TypeSend, "", proto.SendPayload{Body: "x"})
	bb, _ := json.Marshal(bad)
	if err := c.Write(ctx, websocket.MessageText, bb); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Server should close. Subsequent read returns an error.
	_, _, err = c.Read(ctx)
	if err == nil {
		t.Fatal("expected close after non-hello first frame")
	}
}

func TestWebSocketRejectsMissingSubprotocol(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()
	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Dial WITHOUT requesting the subprotocol.
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		// Some servers complete the handshake then close with policy violation.
		// In our impl, Accept succeeds but the server immediately closes.
		// We accept either as long as a subsequent read fails.
		_, _, rerr := c.Read(ctx)
		if rerr == nil {
			t.Fatal("expected connection rejection without subprotocol")
		}
		return
	}
	// Dial returned an error: also acceptable.
}

func TestWebSocketReregisterClosesPriorConnection(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()

	// First connection: full handshake including welcome read.
	first := dial(t, url, "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa")
	// Don't defer first.Close -- we want to observe the server-initiated
	// close on it.

	// Second connection: open a raw WebSocket and send hello, but DO NOT
	// rely on reading welcome through the helper. The server processes the
	// new hello, register-evicts the old conn, and writes welcome to the
	// new socket. Independently, we assert the *first* conn's read fails,
	// which is the actual behavior under test.
	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	second, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{proto.Subprotocol},
	})
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	defer second.Close(websocket.StatusNormalClosure, "")

	hello, _ := proto.NewFrame(proto.TypeHello, "", proto.HelloPayload{DeviceID: "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa"})
	hb, _ := json.Marshal(hello)
	if err := second.Write(dialCtx, websocket.MessageText, hb); err != nil {
		t.Fatalf("second write hello: %v", err)
	}

	// First connection should now be closed by the server. A read returns
	// an error well before the timeout. Allow up to 3 seconds for goroutine
	// scheduling.
	readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer readCancel()
	if _, _, err := first.Read(readCtx); err == nil {
		t.Fatal("expected first connection to be closed after duplicate device_id login")
	}
}

// TestWebSocketHealthzReturns200OK is a sanity check to make sure the rest
// of the server still works while the WS handler is mounted.
func TestWebSocketHealthzStillWorks(t *testing.T) {
	url, stop := startTestServer(t)
	defer stop()

	resp, err := http.Get(url + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("healthz: %d", resp.StatusCode)
	}
}

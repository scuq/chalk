package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"testing"
	"time"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/version"
)

func quietLogger() *log.Logger {
	return log.New(io.Discard, "", 0)
}

// recvNotice pulls one frame off the conn's send buffer and decodes it as a
// server_notice, failing the test if anything about it is wrong.
func recvNotice(t *testing.T, c *Conn) proto.ServerNoticePayload {
	t.Helper()
	var data []byte
	select {
	case data = <-c.Send:
	case <-time.After(time.Second):
		t.Fatalf("conn %s received no notice", c.ID)
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal frame: %v", err)
	}
	if f.Type != proto.TypeServerNotice {
		t.Fatalf("frame type: got %q, want %q", f.Type, proto.TypeServerNotice)
	}
	if f.Ref != "" {
		t.Fatalf("server push must carry no ref, got %q", f.Ref)
	}
	var p proto.ServerNoticePayload
	if err := f.DecodePayload(&p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return p
}

// Two of the three conns share a device_id. The device-keyed conns map is
// last-writer-wins, so a fan-out that used it would silently skip a tab --
// which is exactly the tab that needs to hear the server is going away.
func TestNotifyRestartingReachesEveryConn(t *testing.T) {
	h := NewHub()
	c1, _ := fakeConnWithID("conn-1", "dev-a")
	c2, _ := fakeConnWithID("conn-2", "dev-a")
	c3, _ := fakeConnWithID("conn-3", "dev-b")
	h.Register(c1)
	h.Register(c2)
	h.Register(c3)

	notifyRestarting(h, quietLogger())

	for _, c := range []*Conn{c1, c2, c3} {
		p := recvNotice(t, c)
		if p.Kind != proto.NoticeRestarting {
			t.Fatalf("conn %s kind: got %q, want %q", c.ID, p.Kind, proto.NoticeRestarting)
		}
		if p.Version != version.Version {
			t.Fatalf("conn %s version: got %q, want %q", c.ID, p.Version, version.Version)
		}
		if p.Commit != version.Commit {
			t.Fatalf("conn %s commit: got %q, want %q", c.ID, p.Commit, version.Commit)
		}
	}
}

// Pins the "serialize once, reuse the bytes" property so a later refactor
// can't quietly move the marshal inside the fan-out loop.
func TestNotifyRestartingMarshalsOnce(t *testing.T) {
	h := NewHub()
	c1, _ := fakeConnWithID("conn-1", "dev-a")
	c2, _ := fakeConnWithID("conn-2", "dev-b")
	h.Register(c1)
	h.Register(c2)

	notifyRestarting(h, quietLogger())

	a, b := <-c1.Send, <-c2.Send
	if len(a) == 0 || len(b) == 0 {
		t.Fatal("empty frame")
	}
	if &a[0] != &b[0] {
		t.Fatal("frame was marshalled per-conn; it should be marshalled once and shared")
	}
}

func TestNotifyRestartingFullBufferDoesNotStarveOthers(t *testing.T) {
	h := NewHub()

	slow, slowCalls := fakeConnWithID("conn-slow", "dev-slow")
	for i := 0; i < sendBufSize; i++ {
		slow.Send <- []byte("fill")
	}
	h.Register(slow)

	fast, _ := fakeConnWithID("conn-fast", "dev-fast")
	h.Register(fast)

	notifyRestarting(h, quietLogger())

	if p := recvNotice(t, fast); p.Kind != proto.NoticeRestarting {
		t.Fatalf("fast kind: got %q", p.Kind)
	}

	// The full conn is closed instead -- the same fate CloseAll delivers a
	// moment later, so nothing is lost by not special-casing it.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && slowCalls.Load() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	if slowCalls.Load() < 1 {
		t.Fatalf("slow conn should have been closed; calls=%d", slowCalls.Load())
	}
}

func TestNotifyRestartingNoConnsIsNoop(t *testing.T) {
	notifyRestarting(NewHub(), quietLogger())
}

func TestHubDrainSendsReturnsWhenBuffersEmpty(t *testing.T) {
	h := NewHub()
	c, _ := fakeConnWithID("conn-1", "dev-a")
	h.Register(c)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	start := time.Now()
	h.DrainSends(ctx)
	if ctx.Err() != nil {
		t.Fatalf("DrainSends waited out the context on an idle hub (%s)", time.Since(start))
	}
}

func TestHubDrainSendsRespectsContext(t *testing.T) {
	h := NewHub()
	c, _ := fakeConnWithID("conn-1", "dev-a")
	c.Send <- []byte("never read")
	h.Register(c)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan struct{})
	go func() {
		h.DrainSends(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("DrainSends hung past its context deadline")
	}
}

// Package server implements chalk's HTTP and WebSocket layers.
//
// The Hub is the per-instance connection registry. It holds one *Conn per
// connected device, and broadcasts incoming messages to everyone except the
// sender. Phase 05 layers Postgres LISTEN/NOTIFY on top so messages crossing
// instances are delivered globally; the hub interface stays the same.
//
// Concurrency model:
//   - A single sync.RWMutex protects the device-id map. Read-heavy workloads
//     (broadcasts) take the read lock; register/unregister take the write lock.
//   - Each *Conn has its own bounded send channel and a dedicated writer
//     goroutine. Broadcast does a non-blocking enqueue: if a connection's
//     send buffer is full (slow client), the connection is closed instead
//     of blocking the broadcaster.
//   - Closing happens exactly once via sync.Once on each *Conn.
//
// Why not channels-only? A pure CSP design (one inbound channel per hub,
// fan out via select) is elegant but every broadcast costs N selects and
// the goroutine-per-connection-writer model already gives us the right
// backpressure semantics with less code. We can revisit if profiling shows
// the mutex contended.
package server

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Hub registers connections and dispatches messages between them.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]*Conn // key: device_id
}

// NewHub constructs an empty Hub.
func NewHub() *Hub {
	return &Hub{conns: make(map[string]*Conn)}
}

// Register adds c to the hub. If a previous connection exists for the same
// device_id, it is asynchronously closed (last-writer-wins). This handles
// the common case of a browser reconnecting before the old socket has been
// reaped.
//
// The prior close runs in a goroutine, not synchronously. This matters
// because Conn.Close ultimately invokes the WebSocket library's Close,
// which may need to coordinate with the connection's own writer goroutine
// to send a close frame. Running it inline could block the caller of
// Register -- which is the ServeHTTP goroutine of the *new* connection,
// in the middle of its own setup. Asynchronous teardown lets the new
// connection's setup proceed without that coupling.
func (h *Hub) Register(c *Conn) {
	h.mu.Lock()
	prev, exists := h.conns[c.DeviceID]
	h.conns[c.DeviceID] = c
	h.mu.Unlock()

	if exists && prev != c {
		go prev.Close(errors.New("superseded by new connection"))
	}
}

// Unregister removes c from the hub if it's still the active connection
// for its device_id. A race-safe Unregister is a no-op if c has already
// been replaced by a newer connection (Register's last-writer-wins).
func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	if cur, ok := h.conns[c.DeviceID]; ok && cur == c {
		delete(h.conns, c.DeviceID)
	}
	h.mu.Unlock()
}

// Get returns the active connection for a device_id, or nil. Mostly used
// by tests; production code prefers Broadcast to avoid races.
func (h *Hub) Get(deviceID string) *Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.conns[deviceID]
}

// Count returns the number of active connections.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// Broadcast enqueues data to every connection except the one with deviceID
// equal to except (typically the sender, to avoid echoing). A nil except
// sends to all.
//
// Broadcast does not block on slow clients: if a connection's send buffer
// is full, the connection is marked for close and skipped. The actual close
// happens out of band so the broadcast loop stays fast.
func (h *Hub) Broadcast(except string, data []byte) {
	// Snapshot conns under the read lock, then release before any enqueue.
	// This keeps the lock held for O(N) only briefly and prevents a slow
	// receiver from holding the lock open.
	h.mu.RLock()
	snap := make([]*Conn, 0, len(h.conns))
	for id, c := range h.conns {
		if id == except {
			continue
		}
		snap = append(snap, c)
	}
	h.mu.RUnlock()

	for _, c := range snap {
		if err := c.Enqueue(data); err != nil {
			// Slow client. Closing here is safe; Conn.Close is idempotent.
			go c.Close(err)
		}
	}
}

// BroadcastFresh is Broadcast with an additional filter: connections
// registered AFTER messageTS are skipped. This prevents stale messages
// from reaching freshly-connected clients via the live feed.
//
// The use case: a NOTIFY for message M arrives at the listener at time T0.
// By the time the listener finishes processing (fetching M from storage,
// building the frame, calling Broadcast), additional connections may have
// joined the hub. Those new connections logically existed *after* M was
// sent and should not receive M as a live broadcast -- they should fetch
// history explicitly if they want past messages. Without this filter,
// slow listener processing produces "phantom" live deliveries of old
// messages to brand-new connections.
//
// Real-app semantics: a user opening a fresh tab should not suddenly
// start receiving messages sent before the tab opened. The live channel
// represents "now and onward"; backfill is a separate concern (phase 08).
//
// messageTS should be the wall-clock timestamp of the message being
// broadcast. Conn.CreatedAt is set at NewConn time.
func (h *Hub) BroadcastFresh(except string, data []byte, messageTS time.Time) {
	h.mu.RLock()
	snap := make([]*Conn, 0, len(h.conns))
	for id, c := range h.conns {
		if id == except {
			continue
		}
		// Skip conns that registered after this message's timestamp.
		// Use !Before rather than After so a tie (same timestamp) still
		// delivers, which is the correct boundary: a conn registered at
		// exactly T0 should see a message sent at T0.
		if c.CreatedAt.After(messageTS) {
			continue
		}
		snap = append(snap, c)
	}
	h.mu.RUnlock()

	for _, c := range snap {
		if err := c.Enqueue(data); err != nil {
			go c.Close(err)
		}
	}
}

// CloseAll terminates every connection. Used during graceful shutdown.
// Returns when all conns have stopped, or when ctx expires.
func (h *Hub) CloseAll(ctx context.Context, reason error) {
	h.mu.Lock()
	snap := make([]*Conn, 0, len(h.conns))
	for _, c := range h.conns {
		snap = append(snap, c)
	}
	h.conns = make(map[string]*Conn)
	h.mu.Unlock()

	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for _, c := range snap {
			wg.Add(1)
			go func(c *Conn) {
				defer wg.Done()
				c.Close(reason)
				c.Wait()
			}(c)
		}
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-ctx.Done():
	}
}

// ---- Conn ----------------------------------------------------------------

// sendBufSize is the per-connection send queue depth. Each item is a fully
// serialized frame, so this is also the per-connection memory ceiling for
// pending sends (sendBufSize * MaxFrameBytes).
const sendBufSize = 64

// ErrSendFull is returned by Enqueue when the connection's send buffer is full.
var ErrSendFull = errors.New("send buffer full")

// Conn is one WebSocket connection. The websocket bits (Read/Write loops,
// ping/pong) are wired in ws.go; this type holds the hub-facing surface so
// the hub doesn't need to know about the WebSocket library.
type Conn struct {
	DeviceID string
	UserID   string

	// Send is the outbound queue. The writer goroutine reads from this
	// channel and pushes frames over the WebSocket. Closed by Close.
	Send chan []byte

	// closeFn is called once when the connection is being torn down. It
	// triggers the WebSocket close and unblocks any read/write loops.
	// Set by ws.go when constructing the Conn.
	closeFn func(error)

	// done is closed when the connection's goroutines have exited. Used by
	// Wait() so callers can synchronize on full teardown.
	done chan struct{}

	closeOnce sync.Once
	closed    chan struct{}

	// CreatedAt is set at construction; useful for logging/metrics.
	CreatedAt time.Time
}

// NewConn builds a Conn with its send buffer and lifecycle channels. closeFn
// is invoked exactly once when Close is called for the first time; it must
// be safe to call from any goroutine.
func NewConn(deviceID, userID string, closeFn func(error)) *Conn {
	return &Conn{
		DeviceID:  deviceID,
		UserID:    userID,
		Send:      make(chan []byte, sendBufSize),
		closeFn:   closeFn,
		done:      make(chan struct{}),
		closed:    make(chan struct{}),
		CreatedAt: time.Now(),
	}
}

// Enqueue tries to push data onto the send buffer. Returns ErrSendFull if
// the buffer is full (slow client), or an error if the connection is closed.
func (c *Conn) Enqueue(data []byte) error {
	select {
	case <-c.closed:
		return errors.New("connection closed")
	default:
	}
	select {
	case c.Send <- data:
		return nil
	case <-c.closed:
		return errors.New("connection closed")
	default:
		return ErrSendFull
	}
}

// Close marks the connection for teardown. Safe to call multiple times and
// from any goroutine. Returns immediately; callers that need to wait for
// goroutines to exit should call Wait afterward.
func (c *Conn) Close(reason error) {
	c.closeOnce.Do(func() {
		close(c.closed)
		if c.closeFn != nil {
			c.closeFn(reason)
		}
	})
}

// Closed reports whether Close has been called.
func (c *Conn) Closed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// MarkDone is called by the WebSocket loops when they've fully exited.
// The Hub's CloseAll uses Wait() to block on this.
func (c *Conn) MarkDone() {
	select {
	case <-c.done:
		// already marked
	default:
		close(c.done)
	}
}

// Wait blocks until the connection's goroutines have exited.
func (c *Conn) Wait() {
	<-c.done
}

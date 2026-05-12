package server

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

// Phase 08b: subscribe_channel handler.
//
// Per-connection topic tracking lives in a sidecar map on WSHandler
// rather than on the Conn struct (no need to touch hub.go). Keyed by
// the *Conn pointer, value is a per-conn slice protected by its own
// mutex. The hello-time loop in ws.go bootstraps this entry; this
// handler appends to it; the disconnect defer in ws.go drains it.
//
// We use the *Conn pointer as the key because (a) it's unique per
// connection (DeviceID can be reused across reconnects), (b) it
// doesn't escape the WSHandler so there's no reference cycle, and
// (c) cleanup on disconnect is one Delete call.

// connSubs is the per-WSHandler tracking map. Keyed by *Conn, value
// is a *connSubEntry holding the lock + slice. Read in ws.go's hello
// path and disconnect defer; written here.
//
// We use sync.Map because the access pattern is "one writer per key
// (the read goroutine of that conn), many keys, no overlap." The
// stdlib map + mutex pattern works too but sync.Map fits the shape.
type connSubEntry struct {
	mu     sync.Mutex
	topics []string
}

// withSubs returns (or lazily creates) the connSubEntry for conn.
// Called from both ws.go's hello path and this file's handler.
func (h *WSHandler) withSubs(conn *Conn) *connSubEntry {
	if v, ok := h.connSubs.Load(conn); ok {
		return v.(*connSubEntry)
	}
	entry := &connSubEntry{}
	actual, _ := h.connSubs.LoadOrStore(conn, entry)
	return actual.(*connSubEntry)
}

// releaseConnSubs is called on disconnect by ws.go. It unsubscribes
// every topic the conn had registered and removes the entry from the
// tracking map. Safe to call multiple times (the slice is drained).
func (h *WSHandler) releaseConnSubs(conn *Conn) {
	v, ok := h.connSubs.LoadAndDelete(conn)
	if !ok {
		return
	}
	entry := v.(*connSubEntry)
	entry.mu.Lock()
	topics := entry.topics
	entry.topics = nil
	entry.mu.Unlock()
	if h.listener == nil {
		return
	}
	for _, t := range topics {
		h.listener.Unsubscribe(t)
	}
}

// handleSubscribeChannel verifies the caller's membership in
// payload.ChannelID, asks the listener to LISTEN on the per-channel
// topic if not already, and acks.
//
// The Subscribe call is refcounted inside the listener, so multiple
// devices for the same user (and across reconnects of the same device)
// share a single LISTEN. The unique work per-conn is the bookkeeping
// in connSubs so that disconnect releases the refcount it added.
func (h *WSHandler) handleSubscribeChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.SubscribeChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if h.listener == nil {
		// Without a listener we can't subscribe. Tell the client; it
		// should fall back to reconnect-after-channel-event.
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no listener configured")
		return
	}

	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot subscribe")
		return
	}
	isMember, mErr := h.store.IsMember(ctx, channelID, callerID)
	if mErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+mErr.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}

	topic := pubsub.ChannelTopic(channelID)

	// Subscribe. The listener refcount makes repeat calls cheap; if
	// this conn already subscribed earlier (e.g. via hello-time loop
	// or a previous subscribe_channel call) it's still cheap. The
	// guard below makes sure we don't double-track in connSubs.
	subCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.listener.Subscribe(subCtx, topic); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "subscribe: "+err.Error())
		return
	}

	// Record on the conn's slice so disconnect releases the refcount.
	// Guard against duplicates: a defensive client may resubscribe;
	// the listener handles it but we shouldn't unsubscribe twice
	// at disconnect (which would push refcount negative -- caught by
	// the listener, but cleaner to avoid).
	entry := h.withSubs(conn)
	entry.mu.Lock()
	already := false
	for _, t := range entry.topics {
		if t == topic {
			already = true
			break
		}
	}
	if !already {
		entry.topics = append(entry.topics, topic)
	}
	entry.mu.Unlock()
	if already {
		// We Subscribed redundantly above (the listener refcount went
		// up by 1 too many). Compensate.
		h.listener.Unsubscribe(topic)
	}

	ack, _ := proto.NewFrame(proto.TypeSubscribeChannelAck, f.Ref,
		proto.SubscribeChannelAckPayload{ChannelID: p.ChannelID})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("subscribe_channel_ack write: %v", err)
	}
}

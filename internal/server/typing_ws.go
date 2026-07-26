package server

// Phase 43-2: typing indicators, inbound half. A client sends a `typing` frame
// while it is composing; we relay it to the channel's other members and forget
// it. Nothing is written to Postgres -- the whole state of the feature lives in
// the receiving clients, where an entry ages out on its own if the typist goes
// quiet.
//
// Two properties shape the code:
//
//   - It is fire-and-forget. There is no ack, and every rejection except a
//     malformed frame is SILENT. An error frame per keystroke window is worse
//     than the ping it polices, and a member removed mid-sentence would
//     otherwise collect one every few seconds.
//   - It is the only frame a client sends without user intent behind each one,
//     so it is the only one that needs a rate limit. The server has none
//     anywhere else, and a full send buffer closes a connection (hub.go), so
//     the throttle runs before any query -- an over-rate client costs one map
//     lookup, not a round trip.

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

const (
	// typingMinInterval is the shortest gap between two accepted pings from
	// one connection for one channel. Deliberately under the client's 3s
	// resend cadence so ordinary jitter never costs a legitimate client a
	// ping.
	typingMinInterval = 2500 * time.Millisecond

	// typingMaxChannels caps a single connection's limiter map. The throttle
	// runs before the membership check -- that is the point of it -- so a
	// hostile client can name channels that don't exist and grow this map
	// unboundedly. See typingLimiter.allow.
	typingMaxChannels = 64

	// typingPublishTimeout bounds the NOTIFY. Handlers run synchronously on
	// the connection's read goroutine and the connection context has no
	// deadline, so a best-effort ephemeral must never be able to wedge a
	// client's reads behind a slow pool.
	typingPublishTimeout = 2 * time.Second
)

// typingLimiter is one connection's per-channel rate state. It holds no store
// and takes its clock as an argument, which is what makes it testable without
// a database or a live WSHandler.
type typingLimiter struct {
	mu   sync.Mutex
	last map[uuid.UUID]time.Time
}

// allow reports whether a ping for channelID is accepted at now, and stamps
// the clock when it is.
//
// The stamp happens ONLY on acceptance. Stamping on rejection too would build
// a rolling window that never opens again under sustained pressure, which
// punishes a legitimate client whose timer runs a little fast rather than the
// spammer it was meant to police. Stamp-on-accept gives everyone exactly one
// accepted ping per interval, forever.
func (t *typingLimiter) allow(channelID uuid.UUID, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.last == nil {
		t.last = make(map[uuid.UUID]time.Time)
	}
	if prev, ok := t.last[channelID]; ok && now.Sub(prev) < typingMinInterval {
		return false
	}
	if len(t.last) >= typingMaxChannels {
		// Only ever reached by a client naming more channels than a person
		// could type in. Drop everything that can no longer block a ping;
		// if that frees nothing, refuse rather than grow.
		for id, at := range t.last {
			if now.Sub(at) >= 2*typingMinInterval {
				delete(t.last, id)
			}
		}
		if len(t.last) >= typingMaxChannels {
			return false
		}
	}
	t.last[channelID] = now
	return true
}

// typingLimiterFor returns (or lazily creates) the limiter for conn, mirroring
// withSubs. Released by releaseTypingState at disconnect.
func (h *WSHandler) typingLimiterFor(conn *Conn) *typingLimiter {
	if v, ok := h.typingLimiters.Load(conn); ok {
		return v.(*typingLimiter)
	}
	actual, _ := h.typingLimiters.LoadOrStore(conn, &typingLimiter{})
	return actual.(*typingLimiter)
}

// releaseTypingState drops conn's limiter. Called from the disconnect defers
// in ServeHTTP, next to releaseConnSubs -- separate from it because that one
// is about LISTEN refcounts and this has nothing to do with them.
func (h *WSHandler) releaseTypingState(conn *Conn) {
	h.typingLimiters.Delete(conn)
}

// handleTyping relays a typing ping to the channel's other members.
//
// Checks run cheapest-and-most-rejecting first, so the frames that cost the
// most to serve are the ones a real client actually sends. Only the two
// decoding failures answer with an error: a correct client cannot produce them
// at keystroke rate, and swallowing them would make a client bug undebuggable.
func (h *WSHandler) handleTyping(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.TypingPayload
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
		return
	}
	// conn.UserID is already resolved from the session cookie at hello time,
	// so unlike handleMarkRead there is no devices lookup to pay for here.
	userID, err := uuid.Parse(conn.UserID)
	if err != nil || userID == uuid.Nil {
		return // anonymous connections have nobody to name
	}
	if !h.typingLimiterFor(conn).allow(channelID, time.Now()) {
		return
	}
	// Membership is checked even though the fanout is member-scoped: without
	// it a non-member could publish to any channel's topic and have every
	// member see them typing in a room they aren't in.
	member, err := h.store.IsMember(ctx, channelID, userID)
	if err != nil {
		h.logger.Printf("typing membership %s: %v", channelID, err)
		return
	}
	if !member {
		return
	}

	pubCtx, cancel := context.WithTimeout(ctx, typingPublishTimeout)
	defer cancel()
	err = pubsub.PublishEphemeral(pubCtx, h.store.Pool, pubsub.Event{
		Kind:         "typing",
		UserID:       userID,
		ChannelID:    channelID,
		ThreadID:     parseThreadID(p.ThreadID),
		SenderConnID: conn.ID,
		InstanceID:   h.instanceID,
	})
	if err != nil {
		h.logger.Printf("publish typing: %v", err)
	}
}

// parseThreadID relays an optional thread id, treating anything unparseable as
// absent. Typing is best-effort: a bad thread id is not worth failing a ping
// that the channel-level indicator ignores anyway.
func parseThreadID(s string) uuid.UUID {
	if s == "" {
		return uuid.Nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

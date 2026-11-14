package server

// 65-4: the Web Push frames -- push_state, push_subscribe and
// push_unsubscribe (internal/proto/push.go).
//
// A subscription belongs to the login session behind the connection, never
// to a user named in the frame. The server refuses the frames on a connection
// without a sealed channel, so the VAPID key and the subscription do not
// cross a path that a TLS-terminating proxy can read. Guests never reach
// this file: dispatchGuestFrame refuses every frame not on its allowlist.

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/coder/websocket"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

// maxPushEndpointLen caps the endpoint URL. The URLs of the push services
// of Apple, Google and Mozilla are below 600 bytes.
const maxPushEndpointLen = 2048

// handlePush answers one push_state, push_subscribe, or push_unsubscribe
// frame. Every answer is an error frame or an ack frame that carries the
// PushStatePayload of the session.
func (h *WSHandler) handlePush(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if _, sealed := innerSessions.Load(c); !sealed {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushUnsealed, "push needs the sealed channel")
		return
	}
	if conn.IsGuest || len(conn.SessionToken) == 0 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushNoSession, "no login session")
		return
	}

	ackType := proto.TypePushStateAck
	switch f.Type {
	case proto.TypePushSubscribe:
		ackType = proto.TypePushSubscribeAck
		if h.push == nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodePushDisabled, "push is disabled on this server")
			return
		}
		var p proto.PushSubscribePayload
		if err := f.DecodePayload(&p); err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
			return
		}
		sub, code, msg := parsePushSubscribe(p, h.push.PublicKey())
		if code != "" {
			h.sendError(ctx, c, f.Ref, code, msg)
			return
		}
		_, err := h.store.UpsertPushSubscription(ctx, conn.SessionToken,
			sub.endpoint, sub.p256dh, sub.auth, sub.scope, h.push.PublicKey())
		if errors.Is(err, store.ErrNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodePushNoSession, "the login session ended")
			return
		}
		if err != nil {
			h.logger.Printf("ws push_subscribe: %v", err)
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store failure")
			return
		}
	case proto.TypePushUnsubscribe:
		ackType = proto.TypePushUnsubscribeAck
		if err := h.store.DeletePushSubscriptionForSession(ctx, conn.SessionToken); err != nil {
			h.logger.Printf("ws push_unsubscribe: %v", err)
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store failure")
			return
		}
	}

	state, err := h.pushState(ctx, conn.SessionToken)
	if err != nil {
		h.logger.Printf("ws %s: %v", f.Type, err)
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store failure")
		return
	}
	frame, _ := proto.NewFrame(ackType, f.Ref, state)
	data, _ := json.Marshal(frame)
	if err := writeOne(ctx, c, data, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ws send %s: %v", ackType, err)
	}
}

// pushState returns the server's view of push for the session behind token.
func (h *WSHandler) pushState(ctx context.Context, token []byte) (proto.PushStatePayload, error) {
	var current string
	if h.push != nil {
		current = h.push.PublicKey()
	}
	sub, err := h.store.GetPushSubscriptionForSession(ctx, token)
	if errors.Is(err, store.ErrNotFound) {
		return pushStatePayload(current, nil), nil
	}
	if err != nil {
		return proto.PushStatePayload{}, err
	}
	return pushStatePayload(current, &sub), nil
}

// pushStatePayload builds the state for the current VAPID key (empty when
// push is disabled) and the session's subscription (nil when it has none).
func pushStatePayload(current string, sub *store.PushSubscription) proto.PushStatePayload {
	st := proto.PushStatePayload{Enabled: current != "", VAPIDPublicKey: current}
	if sub != nil {
		st.Subscribed = true
		st.Endpoint = sub.Endpoint
		st.Scope = string(sub.Scope)
		st.KeyCurrent = current != "" && sub.VAPIDKey == current
	}
	return st
}

// pushSub is a validated push_subscribe payload.
type pushSub struct {
	endpoint string
	p256dh   []byte
	auth     []byte
	scope    store.PushScope
}

// parsePushSubscribe validates p against the current VAPID key. It returns
// the subscription, or an error code and a message.
func parsePushSubscribe(p proto.PushSubscribePayload, current string) (pushSub, string, string) {
	bad := func(msg string) (pushSub, string, string) {
		return pushSub{}, proto.ErrCodeBadPayload, msg
	}
	if strings.TrimRight(p.VAPIDPublicKey, "=") != current {
		return pushSub{}, proto.ErrCodePushKeyStale, "subscribe again with the key from push_state"
	}
	if len(p.Endpoint) > maxPushEndpointLen {
		return bad("endpoint too long")
	}
	if _, err := webpush.ValidateEndpoint(p.Endpoint); err != nil {
		return bad("endpoint must be an https URL")
	}
	p256dh, err := decodeB64URL(p.P256dh)
	if err != nil || len(p256dh) != 65 {
		return bad("p256dh must be a 65-byte P-256 point")
	}
	if _, err := ecdh.P256().NewPublicKey(p256dh); err != nil {
		return bad("p256dh is not a P-256 point")
	}
	auth, err := decodeB64URL(p.Auth)
	if err != nil || len(auth) != 16 {
		return bad("auth must be 16 bytes")
	}
	scope := store.PushScope(p.Scope)
	if !scope.Valid() {
		return bad(`scope must be "dms" or "all"`)
	}
	return pushSub{endpoint: p.Endpoint, p256dh: p256dh, auth: auth, scope: scope}, "", ""
}

// decodeB64URL decodes base64url with or without padding.
func decodeB64URL(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

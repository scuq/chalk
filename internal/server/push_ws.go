package server

// 65-4: the Web Push frames -- push_state, push_subscribe and
// push_unsubscribe (internal/proto/push.go).
// 136-4b: push_subscribe_apns stores the registration of the iOS app.
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

	"github.com/scuq/chalk/internal/apns"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

// maxPushEndpointLen caps the endpoint URL. The URLs of the push services
// of Apple, Google and Mozilla are below 600 bytes.
const maxPushEndpointLen = 2048

// handlePush answers one push_state, push_subscribe, push_subscribe_apns, or
// push_unsubscribe frame. Every answer is an error frame or an ack frame that carries the
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
		_, err := h.store.UpsertPushSubscription(ctx, conn.SessionToken, store.PushKindWebPush,
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
	case proto.TypePushSubscribeAPNs:
		// 136-4b: the same gates as push_subscribe apply, and the frame is
		// not on the guest allowlist. The row holds the device token in
		// lowercase and the key of the APNs sender.
		ackType = proto.TypePushSubscribeAPNsAck
		if h.push == nil || h.apns == nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodePushDisabled, "native push is disabled on this server")
			return
		}
		var p proto.PushSubscribeAPNsPayload
		if err := f.DecodePayload(&p); err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
			return
		}
		sub, code, msg := parsePushSubscribeAPNs(p, h.apns.Topic(), h.apns.Environment())
		if code != "" {
			h.sendError(ctx, c, f.Ref, code, msg)
			return
		}
		_, err := h.store.UpsertPushSubscription(ctx, conn.SessionToken, store.PushKindAPNs,
			sub.endpoint, sub.p256dh, sub.auth, sub.scope, h.apns.Key())
		if errors.Is(err, store.ErrNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodePushNoSession, "the login session ended")
			return
		}
		if err != nil {
			h.logger.Printf("ws push_subscribe_apns: %v", err)
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
		return withAPNs(pushStatePayload(current, nil), h.apns, nil), nil
	}
	if err != nil {
		return proto.PushStatePayload{}, err
	}
	return withAPNs(pushStatePayload(current, &sub), h.apns, &sub), nil
}

// withAPNs adds the APNs fields to st. If push is enabled and sender is not
// nil, it sets APNsTopic and APNsEnvironment. If sub is not nil, it sets Kind.
// For an APNs subscription, it also sets KeyCurrent: true if the sender
// exists and sub was made for its key.
func withAPNs(st proto.PushStatePayload, sender apnsSender, sub *store.PushSubscription) proto.PushStatePayload {
	if st.Enabled && sender != nil {
		st.APNsTopic = sender.Topic()
		st.APNsEnvironment = string(sender.Environment())
	}
	if sub != nil {
		st.Kind = string(sub.Kind)
		if sub.Kind == store.PushKindAPNs {
			st.KeyCurrent = st.APNsTopic != "" && sub.VAPIDKey == sender.Key()
		}
	}
	return st
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

// parsePushSubscribeAPNs checks the payload of push_subscribe_apns against
// the topic and the environment of the server. It returns the parsed
// registration. On failure it returns an error code and a message, and the
// registration is empty. The checks run in this order:
//
//  1. The topic and the environment. A mismatch gives push_apns_mismatch.
//  2. The token, the P-256 point, the 16-byte auth secret, and the scope.
//     A failure gives bad_payload.
//
// The endpoint of the result is the token in lowercase.
func parsePushSubscribeAPNs(p proto.PushSubscribeAPNsPayload, topic string, env apns.Environment) (pushSub, string, string) {
	bad := func(msg string) (pushSub, string, string) {
		return pushSub{}, proto.ErrCodeBadPayload, msg
	}
	if p.Topic != topic || p.Environment != string(env) {
		return pushSub{}, proto.ErrCodePushAPNsMismatch, "this server pushes to another app or environment"
	}
	if err := apns.ValidateToken(p.Token); err != nil {
		return bad("token must be hexadecimal")
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
	return pushSub{endpoint: strings.ToLower(p.Token), p256dh: p256dh, auth: auth, scope: scope}, "", ""
}

// decodeB64URL decodes base64url with or without padding.
func decodeB64URL(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

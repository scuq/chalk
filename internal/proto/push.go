package proto

// Phase 65-4: Web Push frames. They exist only on the WebSocket, inside the
// sealed channel of phase 83, so neither the VAPID public key nor a
// subscription crosses plain HTTP. A guest connection never reaches them.
//
// The server answers every request with a PushStatePayload under the ack type
// of the request, so the page always gets the server's view of its
// subscription.

const (
	// push_state asks for the push settings and the subscription of this
	// connection's session. No payload.
	TypePushState    = "push_state"
	TypePushStateAck = "push_state_ack"

	// push_subscribe stores the browser's subscription for this session,
	// replacing an earlier one. Payload PushSubscribePayload.
	TypePushSubscribe    = "push_subscribe"
	TypePushSubscribeAck = "push_subscribe_ack"

	// push_unsubscribe deletes the subscription of this session. No payload.
	TypePushUnsubscribe    = "push_unsubscribe"
	TypePushUnsubscribeAck = "push_unsubscribe_ack"
)

const (
	// ErrCodePushDisabled: the server sends no push (CHALK_PUSH_ENABLED is
	// off). Only push_subscribe answers with it.
	ErrCodePushDisabled = "push_disabled"
	// ErrCodePushUnsealed: the connection has no sealed channel. The frames
	// carry key material, so the server refuses them on a plaintext connection.
	ErrCodePushUnsealed = "push_unsealed"
	// ErrCodePushNoSession: the session behind the connection ended, for
	// example by logout in another tab.
	ErrCodePushNoSession = "push_no_session"
	// ErrCodePushKeyStale: the browser subscribed with a VAPID key that is
	// not the server's current one. Subscribe again with the key from
	// push_state.
	ErrCodePushKeyStale = "push_key_stale"
)

// PushSubscribePayload is a browser PushSubscription. P256dh and Auth are
// base64url, as PushSubscription.toJSON gives them. VAPIDPublicKey is the
// applicationServerKey the browser subscribed with. Scope is "dms" or "all".
type PushSubscribePayload struct {
	Endpoint       string `json:"endpoint"`
	P256dh         string `json:"p256dh"`
	Auth           string `json:"auth"`
	Scope          string `json:"scope"`
	VAPIDPublicKey string `json:"vapid_public_key"`
}

// PushStatePayload is the server's view of push for one session.
//
// Enabled reports whether the server sends push. VAPIDPublicKey is the key a
// browser must subscribe with, empty when Enabled is false. Subscribed
// reports whether the session has a subscription. Endpoint and Scope describe
// it. KeyCurrent reports whether the browser made that subscription with
// VAPIDPublicKey. A subscription with KeyCurrent false gets no push.
type PushStatePayload struct {
	Enabled        bool   `json:"enabled"`
	VAPIDPublicKey string `json:"vapid_public_key,omitempty"`
	Subscribed     bool   `json:"subscribed"`
	Endpoint       string `json:"endpoint,omitempty"`
	Scope          string `json:"scope,omitempty"`
	KeyCurrent     bool   `json:"key_current"`
}

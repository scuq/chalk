package proto

// Phase 08b adds subscribe_channel: a client-initiated frame that asks
// the server to LISTEN on the per-channel pubsub topic for an
// already-created channel. Needed because the listener's per-channel
// subscriptions are established at hello-time (snapshot of the user's
// channels) and don't pick up channels created mid-session.
//
// Usage flow:
//   1. Client receives channel_event{kind="added"} via chalk_global.
//   2. Client sends subscribe_channel{channel_id} on its WS.
//   3. Server verifies membership, calls listener.Subscribe(topic),
//      acks. After the ack, the client can safely send/receive in
//      the new channel without reconnecting.
//
// Why not auto-subscribe server-side when emitting channel_event:
//   The publishChannelEvent path emits on chalk_global, which lands on
//   the recipient's chalkd via the listener. By the time
//   handleChannelEvent runs, we'd need to find the recipient's *Conn
//   and call listener.Subscribe -- doable, but it adds coupling
//   between the listener's dispatch path and connection lifecycle.
//   Client-initiated keeps the boundary clean and matches the existing
//   pattern (clients ask for what they want).
//
// Disconnect cleanup: ws.go's per-conn subscribedTopics slice extends
// to include topics added by this handler. The defer-unsubscribe loop
// in ServeHTTP unsubscribes everything in that slice on close, so a
// dynamically-added subscription is correctly released.

const (
	// Client → server.
	TypeSubscribeChannel = "subscribe_channel"

	// Server → client.
	TypeSubscribeChannelAck = "subscribe_channel_ack"
)

// SubscribeChannelPayload identifies which channel to start listening
// on. The caller must be a member; the server returns ErrCodeNotAMember
// otherwise.
type SubscribeChannelPayload struct {
	ChannelID string `json:"channel_id"`
}

// SubscribeChannelAckPayload echoes the channel_id back. No additional
// fields; the ack is purely a "done, you can proceed" signal.
type SubscribeChannelAckPayload struct {
	ChannelID string `json:"channel_id"`
}

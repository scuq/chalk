package proto

// 80-7: ephemeral guest-invite frames (docs/PHASE-80-EPHEMERAL.md).
//
// A magic link is minted CLIENT-side: the creator generates the secret,
// derives the lookup, the guest's identity keys and the space-key wrap from
// it, and parks the public halves here. The server never sees the secret --
// only material that is useless without it -- so these frames are plain
// authenticated writes, owner-only, capped by CHALK_EPHEMERAL_MAX_GUESTS and
// the 24 h invite TTL.

const (
	// Client → server.
	TypeEphemeralInviteMint   = "ephemeral_invite_mint"
	TypeEphemeralInviteList   = "ephemeral_invite_list"
	TypeEphemeralInviteRevoke = "ephemeral_invite_revoke"

	// Server → client (acks).
	TypeEphemeralInviteMintAck   = "ephemeral_invite_mint_ack"
	TypeEphemeralInviteListAck   = "ephemeral_invite_list_ack"
	TypeEphemeralInviteRevokeAck = "ephemeral_invite_revoke_ack"
)

// Error codes for the invite lifecycle.
const (
	ErrCodeEphemeralDisabled = "ephemeral_disabled"
	ErrCodeNotEphemeral      = "not_ephemeral"
	ErrCodeGuestLimit        = "guest_limit"
	ErrCodeInviteNotFound    = "invite_not_found"
	ErrCodeInviteExists      = "invite_exists"
)

// EphemeralInviteMintPayload parks one magic link's public material. All byte
// fields are base64 (std), the identity-key convention. The server enforces
// lengths (lookup 16, keys 32/32/64), requires KeyVersion to be the channel's
// CURRENT version (a wrap under a stale version would hand the guest a key
// that opens nothing), and answers with the effective expiry after clamping
// TTLSecs to min(CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS, channel expiry).
type EphemeralInviteMintPayload struct {
	ChannelID   string `json:"channel_id"`
	Lookup      string `json:"lookup"`        // b64, 16 bytes: SHA-256("chalk/join-lookup" || secret)[:16]
	GuestUserID string `json:"guest_user_id"` // reserved by the creator; bound into the wrap AAD
	X25519Pub   string `json:"x25519_pub"`    // b64, 32 bytes, derived from the link secret
	Ed25519Pub  string `json:"ed25519_pub"`   // b64, 32 bytes
	SelfSig     string `json:"self_sig"`      // b64, 64 bytes (Ed25519 over x25519_pub)
	KeyVersion  int    `json:"key_version"`
	WrapSuite   int    `json:"wrap_suite"`
	WrapBlob    string `json:"wrap_blob"` // b64, suite-defined space-key wrap for the guest
	// Label is the creator-facing name for the link ("for Bob"); never shown
	// to the guest. ≤80 chars.
	Label string `json:"label,omitempty"`
	// TTLSecs requests a link lifetime; 0 means the server maximum. Clamped,
	// never refused (unlike the channel TTL there is no surprise here: the
	// ack carries the result).
	TTLSecs int64 `json:"ttl_secs,omitempty"`
}

// EphemeralInviteMintAckPayload confirms the parked invite. The client builds
// the link itself (origin + "/join/" + hex lookup + "#" + secret); the server
// contributes only the clamped expiry.
type EphemeralInviteMintAckPayload struct {
	ChannelID string `json:"channel_id"`
	Lookup    string `json:"lookup"`     // b64, echoed
	ExpiresAt int64  `json:"expires_at"` // unix-millis, after clamping
}

// EphemeralInviteListPayload asks for a channel's invites (owner-only).
type EphemeralInviteListPayload struct {
	ChannelID string `json:"channel_id"`
}

// EphemeralInviteInfo is one row of the list: lifecycle metadata only, no key
// material (the creator already holds the secret; nobody else needs the rest).
type EphemeralInviteInfo struct {
	Lookup      string `json:"lookup"` // b64
	GuestUserID string `json:"guest_user_id"`
	Label       string `json:"label,omitempty"`
	CreatedAt   int64  `json:"created_at"`            // unix-millis
	ExpiresAt   int64  `json:"expires_at"`            // unix-millis
	RedeemedAt  int64  `json:"redeemed_at,omitempty"` // first use; reuse until expiry is allowed
	RevokedAt   int64  `json:"revoked_at,omitempty"`
}

// EphemeralInviteListAckPayload returns the channel's invites, oldest first.
type EphemeralInviteListAckPayload struct {
	ChannelID string                `json:"channel_id"`
	Invites   []EphemeralInviteInfo `json:"invites"`
	// MaxGuests echoes CHALK_EPHEMERAL_MAX_GUESTS so the mint UI can show
	// "3 of 8 links used" without a second knob to sync.
	MaxGuests int `json:"max_guests"`
}

// EphemeralInviteRevokePayload revokes one link (owner-only). Revocation
// blocks future redemption; an already-materialized guest lives until the
// channel expires or an operator purges it.
type EphemeralInviteRevokePayload struct {
	ChannelID string `json:"channel_id"`
	Lookup    string `json:"lookup"` // b64
}

// EphemeralInviteRevokeAckPayload confirms the revocation.
type EphemeralInviteRevokeAckPayload struct {
	ChannelID string `json:"channel_id"`
	Lookup    string `json:"lookup"`
}

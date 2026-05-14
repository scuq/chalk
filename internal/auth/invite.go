package auth

// Phase 09c: invite primitives.
//
// Invites authorize a specific email address to register a chalk
// account during a time-limited window. This file holds:
//
//   - GenerateInviteToken: CSPRNG, 32 bytes
//   - EncodeInviteToken / DecodeInviteToken: base64url for HTTP URLs
//   - InviteTTL: configurable via CHALK_INVITE_TTL_DAYS env, default 4
//   - BuildInviteURL: constructs the /?invite=<token> URL the inviter
//     shares (in addition to the email containing the same URL)

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// InviteTokenSize is the wire-side byte count for a freshly-generated
// token. 32 bytes of CSPRNG output, base64url-encoded to 43 chars
// (without padding). Matches the security margin of the session
// token in 09b.
const InviteTokenSize = 32

// DefaultInviteTTLDays is used when CHALK_INVITE_TTL_DAYS is unset
// or unparseable. Per phase 09 plan section 9. Picked to be long
// enough that a casual user can act on it after a weekend, short
// enough that stale invites don't accumulate.
const DefaultInviteTTLDays = 4

// GenerateInviteToken returns InviteTokenSize random bytes from a
// CSPRNG. Returns an error only on a catastrophic OS-level CSPRNG
// failure, in which case the caller MUST NOT proceed (returning a
// non-random token would defeat the entire invite security model).
func GenerateInviteToken() ([]byte, error) {
	buf := make([]byte, InviteTokenSize)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("generate invite token: %w", err)
	}
	return buf, nil
}

// EncodeInviteToken renders the token in URL-safe base64 without
// padding. Callable on tokens of any length; the canonical input is
// InviteTokenSize bytes producing 43 characters.
func EncodeInviteToken(token []byte) string {
	return base64.RawURLEncoding.EncodeToString(token)
}

// DecodeInviteToken parses a base64url string (with or without
// padding) into raw bytes. Tolerant of both forms because some
// clients re-encode URLs and add padding back.
//
// Errors:
//   - "invalid token shape" if the string is empty or decoding fails
//   - "wrong token length" if the decoded byte count is not
//     InviteTokenSize
func DecodeInviteToken(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("invalid token shape: empty")
	}
	// Try unpadded first (the canonical form); fall back to padded.
	if decoded, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		if len(decoded) != InviteTokenSize {
			return nil, fmt.Errorf("wrong token length: %d", len(decoded))
		}
		return decoded, nil
	}
	if decoded, err := base64.URLEncoding.DecodeString(s); err == nil {
		if len(decoded) != InviteTokenSize {
			return nil, fmt.Errorf("wrong token length: %d", len(decoded))
		}
		return decoded, nil
	}
	return nil, fmt.Errorf("invalid token shape")
}

// InviteTTL returns the configured time-to-live for newly-created
// invites. Reads CHALK_INVITE_TTL_DAYS; falls back to
// DefaultInviteTTLDays for empty/unparseable values.
//
// Bounds: clamped to [1, 60] days to prevent operator typo disasters
// (1-second invites are useless; 1-year invites accumulate stale
// data). The clamp is silent — if you set 90, you get 60.
func InviteTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv("CHALK_INVITE_TTL_DAYS"))
	days := DefaultInviteTTLDays
	if raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err == nil && parsed >= 1 {
			days = parsed
		}
	}
	if days < 1 {
		days = 1
	}
	if days > 60 {
		days = 60
	}
	return time.Duration(days) * 24 * time.Hour
}

// BuildInviteURL constructs the URL an invitee receives via email.
// The SPA detects ?invite=<token> at boot and renders the
// pre-registration screen with the email pre-filled.
//
// baseURL is the chalk deployment's externally-visible origin,
// passed from the http server config (CHALK_PUBLIC_URL or similar).
// Falls back to / + query if baseURL is empty.
func BuildInviteURL(baseURL string, encodedToken string) string {
	q := url.Values{}
	q.Set("invite", encodedToken)
	if baseURL == "" {
		return "/?" + q.Encode()
	}
	// Ensure no double-slash and no trailing slash munging.
	base := strings.TrimRight(baseURL, "/")
	return base + "/?" + q.Encode()
}

// BuildEmailChangeVerifyURL constructs the URL sent to the new email
// address during an email-change ceremony. Same baseURL semantics as
// BuildInviteURL.
func BuildEmailChangeVerifyURL(baseURL string, encodedToken string) string {
	q := url.Values{}
	q.Set("verify_email", encodedToken)
	if baseURL == "" {
		return "/?" + q.Encode()
	}
	base := strings.TrimRight(baseURL, "/")
	return base + "/?" + q.Encode()
}

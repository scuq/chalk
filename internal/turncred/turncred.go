// Package turncred mints time-limited TURN credentials for coturn's
// "use-auth-secret" (TURN REST API) scheme (Phase 30, slice 30-1; design §5).
//
// The scheme: chalkd and coturn share a static secret. chalkd hands a client
//
//	username   = "<unix_expiry>:<user_id>"
//	credential = base64( HMAC_SHA1( secret, username ) )
//
// and coturn, configured with the SAME --static-auth-secret, recomputes the
// HMAC to authenticate the allocation. Credentials expire at <unix_expiry>,
// so a leaked pair is not replayable past its TTL. Everything is stdlib
// (crypto/hmac + crypto/sha1); nothing to vendor.
//
// SHA-1 note: HMAC-SHA1 is what coturn's REST scheme specifies; HMAC's
// security does not rest on SHA-1 collision resistance, and the credential
// only gates RELAY ALLOCATION -- media privacy comes from DTLS-SRTP, which
// coturn relays as ciphertext it cannot read (design §0/§6).
package turncred

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

// ICEServer is one entry of the ice_servers list handed to a client in
// voice_join_ack (30-2), shaped like the WebRTC RTCIceServer dictionary.
// Username/Credential are empty for STUN entries.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Mint returns a TURN REST username/credential pair for userID, valid for ttl
// from now. now is a parameter (not time.Now) so tests are deterministic.
func Mint(secret, userID string, ttl time.Duration, now time.Time) (username, credential string) {
	expiry := now.Add(ttl).Unix()
	username = fmt.Sprintf("%d:%s", expiry, userID)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, credential
}

// ICEServers builds the ice_servers list for a joining client: any STUN URLs
// first (credential-less), then all TURN URLs as ONE entry sharing a single
// freshly-minted credential pair. Empty turnURLs yields a STUN-only list --
// the DEGRADED mode in which most real clients cannot connect (design §0/§5);
// the 30-2 handler logs that condition, this builder just reflects config.
func ICEServers(
	stunURLs, turnURLs []string,
	secret, userID string,
	ttl time.Duration,
	now time.Time,
) []ICEServer {
	out := make([]ICEServer, 0, 2)
	if len(stunURLs) > 0 {
		out = append(out, ICEServer{URLs: stunURLs})
	}
	if len(turnURLs) > 0 {
		user, cred := Mint(secret, userID, ttl, now)
		out = append(out, ICEServer{
			URLs:       turnURLs,
			Username:   user,
			Credential: cred,
		})
	}
	return out
}

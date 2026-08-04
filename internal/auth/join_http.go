package auth

// 80-8: guest magic-link redemption (docs/PHASE-80-EPHEMERAL.md §"The magic
// link"). Two endpoints, both anonymous and per-IP rate-limited:
//
//	GET  /api/join/{lookup} → a stateless HMAC challenge
//	POST /api/join/{lookup} → Ed25519 proof + display name → guest session
//
// The link is https://host/join/<lookup-hex>#<secret>; the fragment never
// reaches the server. The guest re-derives its Ed25519 key from the secret
// and signs the challenge; the server verifies against the key the CREATOR
// parked at mint time. Nothing secret-derived is stored server-side, so a
// database leak yields no redeemable links.
//
// Enumeration: the challenge is answered UNCONDITIONALLY -- for unknown
// lookups it is the same keyed PRF over the same inputs -- so holding a
// lookup without the secret reveals nothing, and the channel's name appears
// only in the post-verification response.
//
// Replay: a challenge is consumed by its first successful redemption; a
// captured redemption body replayed later answers 403. The consumed set is
// in-memory with the challenge's own TTL, matching chalkd's one-instance
// deployment shape (the ceremony cache precedent).

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/scuq/chalk/internal/ratelimit"
	"github.com/scuq/chalk/internal/store"
)

// GuestCookieName is the guest session cookie, deliberately DISTINCT from
// CookieName: a logged-in member clicking a join link must not have their
// real session overwritten by a guest one.
const GuestCookieName = "chalk_guest_session"

const (
	joinChallengeTTL = 2 * time.Minute
	// joinRateLimit bounds challenge+redeem attempts per IP per minute. The
	// endpoints are anonymous, so IP is the only key there is.
	joinRateLimit  = 30
	joinRateWindow = time.Minute
	// guestSessionTTL caps a guest session; RedeemEphemeralInvite clamps it
	// further to the channel's own expiry.
	guestSessionTTL = 24 * time.Hour
)

// joinStoreAPI is the store surface the join endpoints need; *store.Store
// implements it, tests substitute a fake via HTTPDeps.JoinStore.
type joinStoreAPI interface {
	GetEphemeralInvite(ctx context.Context, lookup []byte) (store.EphemeralInvite, error)
	RedeemEphemeralInvite(ctx context.Context, in store.RedeemInput) (store.RedeemedGuest, error)
}

// joinStore resolves the store used by the join endpoints.
func (d *HTTPDeps) joinStore() joinStoreAPI {
	if d.JoinStore != nil {
		return d.JoinStore
	}
	return d.Store
}

// joinState carries the endpoint's process-local state, lazily built on
// first mount.
type joinState struct {
	once    sync.Once
	key     []byte // HMAC key for challenges; per-process, regenerated on restart
	limiter *ratelimit.RateLimiter

	mu       sync.Mutex
	consumed map[string]time.Time // mac-hex -> consumption time
}

func (j *joinState) init() {
	j.once.Do(func() {
		j.key = make([]byte, 32)
		if _, err := rand.Read(j.key); err != nil {
			panic("join: challenge key: " + err.Error()) // OS RNG failure; nothing sane to do
		}
		j.limiter = ratelimit.New(joinRateLimit, joinRateWindow)
		j.consumed = map[string]time.Time{}
	})
}

// challenge = nonce(8) || ts(8, big-endian unix seconds) || HMAC-SHA256(key,
// "chalk/join-challenge" || lookup || nonce || ts). Binding the lookup means
// a challenge fetched for one link cannot answer another; the nonce makes
// every issued challenge distinct, so consuming one cannot collide with a
// second fetch in the same second (two tabs racing the same link).
func (j *joinState) challenge(lookup []byte, ts time.Time) []byte {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		panic("join: challenge nonce: " + err.Error())
	}
	return j.challengeWithNonce(lookup, nonce[:], ts)
}

func (j *joinState) challengeWithNonce(lookup, nonce []byte, ts time.Time) []byte {
	var tsb [8]byte
	binary.BigEndian.PutUint64(tsb[:], uint64(ts.Unix()))
	mac := hmac.New(sha256.New, j.key)
	mac.Write([]byte("chalk/join-challenge"))
	mac.Write(lookup)
	mac.Write(nonce)
	mac.Write(tsb[:])
	out := append([]byte{}, nonce...)
	out = append(out, tsb[:]...)
	return mac.Sum(out)
}

// verify checks a presented challenge for this lookup: shape, freshness, MAC.
func (j *joinState) verify(lookup, challenge []byte, now time.Time) bool {
	if len(challenge) != 16+sha256.Size {
		return false
	}
	ts := time.Unix(int64(binary.BigEndian.Uint64(challenge[8:16])), 0)
	if now.Sub(ts) > joinChallengeTTL || ts.After(now.Add(time.Minute)) {
		return false
	}
	want := j.challengeWithNonce(lookup, challenge[:8], ts)
	return hmac.Equal(challenge, want)
}

// consume marks a challenge used; false when it already was. Prunes expired
// entries in the same pass, so the map stays bounded by the TTL window.
func (j *joinState) consume(challenge []byte, now time.Time) bool {
	key := hex.EncodeToString(challenge[16:])
	j.mu.Lock()
	defer j.mu.Unlock()
	for k, t := range j.consumed {
		if now.Sub(t) > joinChallengeTTL {
			delete(j.consumed, k)
		}
	}
	if _, used := j.consumed[key]; used {
		return false
	}
	j.consumed[key] = now
	return true
}

// SetGuestSessionCookie writes the guest cookie. SameSite=Lax rather than
// Strict: a guest arrives on a cross-site top-level navigation (the link in
// their mail client), and Strict would make every re-click look logged out.
func SetGuestSessionCookie(w http.ResponseWriter, token []byte, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     GuestCookieName,
		Value:    base64.RawURLEncoding.EncodeToString(token),
		Path:     CookiePath,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
		HttpOnly: true,
		Secure:   !IsDevMode(),
		SameSite: http.SameSiteLaxMode,
	})
}

// lookupFromPath decodes the {lookup} path value: 32 hex chars, 16 bytes.
func lookupFromPath(r *http.Request) ([]byte, bool) {
	raw := r.PathValue("lookup")
	if len(raw) != 32 {
		return nil, false
	}
	b, err := hex.DecodeString(raw)
	if err != nil {
		return nil, false
	}
	return b, true
}

// handleJoinChallenge answers GET /api/join/{lookup}. Unconditional: known
// and unknown lookups get byte-for-byte the same treatment.
func (d *HTTPDeps) handleJoinChallenge(w http.ResponseWriter, r *http.Request) {
	if !d.EphemeralEnabled {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	d.join.init()
	if ip := IPFromRequest(r); ip != nil && !d.join.limiter.Allow(ip.String()) {
		d.secLogThrottled("ratelimit|join|"+ip.String(),
			"rate_limited bucket=join ip=%s path=%s", ip, r.URL.Path)
		writeError(w, http.StatusTooManyRequests, "rate_limited", "slow down")
		return
	}
	lookup, ok := lookupFromPath(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_lookup", "malformed join link")
		return
	}
	ch := d.join.challenge(lookup, time.Now().UTC())
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":       base64.StdEncoding.EncodeToString(ch),
		"expires_in_secs": int(joinChallengeTTL.Seconds()),
	})
}

type joinRedeemRequest struct {
	Challenge   string `json:"challenge"`    // b64 std, echoed from GET
	Signature   string `json:"signature"`    // b64 std, Ed25519 over the challenge bytes
	DisplayName string `json:"display_name"` // 1..32 after trim
}

type joinRedeemResponse struct {
	GuestUserID string `json:"guest_user_id"`
	DisplayName string `json:"display_name"`
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	// 82-7: who minted the invite. The guest verifies the wrap's Ed25519
	// signature under this id, against the owner PUBLIC KEY carried in the
	// link fragment (never seen by this server). The id is bound inside the
	// signed message, so lying here fails verification instead of succeeding.
	OwnerUserID      string `json:"owner_user_id"`
	ChannelExpiresAt int64  `json:"channel_expires_at"` // unix-millis
	KeyVersion       int    `json:"key_version"`
	WrapSuite        int    `json:"wrap_suite"`
	WrapBlob         string `json:"wrap_blob"` // b64 std; opens only with the fragment-derived key
	SessionExpiresAt int64  `json:"session_expires_at"`
}

// handleJoinRedeem answers POST /api/join/{lookup}.
func (d *HTTPDeps) handleJoinRedeem(w http.ResponseWriter, r *http.Request) {
	if !d.EphemeralEnabled {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	d.join.init()
	if ip := IPFromRequest(r); ip != nil && !d.join.limiter.Allow(ip.String()) {
		d.secLogThrottled("ratelimit|join|"+ip.String(),
			"rate_limited bucket=join ip=%s path=%s", ip, r.URL.Path)
		writeError(w, http.StatusTooManyRequests, "rate_limited", "slow down")
		return
	}
	lookup, ok := lookupFromPath(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_lookup", "malformed join link")
		return
	}
	var req joinRedeemRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_payload", "malformed body")
		return
	}
	challenge, err := base64.StdEncoding.DecodeString(req.Challenge)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_payload", "challenge not base64")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		writeError(w, http.StatusBadRequest, "bad_payload", "signature malformed")
		return
	}
	name := req.DisplayName
	if n := len([]rune(name)); n < 1 || n > 32 {
		writeError(w, http.StatusBadRequest, "bad_name", "display name must be 1-32 characters")
		return
	}

	now := time.Now().UTC()
	if !d.join.verify(lookup, challenge, now) {
		writeError(w, http.StatusForbidden, "bad_challenge", "challenge invalid or expired; fetch a new one")
		return
	}

	// Unknown lookup and wrong-key signature are DELIBERATELY the same
	// answer: without the parked public key there is nothing to verify
	// against, and 403 here must not confirm an invite's existence.
	inv, err := d.joinStore().GetEphemeralInvite(r.Context(), lookup)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusForbidden, "bad_signature", "signature verification failed")
		return
	}
	if err != nil {
		d.Logger.Printf("join: load invite: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if !ed25519.Verify(ed25519.PublicKey(inv.Ed25519Pub), challenge, sig) {
		writeError(w, http.StatusForbidden, "bad_signature", "signature verification failed")
		return
	}
	// Only a proven secret-holder can consume the challenge, so an attacker
	// cannot burn a challenge they observed but cannot sign.
	if !d.join.consume(challenge, now) {
		writeError(w, http.StatusForbidden, "challenge_replayed", "challenge already used; fetch a new one")
		return
	}

	redeemed, err := d.joinStore().RedeemEphemeralInvite(r.Context(), store.RedeemInput{
		Lookup:      lookup,
		DisplayName: name,
		UserAgent:   UserAgentFromRequest(r),
		IP:          IPFromRequest(r),
		SessionTTL:  guestSessionTTL,
	})
	switch {
	case errors.Is(err, store.ErrInviteRevoked), errors.Is(err, store.ErrInviteExpired):
		writeError(w, http.StatusGone, "invite_gone", "this link has expired or was revoked")
		return
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusForbidden, "bad_signature", "signature verification failed")
		return
	case err != nil:
		d.Logger.Printf("join: redeem: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}

	if redeemed.FirstJoin && d.OnGuestJoined != nil {
		d.OnGuestJoined(redeemed.ChannelID, redeemed.UserID)
	}
	SetGuestSessionCookie(w, redeemed.SessionToken, redeemed.SessionExpiresAt)
	writeJSON(w, http.StatusOK, joinRedeemResponse{
		GuestUserID:      redeemed.UserID.String(),
		DisplayName:      redeemed.DisplayName,
		ChannelID:        redeemed.ChannelID.String(),
		ChannelName:      redeemed.ChannelName,
		OwnerUserID:      redeemed.OwnerUserID.String(),
		ChannelExpiresAt: redeemed.ChannelExpiresAt.UnixMilli(),
		KeyVersion:       redeemed.KeyVersion,
		WrapSuite:        redeemed.WrapSuite,
		WrapBlob:         base64.StdEncoding.EncodeToString(redeemed.WrapBlob),
		SessionExpiresAt: redeemed.SessionExpiresAt.UnixMilli(),
	})
}

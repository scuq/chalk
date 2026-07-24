// chalk -- phase31-slice31-2 pending-2FA token cache.
//
// After the password (or, in 31-3+, passkey) first factor verifies, the
// server issues a short-lived, single-use totp_pending token and issues NO
// session. The client presents that token plus a TOTP code to
// POST /api/auth/login/totp (slice 31-3), which is where the session is
// finally minted. TOTP is mandatory, so no login path skips this bridge.
//
// The token bridges two requests seconds apart, so it lives in memory --
// modelled on CeremonyCache (one-shot Take, TTL). It is deliberately not
// DB-backed: on a server restart an in-flight token is lost and the user
// simply repeats the (cheap) password step. Expiry is enforced at Take time;
// abandoned entries are swept opportunistically on Issue rather than by a
// background janitor, so mounting the handlers starts no goroutines (keeps
// the test harness leak-free).
package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PendingTOTP is one issued-but-unconsumed first-factor pass. Method records
// which first factor was used ("password"; "passkey" in 31-3+), carried
// through so the TOTP step can log/branch on it if needed.
type PendingTOTP struct {
	UserID    uuid.UUID
	Method    string
	ExpiresAt time.Time
}

// DefaultTOTPPendingTTL bounds how long a user has to complete the TOTP step
// after the first factor. A few minutes is ample for typing a 6-digit code.
const DefaultTOTPPendingTTL = 5 * time.Minute

// TOTPPendingTTL reads CHALK_AUTH_TOTP_PENDING_TTL (seconds), defaulting to
// DefaultTOTPPendingTTL. Env-read to match openreg.go's test-friendly pattern.
func TOTPPendingTTL() time.Duration {
	v := strings.TrimSpace(os.Getenv("CHALK_AUTH_TOTP_PENDING_TTL"))
	if v == "" {
		return DefaultTOTPPendingTTL
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return DefaultTOTPPendingTTL
	}
	return time.Duration(n) * time.Second
}

// PendingTOTPCache is a goroutine-safe, TTL-bounded, one-shot cache of pending
// second-factor passes, keyed by an opaque random token.
type PendingTOTPCache struct {
	mu      sync.Mutex
	entries map[string]PendingTOTP
	ttl     time.Duration
	now     func() time.Time // overridable for tests
}

// NewPendingTOTPCache returns an empty cache. Pass zero TTL to use
// TOTPPendingTTL() (which itself falls back to DefaultTOTPPendingTTL).
func NewPendingTOTPCache(ttl time.Duration) *PendingTOTPCache {
	if ttl <= 0 {
		ttl = TOTPPendingTTL()
	}
	return &PendingTOTPCache{
		entries: make(map[string]PendingTOTP),
		ttl:     ttl,
		now:     time.Now,
	}
}

// Issue mints a new random token for userID/method, stores it with the cache
// TTL, and returns the token. It opportunistically prunes expired entries so
// abandoned passes do not accumulate without a background janitor.
func (c *PendingTOTPCache) Issue(userID uuid.UUID, method string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, v := range c.entries { // cheap at our scale
		if now.After(v.ExpiresAt) {
			delete(c.entries, k)
		}
	}
	c.entries[token] = PendingTOTP{
		UserID:    userID,
		Method:    method,
		ExpiresAt: now.Add(c.ttl),
	}
	return token, nil
}

// Take fetches and removes the entry for token. One-shot: a token cannot be
// reused. Returns ErrPendingNotFound if unknown, ErrPendingExpired if present
// but past its TTL (also removed).
func (c *PendingTOTPCache) Take(token string) (PendingTOTP, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[token]
	if !ok {
		return PendingTOTP{}, ErrPendingNotFound
	}
	delete(c.entries, token)
	if c.now().After(e.ExpiresAt) {
		return PendingTOTP{}, ErrPendingExpired
	}
	return e, nil
}

// Len reports the current entry count. Test-only.
func (c *PendingTOTPCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Peek returns the entry for token WITHOUT consuming it, so a wrong
// second factor does not force redoing the first factor. Same errors as
// Take. The caller consumes the token via Take only on success; the
// DB-side lockout bounds guessing.
func (c *PendingTOTPCache) Peek(token string) (PendingTOTP, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[token]
	if !ok {
		return PendingTOTP{}, ErrPendingNotFound
	}
	if c.now().After(e.ExpiresAt) {
		delete(c.entries, token)
		return PendingTOTP{}, ErrPendingExpired
	}
	return e, nil
}

// Errors distinguished so the TOTP handler can return different statuses.
var (
	ErrPendingNotFound = errors.New("auth: pending 2FA token not found")
	ErrPendingExpired  = errors.New("auth: pending 2FA token expired")
)

// chalk -- 81-4 rate limits for the anonymous auth surface.
//
// Every endpoint reachable without a session is a free invitation to spend
// the server's CPU: prelogin and login/password hash, the WebAuthn begin
// endpoints allocate a cached ceremony, v2 signup allocates pending state,
// and the recovery paths run Argon2id at 64 MiB a go. TOTP has a per-account
// lockout, but that is per ACCOUNT -- it does nothing about an anonymous
// caller hammering many usernames, or one username from many directions.
//
// So: a per-IP sliding window in front of each, with the recovery paths on
// their own much tighter budget because they are the expensive ones, plus a
// semaphore that bounds how much memory-hard work can run at once no matter
// how the requests arrive.
//
// The response is deliberately identical for every caller -- same status,
// same body -- so throttling cannot be turned into an oracle for which
// usernames exist.
//
// Per-IP only works if the peer address IS the client. Behind chalkctl's
// Caddy that needs CHALK_TRUSTED_PROXY, which 81-3 generates; without it
// every request resolves to the proxy and this becomes one shared bucket.

package auth

import (
	"net/http"
	"time"

	"github.com/scuq/chalk/internal/ratelimit"
)

const (
	// anonRateLimit bounds the ordinary anonymous auth endpoints per IP per
	// minute. Generous on purpose: a household or office behind one address
	// shares this bucket, and a full sign-in is three requests (prelogin,
	// password, totp).
	anonRateLimit  = 30
	anonRateWindow = time.Minute

	// recoveryRateLimit is much tighter: each well-formed attempt costs an
	// Argon2id pass at 64 MiB. Recovery is a once-in-a-blue-moon action, so
	// a handful a minute is ample for anyone who actually lost their password.
	recoveryRateLimit  = 5
	recoveryRateWindow = time.Minute
)

// initAnonLimiters builds the limiters on first mount.
func (d *HTTPDeps) initAnonLimiters() {
	if d.anonLimiter == nil {
		d.anonLimiter = ratelimit.New(anonRateLimit, anonRateWindow)
	}
	if d.recoveryLimiter == nil {
		d.recoveryLimiter = ratelimit.New(recoveryRateLimit, recoveryRateWindow)
	}
	// 85-1: the throttle in front of the denial log, built here so no
	// request path can find it nil.
	d.initSecurityLog()
}

// limitAnon wraps an anonymous handler in the general per-IP budget.
func (d *HTTPDeps) limitAnon(h http.HandlerFunc) http.HandlerFunc {
	return d.limitBy("anon", func() *ratelimit.RateLimiter { return d.anonLimiter }, h)
}

// limitRecovery wraps the Argon2-heavy recovery handlers in their own budget.
func (d *HTTPDeps) limitRecovery(h http.HandlerFunc) http.HandlerFunc {
	return d.limitBy("recovery", func() *ratelimit.RateLimiter { return d.recoveryLimiter }, h)
}

// limitBy is the shared gate. The limiter is resolved per request rather than
// captured, so mounting order and lazy init cannot leave a nil behind.
//
// 85-1: a denial logs, throttled per (bucket, IP). Silent throttling is the
// hardest kind of production problem to diagnose -- the caller sees a 429 the
// response body deliberately makes uninformative, and until now the server
// kept no record at all that it had ever said no.
func (d *HTTPDeps) limitBy(bucket string, pick func() *ratelimit.RateLimiter, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lim := pick()
		if lim != nil {
			// A nil IP means the peer address was unparseable; there is no
			// key to charge, so let it through rather than block everyone.
			if ip := IPFromRequest(r); ip != nil && !lim.Allow(ip.String()) {
				d.secLogThrottled("ratelimit|"+bucket+"|"+ip.String(),
					"rate_limited bucket=%s ip=%s path=%s", bucket, ip, r.URL.Path)
				writeError(w, http.StatusTooManyRequests, "rate_limited",
					"too many attempts; try again in a minute")
				return
			}
		}
		h(w, r)
	}
}

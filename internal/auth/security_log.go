// chalk -- 85-1 security-event logging for the auth surface.
//
// chalkd used to log authentication only when it broke internally: a failed
// decrypt, a failed session mint. Everything an operator actually wants to see
// -- an account being locked out, a rate limit biting, a login flood against
// one username -- happened silently, and the only trace was the user reporting
// it hours later.
//
// The lines here fix that. Two rules keep them from becoming the next problem:
//
//   - Nothing logs per request. Every event is either rare by construction (a
//     lockout arms once per N failures; a successful login happens once) or
//     goes through secLogThrottled.
//   - The line says what happened, to whom, and from where, and nothing else.
//     No codes, no proofs, no tokens -- a log file is not a place to put
//     material that was secret a moment ago.
package auth

import (
	"net/http"
	"time"

	"github.com/scuq/chalk/internal/ratelimit"
)

// A denied request costs the attacker nothing, so the events they can provoke
// -- rate-limit denials, bad passwords, bad codes -- must not cost the operator
// a line each. One per key per five minutes still shows an attack starting,
// still shows it continuing, and cannot fill a disk.
const (
	secLogPerWindow = 1
	secLogWindow    = 5 * time.Minute
)

// initSecurityLog builds the throttle limiter on mount, alongside the anon
// limiters, so no request path has to check for a nil map.
func (d *HTTPDeps) initSecurityLog() {
	if d.secLogLimiter == nil {
		d.secLogLimiter = ratelimit.New(secLogPerWindow, secLogWindow)
	}
}

// secLog writes one security line. For events that cannot be provoked in a
// loop: a lockout arming, a successful login, an attempt against a blocked
// account.
func (d *HTTPDeps) secLog(format string, args ...any) {
	if !d.SecurityLog || d.Logger == nil {
		return
	}
	d.Logger.Printf("security: "+format, args...)
}

// secLogThrottled is secLog for events whose rate the caller controls. key
// names what is being throttled -- "<event>|<ip>" or "<event>|<user>" -- so a
// flood from one address cannot mask a first offence from another.
func (d *HTTPDeps) secLogThrottled(key, format string, args ...any) {
	if !d.SecurityLog || d.Logger == nil {
		return
	}
	if d.secLogLimiter != nil && !d.secLogLimiter.Allow(key) {
		return
	}
	d.Logger.Printf("security: "+format, args...)
}

// clientIPString renders the request's client IP for a log line, honouring
// CHALK_TRUSTED_PROXY exactly as the rate limiters do. "?" when the peer
// address could not be parsed, which is the same case the limiters let
// through -- worth being able to see in the log rather than guess at.
func clientIPString(r *http.Request) string {
	if ip := IPFromRequest(r); ip != nil {
		return ip.String()
	}
	return "?"
}

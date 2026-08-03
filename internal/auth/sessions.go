package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// Phase 09b sub-step 5: session cookie + middleware helpers.
//
// The cookie carries the opaque session token (32 random bytes,
// base64url-encoded for safe Set-Cookie transport). The token is
// HttpOnly so the SPA cannot read it from JavaScript; the SPA
// discovers identity through GET /api/auth/me which the cookie
// authorizes.
//
// All session minting goes through MintSession, which both creates
// the database row AND writes the Set-Cookie header. All session
// resolution goes through ResolveSession, which reads the cookie,
// looks up the row, and refreshes last_used_at on a successful read.

// CookieName is the chalk session cookie name. Distinct from a
// generic "session" so multiple chalk instances on shared dev hosts
// don't trample each other's cookies via different ports/origins.
const CookieName = "chalk_session"

// CookiePath scopes the cookie to the entire chalk app. We don't
// narrow this to /api because the WS upgrade goes through /ws and
// must see the cookie.
const CookiePath = "/"

// ErrNoSession is returned when no session cookie is present on the
// request (the user hasn't logged in, or the cookie was cleared).
var ErrNoSession = errors.New("auth: no session cookie")

// ErrInvalidSession is returned when a cookie is present but the
// token doesn't decode, doesn't exist in the sessions table, or
// has expired. Maps to 401 from HTTP handlers.
var ErrInvalidSession = errors.New("auth: invalid or expired session")

// SessionUser is the resolved identity for a request. The auth layer
// returns this; downstream handlers consume it. We don't pass the
// raw session token through Context — too easy to leak.
type SessionUser struct {
	UserID      uuid.UUID
	Username    string
	DisplayName string
	Email       string
	Role        string
	Session     store.Session // copy of the session row, without the raw token
}

// MintSession creates a new session row for userID, sets the Set-
// Cookie header on w, and returns the populated Session struct so
// the caller can include session_expires_at in the response body.
//
// userAgent and ip are extracted from the request via the helpers
// in this file. Pass empty strings when unavailable; the columns
// allow NULL.
//
// The Set-Cookie attributes are HttpOnly, Secure (in production),
// and SameSite=Strict. In dev mode (CHALK_DEV=1) Secure is omitted
// so the cookie works over plain HTTP on localhost — browsers
// otherwise reject Secure cookies on http:// origins.
func MintSession(
	ctx context.Context,
	st *store.Store,
	w http.ResponseWriter,
	userID uuid.UUID,
	userAgent string,
	ip net.IP,
) (store.Session, error) {
	sess, err := st.CreateSession(ctx, userID, userAgent, ip)
	if err != nil {
		return store.Session{}, fmt.Errorf("mint session: %w", err)
	}
	setSessionCookie(w, sess.Token, sess.ExpiresAt)
	return sess, nil
}

// ClearSessionCookie writes a Set-Cookie header that deletes the
// chalk session cookie from the browser. The browser deletes a
// cookie by receiving a Set-Cookie with the same Name/Path and an
// Expires in the past. The caller is responsible for any database-
// side cleanup (deleting the row from sessions).
func ClearSessionCookie(w http.ResponseWriter) {
	// MaxAge=-1 tells the browser to delete the cookie. Belt-and-
	// suspenders: also set Expires in the past and an empty value.
	cookie := &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     CookiePath,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   !IsDevMode(),
		SameSite: http.SameSiteStrictMode,
	}
	http.SetCookie(w, cookie)
}

// setSessionCookie writes the Set-Cookie header for a newly minted
// session. Encodes the token with base64url so all bytes survive
// the cookie wire format (header values are 7-bit text).
func setSessionCookie(w http.ResponseWriter, token []byte, expiresAt time.Time) {
	encoded := base64.RawURLEncoding.EncodeToString(token)
	cookie := &http.Cookie{
		Name:     CookieName,
		Value:    encoded,
		Path:     CookiePath,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
		HttpOnly: true,
		Secure:   !IsDevMode(),
		SameSite: http.SameSiteStrictMode,
	}
	http.SetCookie(w, cookie)
}

// SessionTokenFromRequest reads the chalk session cookie from r and
// returns the decoded raw token. Returns ErrNoSession when the
// cookie is absent, or ErrInvalidSession when the encoding is bad.
//
// This is the single source of truth for cookie reading; both the
// HTTP middleware and the WS upgrade path call into it.
func SessionTokenFromRequest(r *http.Request) ([]byte, error) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return nil, ErrNoSession
		}
		return nil, fmt.Errorf("read cookie: %w", err)
	}
	tok, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		return nil, ErrInvalidSession
	}
	if len(tok) != 32 {
		return nil, ErrInvalidSession
	}
	return tok, nil
}

// ResolveSession looks up the session named by the cookie on r,
// confirms it's unexpired, refreshes last_used_at, and returns the
// populated SessionUser. Returns ErrNoSession / ErrInvalidSession
// on the respective failure modes.
//
// The user row is joined in so the caller doesn't have to do a
// second query. Most endpoints want username/display_name/role to
// echo back to the client; doing it in one query keeps the hot
// path simple.
//
// last_used_at is refreshed BEFORE returning so even a panicking
// downstream handler doesn't leave a stale timestamp. The refresh
// is best-effort — a failure to bump the timestamp doesn't fail
// the request.
func ResolveSession(
	ctx context.Context,
	st *store.Store,
	r *http.Request,
) (*SessionUser, error) {
	token, err := SessionTokenFromRequest(r)
	if err != nil {
		return nil, err
	}
	sess, err := st.GetSession(ctx, token)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrInvalidSession
		}
		return nil, fmt.Errorf("get session: %w", err)
	}

	// Refresh last_used_at. Best-effort: log on failure but don't
	// fail the request. The session is valid; a stale timestamp is
	// only a cosmetic issue.
	if err := st.TouchSession(ctx, token); err != nil {
		// Caller's logger isn't accessible from here; the auth
		// HTTP handlers log when they call this and see an
		// unexpected wrap, so we just continue.
		_ = err
	}

	user, err := st.GetUserByID(ctx, sess.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// User was deleted but the session row survived
			// (shouldn't happen with ON DELETE CASCADE, but
			// be defensive). Treat as invalid.
			return nil, ErrInvalidSession
		}
		return nil, fmt.Errorf("get user: %w", err)
	}

	return &SessionUser{
		UserID:      user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Email:       user.Email,
		Role:        user.Role,
		Session:     sess,
	}, nil
}

// RequireSession is a middleware-style wrapper. Resolves the session
// from the request; on success calls next with the SessionUser
// attached to the context; on failure writes a 401 JSON error and
// short-circuits. Used for endpoints that strictly require a logged-
// in user (like /api/auth/me, /api/auth/logout).
//
// Endpoints that *optionally* care about a session (e.g.
// register/begin to know if the user is already logged in) call
// ResolveSession directly and branch on the error.
func RequireSession(
	st *store.Store,
	next func(http.ResponseWriter, *http.Request, *SessionUser),
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		su, err := ResolveSession(r.Context(), st, r)
		if err != nil {
			switch {
			case errors.Is(err, ErrNoSession):
				writeError(w, http.StatusUnauthorized,
					"no_session", "not logged in")
			case errors.Is(err, ErrInvalidSession):
				writeError(w, http.StatusUnauthorized,
					"invalid_session", "session expired or invalid")
			default:
				writeError(w, http.StatusInternalServerError,
					"session_lookup_failed", "internal error")
			}
			return
		}

		// 31-9: hard-cutover gate. Un-enrolled users may only reach the
		// enrollment allowlist; everything else 409s so the SPA routes
		// them into the migration wizard. ErrNotFound = no user_auth row
		// = not enrolled. Lookup errors fail open (log only): the gate is
		// a UX fence, not the security boundary -- the session itself is.
		if AuthV2Required() && !enrollmentExempt(r.URL.Path) {
			ua, uerr := st.GetUserAuth(r.Context(), su.UserID)
			enrolled := uerr == nil && ua.AuthV2Enrolled
			if uerr != nil && !errors.Is(uerr, store.ErrNotFound) {
				enrolled = true // fail open on lookup errors
			}
			if !enrolled {
				writeError(w, http.StatusConflict,
					"auth_v2_enrollment_required",
					"finish setting up password and two-factor sign-in")
				return
			}
		}
		next(w, r, su)
	}
}

// ---- request metadata helpers -----------------------------------------

// UserAgentFromRequest returns the User-Agent header, truncated to
// a reasonable length (some clients send giant UAs that would
// bloat the sessions table).
func UserAgentFromRequest(r *http.Request) string {
	ua := r.Header.Get("User-Agent")
	const max = 512
	if len(ua) > max {
		ua = ua[:max]
	}
	return ua
}

// IPFromRequest extracts the client IP. Honors X-Forwarded-For when the
// PEER is a trusted proxy; otherwise uses RemoteAddr.
//
// 80-8: behind chalkctl's Caddy every request used to resolve to the proxy
// container's address, which turned the join endpoints' per-IP rate limit
// into one bucket for the entire internet. CHALK_TRUSTED_PROXY names the
// proxies chalkd may believe: a comma-separated CIDR list, or the value
// "private" (loopback + RFC1918 + ULA -- the right answer for the stock
// deployment, where Caddy shares a container network with chalkd). When the
// peer matches, the LAST X-Forwarded-For entry wins: that is the one the
// trusted proxy itself appended; anything left of it is client-supplied and
// forgeable. Unset keeps the old behavior (dev mode trusts XFF, production
// trusts nothing).
func IPFromRequest(r *http.Request) net.IP {
	peer := remoteIP(r)
	trustXFF := IsDevMode()
	if !trustXFF && peer != nil {
		trustXFF = trustedProxy(peer)
	}
	if trustXFF {
		if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
			parts := strings.Split(xf, ",")
			// Dev keeps the historical leftmost read (no proxy chain to
			// trust); a configured proxy reads its own appended entry.
			pick := parts[0]
			if !IsDevMode() {
				pick = parts[len(parts)-1]
			}
			if ip := net.ParseIP(strings.TrimSpace(pick)); ip != nil {
				return ip
			}
		}
	}
	return peer
}

func remoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

// trustedProxy reports whether ip is inside CHALK_TRUSTED_PROXY. The env var
// is parsed on every call -- it is two requests per join, not a hot path,
// and re-reading keeps tests and reconfiguration simple.
func trustedProxy(ip net.IP) bool {
	v := strings.TrimSpace(os.Getenv("CHALK_TRUSTED_PROXY"))
	if v == "" {
		return false
	}
	if v == "private" {
		return ip.IsLoopback() || ip.IsPrivate()
	}
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, cidr, err := net.ParseCIDR(part); err == nil {
			if cidr.Contains(ip) {
				return true
			}
			continue
		}
		if pip := net.ParseIP(part); pip != nil && pip.Equal(ip) {
			return true
		}
	}
	return false
}

package auth

import (
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Phase 09b sub-step 5: unit tests for sessions.go cookie helpers,
// session-resolution, and middleware. The DB-touching paths
// (MintSession, ResolveSession-when-cookie-valid) are covered by
// the end-to-end tests in http_test.go which require Postgres. Here
// we only need the no-DB paths: cookie reading, error mapping,
// IP/UA extraction, and the RequireSession middleware's behavior
// when no session exists.
//
// All tests in this file run without CHALK_TEST_DATABASE_URL.

// ---- cookie reading -----------------------------------------------------

func TestSessionTokenFromRequest_NoCookie(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	_, err := SessionTokenFromRequest(r)
	if !errors.Is(err, ErrNoSession) {
		t.Errorf("err = %v, want ErrNoSession", err)
	}
}

func TestSessionTokenFromRequest_BadBase64(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "!!not-base64!!"})
	_, err := SessionTokenFromRequest(r)
	if !errors.Is(err, ErrInvalidSession) {
		t.Errorf("err = %v, want ErrInvalidSession", err)
	}
}

func TestSessionTokenFromRequest_WrongLength(t *testing.T) {
	// A 16-byte token base64url-encodes to 22 chars; passes base64
	// decode but fails the strict 32-byte length check.
	short := make([]byte, 16)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName,
		Value: base64.RawURLEncoding.EncodeToString(short)})
	_, err := SessionTokenFromRequest(r)
	if !errors.Is(err, ErrInvalidSession) {
		t.Errorf("err = %v, want ErrInvalidSession (length %d)", err, len(short))
	}
}

func TestSessionTokenFromRequest_GoodToken(t *testing.T) {
	want := make([]byte, 32)
	for i := range want {
		want[i] = byte(i * 7) // arbitrary non-trivial bytes
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName,
		Value: base64.RawURLEncoding.EncodeToString(want)})
	got, err := SessionTokenFromRequest(r)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(got) != 32 {
		t.Fatalf("len = %d, want 32", len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("byte %d: got %x, want %x", i, got[i], want[i])
		}
	}
}

// ---- ClearSessionCookie ------------------------------------------------

func TestClearSessionCookie_DeletionAttributes(t *testing.T) {
	w := httptest.NewRecorder()
	ClearSessionCookie(w)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != CookieName {
		t.Errorf("Name = %q, want %q", c.Name, CookieName)
	}
	if c.MaxAge >= 0 {
		t.Errorf("MaxAge = %d, want negative", c.MaxAge)
	}
	if !c.HttpOnly {
		t.Errorf("HttpOnly should be true")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite = %v, want SameSiteStrictMode", c.SameSite)
	}
}

func TestClearSessionCookie_DevModeOmitsSecure(t *testing.T) {
	t.Setenv("CHALK_DEV", "1")
	w := httptest.NewRecorder()
	ClearSessionCookie(w)
	c := w.Result().Cookies()[0]
	if c.Secure {
		t.Errorf("Secure should be false in dev mode")
	}
}

func TestClearSessionCookie_ProductionSetsSecure(t *testing.T) {
	t.Setenv("CHALK_DEV", "")
	w := httptest.NewRecorder()
	ClearSessionCookie(w)
	c := w.Result().Cookies()[0]
	if !c.Secure {
		t.Errorf("Secure should be true outside dev mode")
	}
}

// ---- setSessionCookie roundtrip ----------------------------------------

// TestCookieRoundTrip_BinaryToken verifies that a 32-byte token with
// a full byte range survives Set-Cookie → r.Cookie() round-trip
// without losing or corrupting any bytes.
func TestCookieRoundTrip_BinaryToken(t *testing.T) {
	token := make([]byte, 32)
	for i := range token {
		token[i] = byte(i*31 + 13) // varied byte values
	}
	w := httptest.NewRecorder()
	setSessionCookie(w, token, time.Now().Add(24*time.Hour))

	sc := w.Result().Cookies()[0]
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(sc)

	got, err := SessionTokenFromRequest(r)
	if err != nil {
		t.Fatalf("decode round-trip: %v", err)
	}
	if len(got) != 32 {
		t.Fatalf("len = %d, want 32", len(got))
	}
	for i := range token {
		if got[i] != token[i] {
			t.Errorf("byte %d: got %x, want %x", i, got[i], token[i])
		}
	}
}

// ---- UserAgentFromRequest ----------------------------------------------

func TestUserAgentFromRequest_PassThrough(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("User-Agent", "MyClient/1.0 (some/details)")
	if got := UserAgentFromRequest(r); got != "MyClient/1.0 (some/details)" {
		t.Errorf("UA = %q", got)
	}
}

func TestUserAgentFromRequest_Truncates(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	huge := strings.Repeat("x", 5000)
	r.Header.Set("User-Agent", huge)
	got := UserAgentFromRequest(r)
	if len(got) != 512 {
		t.Errorf("UA len = %d, want 512", len(got))
	}
}

func TestUserAgentFromRequest_Missing(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := UserAgentFromRequest(r); got != "" {
		t.Errorf("UA = %q, want empty", got)
	}
}

// ---- IPFromRequest -----------------------------------------------------

func TestIPFromRequest_RemoteAddr(t *testing.T) {
	t.Setenv("CHALK_DEV", "")
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "192.168.1.42:54321"
	got := IPFromRequest(r)
	want := net.ParseIP("192.168.1.42")
	if !got.Equal(want) {
		t.Errorf("IP = %v, want %v", got, want)
	}
}

func TestIPFromRequest_XForwardedFor_DevMode(t *testing.T) {
	t.Setenv("CHALK_DEV", "1")
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
	got := IPFromRequest(r)
	want := net.ParseIP("203.0.113.5")
	if !got.Equal(want) {
		t.Errorf("IP = %v, want %v (dev mode should honor XFF leftmost)", got, want)
	}
}

func TestIPFromRequest_XForwardedFor_IgnoredInProduction(t *testing.T) {
	t.Setenv("CHALK_DEV", "")
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.5")
	got := IPFromRequest(r)
	want := net.ParseIP("10.0.0.1")
	if !got.Equal(want) {
		t.Errorf("IP = %v, want %v (prod mode should ignore XFF)", got, want)
	}
}

func TestIPFromRequest_BadRemoteAddr(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "this-is-not-a-host-port"
	got := IPFromRequest(r)
	if got != nil {
		t.Errorf("IP = %v, want nil for malformed RemoteAddr", got)
	}
}

// ---- RequireSession middleware -----------------------------------------

// The middleware paths we can test without a DB: 401 on no cookie,
// 401 on bad cookie. The happy path is covered in http_test.go.

func TestRequireSession_NoCookieReturns401(t *testing.T) {
	called := false
	handler := RequireSession(nil, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		called = true
	})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	w := httptest.NewRecorder()
	handler(w, r)
	if called {
		t.Error("next handler should not be called")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "no_session") {
		t.Errorf("body should mention 'no_session', got %q", w.Body.String())
	}
}

func TestRequireSession_BadCookieReturns401(t *testing.T) {
	called := false
	handler := RequireSession(nil, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		called = true
	})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "$$bad-base64$$"})
	w := httptest.NewRecorder()
	handler(w, r)
	if called {
		t.Error("next handler should not be called")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid_session") {
		t.Errorf("body should mention 'invalid_session', got %q", w.Body.String())
	}
}

package auth_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/scuq/chalk/internal/auth"
)

// 81-4: the anonymous auth endpoints are the ones an attacker can reach for
// free, so they carry a per-IP budget. What matters is that the throttle
// fires at all, and that it says the same thing regardless of whether the
// username exists -- a limiter that answered differently for real accounts
// would hand back the enumeration oracle the decoy KDF params exist to deny.

// startAnonServer mounts the auth routes with no store-backed users. Every
// request 4xxs on its merits; we only care about the 429 that eventually
// replaces those.
func startAnonServer(t *testing.T) *httptest.Server {
	t.Helper()
	t.Setenv("CHALK_DEV", "1")
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")

	srv := httptest.NewUnstartedServer(nil)
	svc, err := auth.NewService(auth.Config{
		RPID:          testRPID,
		RPDisplayName: testRPName,
		RPOrigins:     []string{"http://" + srv.Listener.Addr().String()},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	_, st := openClaimTestDB(t)
	deps := &auth.HTTPDeps{
		Service: svc,
		Cache:   auth.NewCeremonyCache(time.Minute),
		Store:   st,
	}
	mux := http.NewServeMux()
	if err := deps.MountRegistration(mux); err != nil {
		t.Fatalf("MountRegistration: %v", err)
	}
	srv.Config.Handler = mux
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

func postAnon(t *testing.T, url string, body any) (int, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return resp.StatusCode, ""
	}
	eb, _ := decodeError(resp.Body)
	return resp.StatusCode, eb.Error.Code
}

func TestPreloginIsRateLimited(t *testing.T) {
	srv := startAnonServer(t)
	url := srv.URL + "/api/auth/login/prelogin"

	// The budget is 30/min/IP. Everything from this test shares one address.
	var limited bool
	for i := 0; i < 40; i++ {
		status, code := postAnon(t, url, map[string]any{"username": "nosuchuser"})
		if status == http.StatusTooManyRequests && code == "rate_limited" {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("prelogin never rate-limited after 40 attempts from one address")
	}

	// A known-shaped username must be refused identically once throttled --
	// no new signal about which accounts exist.
	status, code := postAnon(t, url, map[string]any{"username": "alice"})
	if status != http.StatusTooManyRequests || code != "rate_limited" {
		t.Errorf("throttled request for a different username = %d %q, want 429 rate_limited",
			status, code)
	}
}

// TestRecoveryHasATighterBudget pins the separate, smaller allowance on the
// Argon2-heavy paths: they must throttle well before the general one would.
func TestRecoveryHasATighterBudget(t *testing.T) {
	srv := startAnonServer(t)
	url := srv.URL + "/api/auth/recovery/reset-auth"

	attempts := 0
	for i := 0; i < 30; i++ {
		attempts++
		status, code := postAnon(t, url, map[string]any{
			"username": "nosuchuser",
			"phrase":   "not a real phrase",
		})
		if status == http.StatusTooManyRequests && code == "rate_limited" {
			break
		}
	}
	if attempts > 10 {
		t.Errorf("recovery took %d attempts to throttle; its budget should be far tighter"+
			" than the general one (each attempt can cost a 64 MiB Argon2 pass)", attempts)
	}
}

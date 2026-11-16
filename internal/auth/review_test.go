package auth_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/scuq/chalk/internal/auth"
)

// 139-1: review mode. The pure gate tests need no database. The login tests
// need CHALK_TEST_DATABASE_URL, like the step-up tests whose harness they use.

func TestResolveReviewModeGates(t *testing.T) {
	cases := []struct {
		requested, marked bool
		want              bool
		wantErr           error
	}{
		{false, false, false, nil},
		{false, true, false, nil},
		{true, false, false, auth.ErrReviewModeUnmarked},
		{true, true, true, nil},
	}
	for _, c := range cases {
		got, err := auth.ResolveReviewMode(c.requested, c.marked)
		if got != c.want || !errors.Is(err, c.wantErr) {
			t.Errorf("ResolveReviewMode(%v, %v) = %v, %v; want %v, %v",
				c.requested, c.marked, got, err, c.want, c.wantErr)
		}
	}
}

func TestReviewModeRequestedValues(t *testing.T) {
	for v, want := range map[string]bool{
		"": false, "0": false, "false": false, "off": false, "review": false,
		"1": true, "true": true, "YES": true, " on ": true,
	} {
		t.Setenv("CHALK_REVIEW_MODE", v)
		if got := auth.ReviewModeRequested(); got != want {
			t.Errorf("CHALK_REVIEW_MODE=%q: ReviewModeRequested() = %v, want %v", v, got, want)
		}
	}
}

// passwordLogin posts the password step of login from a client with no
// cookies. It returns the response; the caller closes it.
func (e *stepUpEnv) passwordLogin(t *testing.T, proofB64 string) *http.Response {
	t.Helper()
	b, err := json.Marshal(map[string]any{"username": e.username, "auth_proof_b64": proofB64})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(e.srv.URL+"/api/auth/login/password", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST login/password: %v", err)
	}
	return resp
}

func setsSessionCookie(resp *http.Response) bool {
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			return true
		}
	}
	return false
}

// The production guard: without review mode, the password step never gives a
// session.
func TestPasswordLoginAsksForTOTPWithoutReviewMode(t *testing.T) {
	e := setupStepUpEnv(t)
	resp := e.passwordLogin(t, e.proofB64)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login/password = %d, want 200", resp.StatusCode)
	}
	if setsSessionCookie(resp) {
		t.Fatal("login/password set a session cookie without review mode")
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if tok, _ := body["totp_pending"].(string); tok == "" {
		t.Fatalf("login/password body = %v, want a totp_pending token", body)
	}
	if _, ok := body["user_id"]; ok {
		t.Fatalf("login/password body = %v, has user_id without review mode", body)
	}
}

func TestPasswordLoginSkipsTOTPInReviewMode(t *testing.T) {
	e := setupStepUpEnvWith(t, func(d *auth.HTTPDeps) { d.ReviewMode = true })
	resp := e.passwordLogin(t, e.proofB64)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login/password = %d, want 200", resp.StatusCode)
	}
	if !setsSessionCookie(resp) {
		t.Fatal("login/password in review mode set no session cookie")
	}
	var body struct {
		UserID      string `json:"user_id"`
		Username    string `json:"username"`
		TOTPPending string `json:"totp_pending"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.UserID == "" || body.Username != e.username || body.TOTPPending != "" {
		t.Fatalf("login/password body = %+v, want the session answer for %s", body, e.username)
	}
}

func TestReviewModeKeepsThePassword(t *testing.T) {
	e := setupStepUpEnvWith(t, func(d *auth.HTTPDeps) { d.ReviewMode = true })
	wrong := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	status, code := errCodeOf(t, e.passwordLogin(t, wrong))
	if status != http.StatusUnauthorized || code != "invalid_credentials" {
		t.Fatalf("login/password with a wrong password = %d %q, want 401 invalid_credentials",
			status, code)
	}
}

func TestReviewModeKeepsStepUpTOTP(t *testing.T) {
	e := setupStepUpEnvWith(t, func(d *auth.HTTPDeps) { d.ReviewMode = true })
	status, code := errCodeOf(t, e.post(t, "/api/auth/recovery/regenerate", map[string]any{
		"auth_proof_b64": e.proofB64,
	}))
	if status != http.StatusUnauthorized || code != "totp_required" {
		t.Fatalf("regenerate in review mode without a code = %d %q, want 401 totp_required",
			status, code)
	}
}

func TestConfigReportsReviewMode(t *testing.T) {
	for _, on := range []bool{false, true} {
		e := setupStepUpEnvWith(t, func(d *auth.HTTPDeps) { d.ReviewMode = on })
		resp, err := http.Get(e.srv.URL + "/api/auth/config")
		if err != nil {
			t.Fatalf("GET config: %v", err)
		}
		var body struct {
			ReviewMode bool `json:"review_mode"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			t.Fatalf("decode config: %v", err)
		}
		if body.ReviewMode != on {
			t.Errorf("config review_mode = %v, want %v", body.ReviewMode, on)
		}
	}
}

package auth_test

import (
	"bytes"
	"context"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// 81-2: the factor-rotation endpoints must not accept a bare session.
//
// The interesting cases are the two ends: a session with no proof at all must
// be refused, and the initial-enrollment carve-out must still let an account
// with no confirmed authenticator enroll one -- getting that wrong locks
// people out of the migration wizard.
//
// Requires CHALK_TEST_DATABASE_URL like the other end-to-end tests.

// stepUpEnv is one signed-up account plus a client whose jar holds its session.
type stepUpEnv struct {
	srv      *httptest.Server
	client   *http.Client
	pool     *pgxpool.Pool
	username string
	secret   []byte // raw TOTP secret, for producing live codes
	proofB64 string // the account's authProof, as the client would derive it
}

// authProof is the fixed client-derived proof this test signs up with. The
// real client derives it with Argon2id; the server only ever compares it.
var stepUpProof = bytes.Repeat([]byte{3}, 32)

func setupStepUpEnv(t *testing.T) *stepUpEnv {
	t.Helper()
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	st := &store.Store{Pool: pool}

	username := fmt.Sprintf("su%d", time.Now().UnixNano()%1_000_000_000)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(c, `DELETE FROM users WHERE username = $1`, username); err != nil {
			t.Logf("cleanup %s: %v", username, err)
		}
	})

	t.Setenv("CHALK_DEV", "1")
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	t.Setenv("CHALK_AUTH_V2_REQUIRED", "1")
	t.Setenv("CHALK_TOTP_ENC_KEY",
		base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))

	srv := httptest.NewUnstartedServer(nil)
	svc, err := auth.NewService(auth.Config{
		RPID:          testRPID,
		RPDisplayName: testRPName,
		RPOrigins:     []string{"http://" + srv.Listener.Addr().String()},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
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

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	env := &stepUpEnv{
		srv:      srv,
		client:   &http.Client{Jar: jar},
		pool:     pool,
		username: username,
		proofB64: base64.StdEncoding.EncodeToString(stepUpProof),
	}
	env.secret = env.signup(t)
	return env
}

// signup drives the two-leg auth-v2 signup; the jar picks up the session
// cookie that register/v2/finish mints. Returns the raw TOTP secret.
func (e *stepUpEnv) signup(t *testing.T) []byte {
	t.Helper()
	var begun struct {
		SignupToken string `json:"signup_token"`
		SecretB32   string `json:"secret_b32"`
	}
	e.postJSON(t, "/api/auth/register/v2/begin", map[string]any{
		"username": e.username,
		"email":    e.username + "@example.invalid",
	}, &begun)

	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(begun.SecretB32)
	if err != nil {
		t.Fatalf("decode totp secret: %v", err)
	}
	e.postJSON(t, "/api/auth/register/v2/finish", map[string]any{
		"signup_token":   begun.SignupToken,
		"totp_code":      auth.TOTPCodeAt(secret, time.Now()),
		"auth_proof_b64": e.proofB64,
		"salt_b64":       base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 16)),
		"kdf_alg":        1,
		"kdf_mem_kib":    auth.Argon2MemFloorKiB(),
		"kdf_iters":      auth.Argon2ItersFloor(),
		"kdf_par":        auth.Argon2ParFloor(),
	}, nil)
	return secret
}

// postJSON posts body and fatals unless the response is 200. Decodes into out
// when non-nil.
func (e *stepUpEnv) postJSON(t *testing.T, path string, body any, out any) {
	t.Helper()
	resp := e.post(t, path, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		t.Fatalf("POST %s = %d (%s: %s)", path, resp.StatusCode,
			eb.Error.Code, eb.Error.Message)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
}

// post sends body as JSON with the session jar attached. The caller closes.
func (e *stepUpEnv) post(t *testing.T, path string, body any) *http.Response {
	t.Helper()
	var rdr *bytes.Reader
	if body == nil {
		rdr = bytes.NewReader(nil)
	} else {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	return resp
}

// errCodeOf returns the status and error code of a request, closing the body.
func errCodeOf(t *testing.T, resp *http.Response) (int, string) {
	t.Helper()
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return resp.StatusCode, ""
	}
	eb, _ := decodeError(resp.Body)
	return resp.StatusCode, eb.Error.Code
}

// liveCode returns a code for a step in the future, so consecutive
// successful step-ups in one test don't trip the replay guard (which requires
// a strictly increasing step). Within TOTPSkew it still validates against now.
func (e *stepUpEnv) liveCode(offsetSteps int) string {
	return auth.TOTPCodeAt(e.secret, time.Now().Add(time.Duration(offsetSteps)*30*time.Second))
}

func TestStepUpRequiredForRecoveryRegenerate(t *testing.T) {
	e := setupStepUpEnv(t)

	// A bare session -- the exact thing a stolen cookie gives an attacker.
	if status, code := errCodeOf(t, e.post(t, "/api/auth/recovery/regenerate", nil)); //
	status != http.StatusUnauthorized || code != "invalid_credentials" {
		t.Fatalf("regenerate with session only = %d %q, want 401 invalid_credentials",
			status, code)
	}

	// Right session, wrong password.
	if status, code := errCodeOf(t, e.post(t, "/api/auth/recovery/regenerate", map[string]any{
		"auth_proof_b64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)),
		"totp_code":      e.liveCode(0),
	})); status != http.StatusUnauthorized || code != "invalid_credentials" {
		t.Fatalf("regenerate with a wrong password = %d %q, want 401 invalid_credentials",
			status, code)
	}

	// Right password, no second factor.
	if status, code := errCodeOf(t, e.post(t, "/api/auth/recovery/regenerate", map[string]any{
		"auth_proof_b64": e.proofB64,
	})); status != http.StatusUnauthorized || code != "totp_required" {
		t.Fatalf("regenerate without a code = %d %q, want 401 totp_required", status, code)
	}

	// Both: through.
	var ok struct {
		RecoveryWords []string `json:"recovery_words"`
	}
	e.postJSON(t, "/api/auth/recovery/regenerate", map[string]any{
		"auth_proof_b64": e.proofB64,
		"totp_code":      e.liveCode(1),
	}, &ok)
	if len(ok.RecoveryWords) != 24 {
		t.Errorf("regenerate returned %d words, want 24", len(ok.RecoveryWords))
	}
}

func TestStepUpRequiredForTOTPReplacement(t *testing.T) {
	e := setupStepUpEnv(t)

	if status, code := errCodeOf(t, e.post(t, "/api/auth/totp/enroll", nil)); //
	status != http.StatusUnauthorized || code != "invalid_credentials" {
		t.Fatalf("totp/enroll with session only = %d %q, want 401 invalid_credentials",
			status, code)
	}

	var enrolled struct {
		SecretB32 string `json:"secret_b32"`
	}
	e.postJSON(t, "/api/auth/totp/enroll", map[string]any{
		"auth_proof_b64": e.proofB64,
		"totp_code":      e.liveCode(0),
	}, &enrolled)
	if enrolled.SecretB32 == "" {
		t.Error("enroll returned an empty secret")
	}
}

// TestStepUpSkippedForInitialTOTPEnrollment is the carve-out: an account with
// no confirmed authenticator has no second factor to prove, so demanding one
// would strand it. This is the state the migration wizard and a
// reset_totp recovery both leave behind.
func TestStepUpSkippedForInitialTOTPEnrollment(t *testing.T) {
	e := setupStepUpEnv(t)
	c := context.Background()

	if _, err := e.pool.Exec(c,
		`UPDATE user_auth SET totp_secret_enc = NULL, totp_confirmed_at = NULL
		  WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
		e.username,
	); err != nil {
		t.Fatalf("clear totp: %v", err)
	}

	// Password still proves who you are; no code is asked for.
	var enrolled struct {
		SecretB32 string `json:"secret_b32"`
	}
	e.postJSON(t, "/api/auth/totp/enroll", map[string]any{
		"auth_proof_b64": e.proofB64,
	}, &enrolled)
	if enrolled.SecretB32 == "" {
		t.Error("initial enrollment returned an empty secret")
	}
}

func TestStepUpRequiredForAddPasskey(t *testing.T) {
	e := setupStepUpEnv(t)

	if status, code := errCodeOf(t, e.post(t, "/api/auth/passkeys/add/begin", nil)); //
	status != http.StatusUnauthorized || code != "invalid_credentials" {
		t.Fatalf("passkeys/add/begin with session only = %d %q, want 401 invalid_credentials",
			status, code)
	}

	resp := e.post(t, "/api/auth/passkeys/add/begin", map[string]any{
		"auth_proof_b64": e.proofB64,
		"totp_code":      e.liveCode(0),
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		t.Fatalf("passkeys/add/begin with step-up = %d (%s: %s)",
			resp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
}

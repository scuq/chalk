package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	virtualwebauthn "github.com/descope/virtualwebauthn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// HTTP-level tests for the registration endpoints.
//
// Two flavors:
//
//   - "table" tests run without a database: they call handlers directly,
//     pass nil where the handler doesn't reach (for example, the
//     /api/auth/config handler reads only Service config). These test
//     wire shape and validation.
//
//   - "registration" runs an end-to-end ceremony against a real
//     Postgres if CHALK_TEST_DATABASE_URL is set. Uses
//     descope/virtualwebauthn to play the authenticator role
//     (generates real ECDSA keypairs, signs the challenge, builds the
//     CBOR attestation). Skips otherwise so `go test ./...` works
//     without external infrastructure.

const testRPID = "localhost"
const testRPName = "chalk-test"
const testOrigin = "http://localhost:8443"

func newTestService(t *testing.T) *auth.Service {
	t.Helper()
	svc, err := auth.NewService(auth.Config{
		RPID:          testRPID,
		RPDisplayName: testRPName,
		RPOrigins:     []string{testOrigin},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return svc
}

// ---- Config handler ----------------------------------------------------

func TestConfigHandlerShape(t *testing.T) {
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	t.Setenv("CHALK_DEV", "")
	deps := &auth.HTTPDeps{
		Service: newTestService(t),
		Cache:   auth.NewCeremonyCache(0),
		// Store deliberately nil: config handler must not touch it.
	}
	// We can't call MountRegistration with a nil Store (it refuses),
	// but we can construct a tiny mux just for /config to confirm the
	// handler doesn't crash without a store.
	mux := http.NewServeMux()
	deps.Store = &store.Store{} // empty shell — config never dereferences it
	if err := deps.MountRegistration(mux); err != nil {
		t.Fatalf("MountRegistration: %v", err)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/auth/config")
	if err != nil {
		t.Fatalf("GET /api/auth/config: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	var body struct {
		RPID              string `json:"rp_id"`
		RPName            string `json:"rp_name"`
		OpenRegistration  bool   `json:"open_registration"`
		DevMode           bool   `json:"dev_mode"`
		RecoveryWordCount int    `json:"recovery_word_count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.RPID != testRPID {
		t.Errorf("rp_id = %q", body.RPID)
	}
	if body.RPName != testRPName {
		t.Errorf("rp_name = %q", body.RPName)
	}
	if !body.OpenRegistration {
		t.Error("open_registration should be true (env set)")
	}
	if body.DevMode {
		t.Error("dev_mode should be false")
	}
	if body.RecoveryWordCount != auth.RecoveryWordCount {
		t.Errorf("recovery_word_count = %d, want %d", body.RecoveryWordCount, auth.RecoveryWordCount)
	}
}

// ---- Validation tests (no DB) -----------------------------------------

func TestRegisterBeginRejectsBadInput(t *testing.T) {
	// We don't reach the store with these requests; nil Store is OK
	// because the validation gates fire before the DB lookup.
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	deps := newDepsNoStore(t)
	srv := httptest.NewServer(mountForTest(t, deps))
	defer srv.Close()

	cases := []struct {
		name    string
		body    map[string]any
		want    int
		wantSub string
	}{
		{
			"missing username",
			map[string]any{"email": "a@b.com"},
			http.StatusBadRequest,
			"bad_username",
		},
		{
			"bad username shape",
			map[string]any{"username": "Hyphen-Bad", "email": "a@b.com"},
			http.StatusBadRequest,
			"bad_username",
		},
		{
			"reserved username",
			map[string]any{"username": "admin", "email": "a@b.com"},
			http.StatusConflict,
			"username_reserved",
		},
		{
			"missing email",
			map[string]any{"username": "alice"},
			http.StatusBadRequest,
			"bad_email",
		},
		{
			"bad email",
			map[string]any{"username": "alice", "email": "no-at-sign"},
			http.StatusBadRequest,
			"bad_email",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, _ := json.Marshal(c.body)
			resp, err := http.Post(srv.URL+"/api/auth/register/begin",
				"application/json", bytes.NewReader(b))
			if err != nil {
				t.Fatalf("POST: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != c.want {
				t.Errorf("status = %d, want %d", resp.StatusCode, c.want)
			}
			body, _ := decodeError(resp.Body)
			if !strings.Contains(body.Error.Code, c.wantSub) {
				t.Errorf("error code = %q, want substring %q", body.Error.Code, c.wantSub)
			}
		})
	}
}

func TestRegisterBeginClosedMode(t *testing.T) {
	t.Setenv("CHALK_OPEN_REGISTRATION", "0")
	deps := newDepsNoStore(t)
	srv := httptest.NewServer(mountForTest(t, deps))
	defer srv.Close()

	// No invite token, closed mode: rejected as registration_closed.
	body, _ := json.Marshal(map[string]any{
		"username": "alice",
		"email":    "alice@example.invalid",
	})
	resp, err := http.Post(srv.URL+"/api/auth/register/begin",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
	eb, _ := decodeError(resp.Body)
	if eb.Error.Code != "registration_closed" {
		t.Errorf("error code = %q, want registration_closed", eb.Error.Code)
	}
}

func TestRegisterBeginClosedModeWithToken(t *testing.T) {
	// Sub-step 3: invite tokens are accepted-but-unimplemented; any
	// non-empty token returns the placeholder rejection.
	t.Setenv("CHALK_OPEN_REGISTRATION", "0")
	deps := newDepsNoStore(t)
	srv := httptest.NewServer(mountForTest(t, deps))
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"invite_token": "anything",
		"username":     "alice",
		"email":        "alice@example.invalid",
	})
	resp, err := http.Post(srv.URL+"/api/auth/register/begin",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
	eb, _ := decodeError(resp.Body)
	if !strings.Contains(eb.Error.Message, "09c") {
		t.Errorf("expected 09c marker in message, got: %q", eb.Error.Message)
	}
}

func TestRegisterFinishMissingChallenge(t *testing.T) {
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	deps := newDepsNoStore(t)
	srv := httptest.NewServer(mountForTest(t, deps))
	defer srv.Close()

	// Garbage credential: not valid base64-encoded JSON for go-webauthn
	// to parse. The handler should reject with 400 + parse_failed, not
	// crash, not reach the cache. This is a smoke test that the parse
	// path is gated and returns clean errors.
	body, _ := json.Marshal(map[string]any{
		"credential": json.RawMessage(`"this-is-not-a-valid-webauthn-credential"`),
	})
	resp, err := http.Post(srv.URL+"/api/auth/register/finish",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

// ---- End-to-end registration (requires PG) ----------------------------

func TestRegisterEndToEnd(t *testing.T) {
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	st := &store.Store{Pool: pool}

	// Clean any prior test user so the run is deterministic.
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE username = $1`, "e2etestuser"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	t.Setenv("CHALK_OPEN_REGISTRATION", "1")

	// We need the Service configured with httptest's URL as its
	// RPOrigin BEFORE the server starts handling requests, because
	// go-webauthn verifies the origin on every finish call.
	// NewUnstartedServer reserves a port without starting the
	// accept loop, so we can read .URL, construct the service, mount,
	// and only then Start().
	srv := httptest.NewUnstartedServer(nil)
	addr := srv.Listener.Addr().String()
	originURL := "http://" + addr

	svc, err := auth.NewService(auth.Config{
		RPID:          testRPID,
		RPDisplayName: testRPName,
		RPOrigins:     []string{originURL},
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
	defer srv.Close()

	// Set up the virtualwebauthn authenticator + credential.
	rp := virtualwebauthn.RelyingParty{
		Name:   testRPName,
		ID:     testRPID,
		Origin: srv.URL,
	}
	vAuth := virtualwebauthn.NewAuthenticator()
	vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	// Step 1: /api/auth/register/begin
	beginBody, _ := json.Marshal(map[string]any{
		"username":     "e2etestuser",
		"display_name": "E2E Test",
		"email":        "e2etestuser@example.invalid",
	})
	beginResp, err := http.Post(srv.URL+"/api/auth/register/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("begin POST: %v", err)
	}
	defer beginResp.Body.Close()
	if beginResp.StatusCode != http.StatusOK {
		body, _ := decodeError(beginResp.Body)
		t.Fatalf("begin status = %d (%s: %s)",
			beginResp.StatusCode, body.Error.Code, body.Error.Message)
	}
	var beginOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(beginResp.Body).Decode(&beginOut); err != nil {
		t.Fatalf("decode begin: %v", err)
	}

	// Step 2: virtualwebauthn parses the options and crafts an
	// attestation response.
	parsedOpts, err := virtualwebauthn.ParseAttestationOptions(string(beginOut.Options))
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	attResp := virtualwebauthn.CreateAttestationResponse(rp, vAuth, vCred, *parsedOpts)

	// Step 3: /api/auth/register/finish
	finishBody, _ := json.Marshal(map[string]any{
		"credential": json.RawMessage(attResp),
	})
	finishResp, err := http.Post(srv.URL+"/api/auth/register/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("finish POST: %v", err)
	}
	defer finishResp.Body.Close()
	if finishResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(finishResp.Body)
		t.Fatalf("finish status = %d (%s: %s)",
			finishResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var finishOut struct {
		UserID        string   `json:"user_id"`
		Username      string   `json:"username"`
		DisplayName   string   `json:"display_name"`
		RecoveryWords []string `json:"recovery_words"`
	}
	if err := json.NewDecoder(finishResp.Body).Decode(&finishOut); err != nil {
		t.Fatalf("decode finish: %v", err)
	}
	if finishOut.Username != "e2etestuser" {
		t.Errorf("username = %q", finishOut.Username)
	}
	if len(finishOut.RecoveryWords) != auth.RecoveryWordCount {
		t.Errorf("len(recovery_words) = %d, want %d",
			len(finishOut.RecoveryWords), auth.RecoveryWordCount)
	}
	// Cache-Control must be no-store on the finish response.
	if cc := finishResp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q; expected no-store", cc)
	}

	// Step 4: verify rows landed in PG.
	var userCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM users WHERE username = $1`, "e2etestuser",
	).Scan(&userCount); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if userCount != 1 {
		t.Errorf("expected 1 user row, got %d", userCount)
	}
	var passkeyCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM passkeys p
		 JOIN users u ON u.id = p.user_id
		 WHERE u.username = $1`, "e2etestuser",
	).Scan(&passkeyCount); err != nil {
		t.Fatalf("count passkeys: %v", err)
	}
	if passkeyCount != 1 {
		t.Errorf("expected 1 passkey row, got %d", passkeyCount)
	}
	var recoveryCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recovery_codes rc
		 JOIN users u ON u.id = rc.user_id
		 WHERE u.username = $1`, "e2etestuser",
	).Scan(&recoveryCount); err != nil {
		t.Fatalf("count recovery codes: %v", err)
	}
	if recoveryCount != 1 {
		t.Errorf("expected 1 recovery_codes row, got %d", recoveryCount)
	}

	// Step 5: verify the recovery hash actually verifies against the
	// returned words. This proves the words we sent back are the
	// same that got hashed.
	var hash []byte
	if err := pool.QueryRow(ctx,
		`SELECT hash FROM recovery_codes rc
		 JOIN users u ON u.id = rc.user_id
		 WHERE u.username = $1`, "e2etestuser",
	).Scan(&hash); err != nil {
		t.Fatalf("fetch hash: %v", err)
	}
	if err := auth.VerifyRecoveryCodeHash(hash, finishOut.RecoveryWords); err != nil {
		t.Errorf("recovery hash does not verify against returned words: %v", err)
	}

	// Final cleanup.
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE username = $1`, "e2etestuser"); err != nil {
		t.Logf("cleanup: %v", err)
	}
}

// ---- helpers -----------------------------------------------------------

func newDepsNoStore(t *testing.T) *auth.HTTPDeps {
	t.Helper()
	return &auth.HTTPDeps{
		Service: newTestService(t),
		Cache:   auth.NewCeremonyCache(time.Minute),
		Store:   &store.Store{}, // empty shell; validation gates fire first
	}
}

func mountForTest(t *testing.T, d *auth.HTTPDeps) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	if err := d.MountRegistration(mux); err != nil {
		t.Fatalf("MountRegistration: %v", err)
	}
	return mux
}

type errBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func decodeError(r interface {
	Read(p []byte) (n int, err error)
}) (errBody, error) {
	var b errBody
	err := json.NewDecoder(r).Decode(&b)
	return b, err
}

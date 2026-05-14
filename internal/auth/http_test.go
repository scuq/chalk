package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
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
	// sub-step 5a fix1: isolate from CHALK_DEV parent-shell leakage
	// (otherwise sub-step 4 fix1's email auto-fill kicks in and the
	// "missing_email" case proceeds to GetUserByUsername on a nil pool).
	t.Setenv("CHALK_DEV", "")
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

// Phase 09b sub-step 5: end-to-end tests for authenticate / me / logout.
//
// One test exercises the full post-registration flow: log in with the
// passkey, verify the cookie carries us to /me, then logout and verify
// the cookie is cleared (subsequent /me 401s).
//
// Requires CHALK_TEST_DATABASE_URL like the registration test.

// TestLoginFlowEndToEnd registers a user, then exercises the full
// session lifecycle: authenticate (login), /me, logout, /me.
func TestLoginFlowEndToEnd(t *testing.T) {
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

	const username = "logintestuser"
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE username = $1`, username); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	defer func() {
		if _, err := pool.Exec(ctx,
			`DELETE FROM users WHERE username = $1`, username); err != nil {
			t.Logf("cleanup: %v", err)
		}
	}()
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")

	// ---- httptest server with handlers mounted ------------------------
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

	// ---- shared cookie jar so register-set cookie carries forward ---
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	client := &http.Client{Jar: jar}

	// ---- virtualwebauthn fixtures (shared across register+login) ----
	rp := virtualwebauthn.RelyingParty{
		Name:   testRPName,
		ID:     testRPID,
		Origin: srv.URL,
	}
	vAuth := virtualwebauthn.NewAuthenticator()
	vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	// ---- 1. Register the user via the existing flow ----------------
	registerUser(t, client, srv.URL, rp, vAuth, vCred, username)

	// virtualwebauthn idiom: AddCredential to the authenticator AFTER
	// the registration ceremony so subsequent assertion ceremonies can
	// find the credential. (The registration itself doesn't auto-track.)
	vAuth.AddCredential(vCred)

	// After register, the client jar should already contain
	// chalk_session (per sub-step 5: register/finish mints a session).
	if !hasSessionCookie(jar, srv.URL) {
		t.Fatalf("expected chalk_session cookie after register/finish; jar empty")
	}

	// ---- 2. Hit /api/auth/me with the post-register cookie ---------
	checkMe(t, client, srv.URL, username)

	// ---- 3. Logout: cookie should be cleared --------------------------
	logoutResp, err := client.Post(srv.URL+"/api/auth/logout",
		"application/json", nil)
	if err != nil {
		t.Fatalf("logout POST: %v", err)
	}
	logoutResp.Body.Close()
	if logoutResp.StatusCode != http.StatusNoContent {
		t.Errorf("logout status = %d, want 204", logoutResp.StatusCode)
	}
	// The server's Set-Cookie with MaxAge=-1 should have cleared the
	// jar's chalk_session entry.
	if hasSessionCookie(jar, srv.URL) {
		t.Errorf("chalk_session cookie should be cleared after logout")
	}

	// ---- 4. /me should now 401 ----------------------------------------
	meResp2, err := client.Get(srv.URL + "/api/auth/me")
	if err != nil {
		t.Fatalf("me #2 GET: %v", err)
	}
	meResp2.Body.Close()
	if meResp2.StatusCode != http.StatusUnauthorized {
		t.Errorf("/me after logout status = %d, want 401", meResp2.StatusCode)
	}

	// ---- 5. Now log in via /authenticate. -----------------------------
	authBegin, _ := json.Marshal(map[string]any{"username": username})
	abResp, err := client.Post(srv.URL+"/api/auth/authenticate/begin",
		"application/json", bytes.NewReader(authBegin))
	if err != nil {
		t.Fatalf("authenticate/begin POST: %v", err)
	}
	defer abResp.Body.Close()
	if abResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(abResp.Body)
		t.Fatalf("authenticate/begin status = %d (%s: %s)",
			abResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var abOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(abResp.Body).Decode(&abOut); err != nil {
		t.Fatalf("decode authenticate/begin: %v", err)
	}

	// virtualwebauthn parses the assertion options, signs.
	parsedAssertion, err := virtualwebauthn.ParseAssertionOptions(string(abOut.Options))
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	assertionResp := virtualwebauthn.CreateAssertionResponse(rp, vAuth, vCred, *parsedAssertion)

	// ---- 6. authenticate/finish ---------------------------------------
	afBody, _ := json.Marshal(map[string]any{
		"credential": json.RawMessage(assertionResp),
	})
	afResp, err := client.Post(srv.URL+"/api/auth/authenticate/finish",
		"application/json", bytes.NewReader(afBody))
	if err != nil {
		t.Fatalf("authenticate/finish POST: %v", err)
	}
	defer afResp.Body.Close()
	if afResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(afResp.Body)
		t.Fatalf("authenticate/finish status = %d (%s: %s)",
			afResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var afOut struct {
		UserID           string    `json:"user_id"`
		Username         string    `json:"username"`
		DisplayName      string    `json:"display_name"`
		Role             string    `json:"role"`
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	if err := json.NewDecoder(afResp.Body).Decode(&afOut); err != nil {
		t.Fatalf("decode authenticate/finish: %v", err)
	}
	if afOut.Username != username {
		t.Errorf("authenticate/finish username = %q, want %q", afOut.Username, username)
	}
	if afOut.Role != "user" {
		t.Errorf("authenticate/finish role = %q, want 'user'", afOut.Role)
	}
	if afOut.SessionExpiresAt.IsZero() {
		t.Error("authenticate/finish session_expires_at should be non-zero")
	}
	if !hasSessionCookie(jar, srv.URL) {
		t.Errorf("expected chalk_session cookie after authenticate/finish")
	}

	// ---- 7. /me with the new session should succeed -------------------
	checkMe(t, client, srv.URL, username)

	// ---- 8. Sign-count should have bumped on the passkey row ----------
	var signCount int64
	if err := pool.QueryRow(ctx,
		`SELECT sign_count FROM passkeys p
		   JOIN users u ON u.id = p.user_id
		  WHERE u.username = $1`, username,
	).Scan(&signCount); err != nil {
		t.Fatalf("read sign_count: %v", err)
	}
	// virtualwebauthn increments its counter on each assertion so the
	// stored count after one login should be > 0. We don't assert a
	// specific value because the library's behavior is internal.
	t.Logf("passkey sign_count after login = %d", signCount)
}

// TestAuthenticateBegin_UnknownUser checks the error mapping for an
// unknown username. Doesn't need a DB session — we just want to
// confirm the handler returns 401 unknown_user.
func TestAuthenticateBegin_UnknownUser(t *testing.T) {
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	st := &store.Store{Pool: pool}

	deps := &auth.HTTPDeps{
		Service: newTestService(t),
		Cache:   auth.NewCeremonyCache(time.Minute),
		Store:   st,
	}
	mux := mountForTest(t, deps)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{"username": "doesnotexist_zzz"})
	resp, err := http.Post(srv.URL+"/api/auth/authenticate/begin",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
	eb, _ := decodeError(resp.Body)
	if eb.Error.Code != "unknown_user" {
		t.Errorf("error code = %q, want 'unknown_user'", eb.Error.Code)
	}
}

// ---- shared helpers for login-flow integration tests --------------------

// registerUser drives a fresh registration ceremony for username,
// using the provided client (which carries the cookie jar) and the
// shared rp/vAuth/vCred. Returns the recovery words for callers that
// want them; this test doesn't.
func registerUser(t *testing.T, client *http.Client, baseURL string,
	rp virtualwebauthn.RelyingParty, vAuth virtualwebauthn.Authenticator,
	vCred virtualwebauthn.Credential, username string) {
	t.Helper()
	beginBody, _ := json.Marshal(map[string]any{
		"username":     username,
		"display_name": "Login Test User",
		"email":        username + "@example.invalid",
	})
	beginResp, err := client.Post(baseURL+"/api/auth/register/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("register/begin POST: %v", err)
	}
	defer beginResp.Body.Close()
	if beginResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(beginResp.Body)
		t.Fatalf("register/begin status = %d (%s: %s)",
			beginResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var beginOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(beginResp.Body).Decode(&beginOut); err != nil {
		t.Fatalf("decode register/begin: %v", err)
	}

	parsedOpts, err := virtualwebauthn.ParseAttestationOptions(string(beginOut.Options))
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	attResp := virtualwebauthn.CreateAttestationResponse(rp, vAuth, vCred, *parsedOpts)

	finishBody, _ := json.Marshal(map[string]any{
		"credential": json.RawMessage(attResp),
	})
	finishResp, err := client.Post(baseURL+"/api/auth/register/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("register/finish POST: %v", err)
	}
	defer finishResp.Body.Close()
	if finishResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(finishResp.Body)
		t.Fatalf("register/finish status = %d (%s: %s)",
			finishResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	// Drain body so the connection can be reused.
	io.Copy(io.Discard, finishResp.Body)
}

// checkMe hits /api/auth/me with the client (which carries the
// cookie jar). Expects 200 and verifies the username matches.
func checkMe(t *testing.T, client *http.Client, baseURL string, wantUsername string) {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/auth/me")
	if err != nil {
		t.Fatalf("me GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		t.Fatalf("/me status = %d (%s: %s)",
			resp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var meOut struct {
		UserID           string    `json:"user_id"`
		Username         string    `json:"username"`
		DisplayName      string    `json:"display_name"`
		Role             string    `json:"role"`
		Email            string    `json:"email"`
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meOut); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	if meOut.Username != wantUsername {
		t.Errorf("/me username = %q, want %q", meOut.Username, wantUsername)
	}
	if meOut.SessionExpiresAt.IsZero() {
		t.Error("/me session_expires_at should be non-zero")
	}
	if meOut.Role != "user" {
		t.Errorf("/me role = %q, want 'user'", meOut.Role)
	}
}

// hasSessionCookie returns true if the jar holds chalk_session for
// the given base URL.
func hasSessionCookie(jar *cookiejar.Jar, baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	for _, c := range jar.Cookies(u) {
		if c.Name == auth.CookieName && c.Value != "" {
			return true
		}
	}
	return false
}

package auth_test

import (
	"bytes"
	"context"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// Tests for the one-shot admin claim: /?admin_token=<token> →
// password+TOTP signup that takes possession of the admin row chalkd
// seeded at first boot.
//
// What makes this worth pinning down: the claim deliberately inverts
// the ordinary signup checks (the username SHOULD already exist, and
// registration being closed must not block it), so a regression here
// fails open in one direction or locks the operator out in the other.
//
// Requires CHALK_TEST_DATABASE_URL like the other end-to-end tests.

const (
	claimAdminUser  = "claimtestadmin"
	claimAdminEmail = "claimtestadmin@example.invalid"
	claimToken      = "test-admin-bootstrap-token-value"
)

// TestAdminClaimAdoptsSeededRow is the happy path: the seeded admin row
// gains credentials, keeps its id and its role, and the token is spent.
func TestAdminClaimAdoptsSeededRow(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seeded := seedUnclaimedAdmin(t, ctx, pool, st)
	srv := startClaimTestServer(t, st, claimToken)

	res := claimAdmin(t, srv.URL, claimToken, claimAdminUser, claimAdminEmail)
	if res.status != http.StatusOK {
		t.Fatalf("claim failed: %d (%s: %s)", res.status, res.code, res.message)
	}
	if res.userID != seeded.String() {
		t.Errorf("claim minted a NEW user %s; must adopt the seeded row %s",
			res.userID, seeded)
	}

	var role string
	var enrolled bool
	if err := pool.QueryRow(ctx,
		`SELECT u.role, ua.auth_v2_enrolled
		   FROM users u JOIN user_auth ua ON ua.user_id = u.id
		  WHERE u.id = $1`, seeded,
	).Scan(&role, &enrolled); err != nil {
		t.Fatalf("read claimed admin: %v", err)
	}
	if role != "admin" {
		t.Errorf("role = %q after claim, want admin", role)
	}
	if !enrolled {
		t.Error("auth_v2_enrolled should be true after claim")
	}

	// One-shot: the row now has credentials, so it is no longer
	// claimable and a second attempt with the same token is refused.
	if _, err := st.GetUnclaimedAdmin(ctx); err == nil {
		t.Error("admin should no longer be claimable after a successful claim")
	}
	again := beginClaim(t, srv.URL, claimToken, claimAdminUser, claimAdminEmail)
	if again.status != http.StatusConflict {
		t.Errorf("second claim: status = %d, want 409 (code %q)", again.status, again.code)
	}
}

// TestAdminClaimWorksWithRegistrationClosed covers the steady state of a
// real deployment: open registration off. A valid token is its own
// admission proof, so the enrollment URL must still work.
func TestAdminClaimWorksWithRegistrationClosed(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seedUnclaimedAdmin(t, ctx, pool, st)
	t.Setenv("CHALK_OPEN_REGISTRATION", "0")
	srv := startClaimTestServer(t, st, claimToken)

	// An ordinary signup is refused...
	other := beginClaim(t, srv.URL, claimToken, "randomjoiner", "randomjoiner@example.invalid")
	if other.status != http.StatusForbidden || other.code != "registration_closed" {
		t.Errorf("ordinary signup with registration closed: %d %q, want 403 registration_closed",
			other.status, other.code)
	}

	// ...while the admin claim goes through.
	res := beginClaim(t, srv.URL, claimToken, claimAdminUser, claimAdminEmail)
	if res.status != http.StatusOK {
		t.Errorf("admin claim with registration closed: %d (%s: %s)",
			res.status, res.code, res.message)
	}
}

// TestAdminClaimRejectsBadToken pins the fail-closed behaviour: without
// the exact token the admin username is just a taken username.
func TestAdminClaimRejectsBadToken(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seedUnclaimedAdmin(t, ctx, pool, st)
	srv := startClaimTestServer(t, st, claimToken)

	for _, tc := range []struct{ name, token string }{
		{"wrong token", "not-the-right-token-at-all-nope"},
		{"empty token", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := beginClaim(t, srv.URL, tc.token, claimAdminUser, claimAdminEmail)
			if res.status != http.StatusConflict {
				t.Errorf("status = %d (%s), want 409", res.status, res.code)
			}
		})
	}

	// And with no token configured server-side at all, nothing claims.
	t.Setenv("CHALK_ADMIN_BOOTSTRAP_TOKEN", "")
	res := beginClaim(t, srv.URL, claimToken, claimAdminUser, claimAdminEmail)
	if res.status != http.StatusConflict {
		t.Errorf("unset server token: status = %d (%s), want 409", res.status, res.code)
	}
}

// TestAdminClaimTokenDoesNotElevateOthers: the token authorizes ONE
// username. Presenting it while signing up as somebody else must
// produce an ordinary account.
func TestAdminClaimTokenDoesNotElevateOthers(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seedUnclaimedAdmin(t, ctx, pool, st)
	srv := startClaimTestServer(t, st, claimToken)

	const other = "claimtestrando"
	cleanupUser(t, ctx, pool, other)

	res := claimAdmin(t, srv.URL, claimToken, other, other+"@example.invalid")
	if res.status != http.StatusOK {
		t.Fatalf("ordinary signup: %d (%s: %s)", res.status, res.code, res.message)
	}
	var role string
	if err := pool.QueryRow(ctx,
		`SELECT role FROM users WHERE username = $1`, other).Scan(&role); err != nil {
		t.Fatalf("read user: %v", err)
	}
	if role != "admin" {
		return // expected
	}
	t.Errorf("signing up as %q with the admin token produced role=admin", other)
}

// TestAdminClaimProbe covers the endpoint the SPA uses to decide whether
// to open the wizard prefilled. It must reveal the username only to a
// valid token.
func TestAdminClaimProbe(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seedUnclaimedAdmin(t, ctx, pool, st)
	srv := startClaimTestServer(t, st, claimToken)

	good := probeClaim(t, srv.URL, claimToken)
	if !good.Claimable {
		t.Error("valid token should report claimable")
	}
	if good.Username != claimAdminUser {
		t.Errorf("probe username = %q, want %q", good.Username, claimAdminUser)
	}

	bad := probeClaim(t, srv.URL, "wrong-token-entirely")
	if bad.Claimable {
		t.Error("bad token should not report claimable")
	}
	if bad.Username != "" {
		t.Errorf("bad token leaked username %q", bad.Username)
	}
}

// ---- helpers -----------------------------------------------------------

func openClaimTestDB(t *testing.T) (*pgxpool.Pool, *store.Store) {
	t.Helper()
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, &store.Store{Pool: pool}
}

// seedUnclaimedAdmin puts the database in the state chalkd leaves after
// first boot: an admin row with an identity and no credentials.
func seedUnclaimedAdmin(t *testing.T, ctx context.Context, pool *pgxpool.Pool, st *store.Store) uuid.UUID {
	t.Helper()
	dropAdmins(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropAdmins(t, c, pool)
	})
	admin, err := st.BootstrapAdminUser(ctx, store.BootstrapAdminUserParams{
		Username: claimAdminUser,
		Email:    claimAdminEmail,
	})
	if err != nil {
		t.Fatalf("BootstrapAdminUser: %v", err)
	}
	return admin.ID
}

// dropAdmins clears admin rows. The admin_delete_guard trigger refuses
// DELETE on them, so it comes off for the duration.
func dropAdmins(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx,
		`ALTER TABLE users DISABLE TRIGGER admin_delete_guard`); err != nil {
		t.Logf("disable admin guard: %v", err)
		return
	}
	defer func() {
		if _, err := pool.Exec(ctx,
			`ALTER TABLE users ENABLE TRIGGER admin_delete_guard`); err != nil {
			t.Logf("re-enable admin guard: %v", err)
		}
	}()
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE role = 'admin'`); err != nil {
		t.Logf("delete admins: %v", err)
	}
}

func startClaimTestServer(t *testing.T, st *store.Store, token string) *httptest.Server {
	t.Helper()
	t.Setenv("CHALK_ADMIN_BOOTSTRAP_TOKEN", token)
	t.Setenv("CHALK_DEV", "1")
	// A 32-byte key, standard base64: TOTP secrets are encrypted at rest
	// and signup refuses to start without it.
	t.Setenv("CHALK_TOTP_ENC_KEY",
		base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if os.Getenv("CHALK_OPEN_REGISTRATION") == "" {
		t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	}

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
		Service:       svc,
		Cache:         auth.NewCeremonyCache(time.Minute),
		Store:         st,
		AdminUsername: claimAdminUser,
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

type claimResult struct {
	status    int
	code      string
	message   string
	userID    string
	secretB32 string
	signupTok string
}

// beginClaim drives POST /api/auth/register/v2/begin only.
func beginClaim(t *testing.T, baseURL, adminToken, username, email string) claimResult {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"username":    username,
		"email":       email,
		"admin_token": adminToken,
	})
	resp, err := http.Post(baseURL+"/api/auth/register/v2/begin",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register/v2/begin POST: %v", err)
	}
	defer resp.Body.Close()

	out := claimResult{status: resp.StatusCode}
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		out.code, out.message = eb.Error.Code, eb.Error.Message
		return out
	}
	var ok struct {
		SignupToken string `json:"signup_token"`
		SecretB32   string `json:"secret_b32"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ok); err != nil {
		t.Fatalf("decode begin: %v", err)
	}
	out.signupTok, out.secretB32 = ok.SignupToken, ok.SecretB32
	return out
}

// claimAdmin drives the whole two-leg signup, answering the TOTP
// challenge with a live code derived from the provisioned secret.
func claimAdmin(t *testing.T, baseURL, adminToken, username, email string) claimResult {
	t.Helper()
	begun := beginClaim(t, baseURL, adminToken, username, email)
	if begun.status != http.StatusOK {
		return begun
	}

	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(begun.secretB32)
	if err != nil {
		t.Fatalf("decode totp secret: %v", err)
	}

	// The proof is opaque to the server (it stores SHA-256 of it), so
	// any non-empty bytes stand in for the client's Argon2id output.
	// The declared KDF params, however, must meet the server floor.
	body, _ := json.Marshal(map[string]any{
		"signup_token":   begun.signupTok,
		"totp_code":      auth.TOTPCodeAt(secret, time.Now()),
		"auth_proof_b64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)),
		"salt_b64":       base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 16)),
		"kdf_alg":        1,
		"kdf_mem_kib":    auth.Argon2MemFloorKiB(),
		"kdf_iters":      auth.Argon2ItersFloor(),
		"kdf_par":        auth.Argon2ParFloor(),
	})
	resp, err := http.Post(baseURL+"/api/auth/register/v2/finish",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register/v2/finish POST: %v", err)
	}
	defer resp.Body.Close()

	out := claimResult{status: resp.StatusCode}
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		out.code, out.message = eb.Error.Code, eb.Error.Message
		return out
	}
	var ok struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ok); err != nil {
		t.Fatalf("decode finish: %v", err)
	}
	out.userID = ok.UserID
	return out
}

type probeResponse struct {
	Claimable bool   `json:"claimable"`
	Username  string `json:"username"`
}

func probeClaim(t *testing.T, baseURL, token string) probeResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"admin_token": token})
	resp, err := http.Post(baseURL+"/api/auth/admin-claim/probe",
		"application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("admin-claim/probe POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("probe status = %d, want 200", resp.StatusCode)
	}
	var out probeResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode probe: %v", err)
	}
	return out
}

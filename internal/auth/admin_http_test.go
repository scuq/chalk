package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	virtualwebauthn "github.com/descope/virtualwebauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// Phase 09d-1 HTTP-level tests for admin moderation endpoints.
//
// Strategy:
//
//   - End-to-end tests run against real Postgres if
//     CHALK_TEST_DATABASE_URL is set; skipped otherwise so
//     `go test ./...` from a fresh checkout doesn't fail.
//   - We use the existing virtualwebauthn helpers from http_test.go
//     to register a regular user, then promote them to admin via
//     direct SQL (the real promotion path is the bootstrap flow,
//     covered separately; we don't want to entangle every test in
//     a full bootstrap ceremony).
//   - A separate "regular user" client (with its own jar) exercises
//     the RequireAdmin 403 path.

// ---- test scaffolding -------------------------------------------------

// adminTestEnv bundles everything a moderation HTTP test needs.
type adminTestEnv struct {
	t        *testing.T
	pool     *pgxpool.Pool
	st       *store.Store
	server   *httptest.Server
	mux      *http.ServeMux
	admin    *http.Client // jar with admin session
	user     *http.Client // jar with regular-user session
	adminID  uuid.UUID
	userID   uuid.UUID
	adminName string
	userName  string
	mockKick *mockKicker
}

// mockKicker captures the userIDs the admin endpoints try to kick so
// we can assert against the call.
type mockKicker struct {
	calls []mockKickCall
}

type mockKickCall struct {
	userID string
	reason string
}

func (m *mockKicker) CloseConnsForUser(userID string, reason error) {
	rs := ""
	if reason != nil {
		rs = reason.Error()
	}
	m.calls = append(m.calls, mockKickCall{userID: userID, reason: rs})
}

// setupAdminEnv brings up a real Postgres-backed httptest server with
// both admin and regular-user sessions registered. The admin is
// promoted via direct SQL after registration because the legitimate
// bootstrap flow has its own coverage in admin_bootstrap_http_test.go
// and would only add ceremony noise here.
//
// On exit, t.Cleanup tears down pool + server.
func setupAdminEnv(t *testing.T) *adminTestEnv {
	t.Helper()
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	st := &store.Store{Pool: pool}

	// Per-run unique usernames so parallel-ish CI runs don't trample.
	adminName := fmt.Sprintf("admt%d", time.Now().UnixNano()%1_000_000_000)
	userName := fmt.Sprintf("regu%d", time.Now().UnixNano()%1_000_000_000)

	// Defensive cleanup before the run (helps when a previous test
	// crashed mid-flight).
	for _, name := range []string{adminName, userName} {
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE username = $1`, name); err != nil {
			t.Fatalf("pre-cleanup user %s: %v", name, err)
		}
	}
	// Also clear any other admin row (the singleton index would
	// otherwise refuse our promotion). We disable the
	// admin_delete_guard trigger for this test-only cleanup.
	if _, err := pool.Exec(ctx,
		`ALTER TABLE users DISABLE TRIGGER admin_delete_guard`); err != nil {
		t.Fatalf("disable admin_delete_guard: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE role = 'admin'`); err != nil {
		_, _ = pool.Exec(ctx, `ALTER TABLE users ENABLE TRIGGER admin_delete_guard`)
		t.Fatalf("clear admins: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`ALTER TABLE users ENABLE TRIGGER admin_delete_guard`); err != nil {
		t.Fatalf("re-enable admin_delete_guard: %v", err)
	}

	t.Setenv("CHALK_OPEN_REGISTRATION", "1")

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
	kicker := &mockKicker{}
	deps := &auth.HTTPDeps{
		Service: svc,
		Cache:   auth.NewCeremonyCache(time.Minute),
		Store:   st,
		Kicker:  kicker,
	}
	mux := http.NewServeMux()
	if err := deps.MountRegistration(mux); err != nil {
		t.Fatalf("MountRegistration: %v", err)
	}
	if err := deps.MountAdmin(mux); err != nil {
		t.Fatalf("MountAdmin: %v", err)
	}
	srv.Config.Handler = mux
	srv.Start()
	t.Cleanup(srv.Close)

	// Register two users: one will become admin, the other stays
	// regular. We need two SEPARATE virtualwebauthn credentials
	// because each authenticator is single-use for a registration.
	adminJar, _ := cookiejar.New(nil)
	userJar, _ := cookiejar.New(nil)
	adminClient := &http.Client{Jar: adminJar}
	userClient := &http.Client{Jar: userJar}

	rp := virtualwebauthn.RelyingParty{
		Name:   testRPName,
		ID:     testRPID,
		Origin: srv.URL,
	}
	adminAuth := virtualwebauthn.NewAuthenticator()
	adminCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	userAuth := virtualwebauthn.NewAuthenticator()
	userCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	registerUser(t, adminClient, srv.URL, rp, adminAuth, adminCred, adminName)
	registerUser(t, userClient, srv.URL, rp, userAuth, userCred, userName)

	// Promote the admin via direct SQL. The singleton index allows
	// this because we cleared any previous admin row above. The
	// admin_lifecycle_guard trigger we added in migration 0019
	// fires on UPDATEs that set blocked_at/deleted_at while role
	// is admin; setting the role itself is fine.
	if _, err := pool.Exec(ctx,
		`UPDATE users SET role = 'admin' WHERE username = $1`, adminName,
	); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	// Resolve UUIDs so tests don't have to.
	var adminID, userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE username = $1`, adminName,
	).Scan(&adminID); err != nil {
		t.Fatalf("lookup adminID: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE username = $1`, userName,
	).Scan(&userID); err != nil {
		t.Fatalf("lookup userID: %v", err)
	}

	// Final cleanup of the rows we created. We DON'T delete the
	// admin row through normal DELETE (the trigger blocks it); the
	// test-only cleanup disables the trigger.
	t.Cleanup(func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		_, _ = pool.Exec(cleanupCtx, `ALTER TABLE users DISABLE TRIGGER admin_delete_guard`)
		_, _ = pool.Exec(cleanupCtx,
			`DELETE FROM users WHERE username IN ($1, $2)`, adminName, userName)
		_, _ = pool.Exec(cleanupCtx, `ALTER TABLE users ENABLE TRIGGER admin_delete_guard`)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM email_blacklist WHERE email LIKE '%@example.invalid'`)
	})

	return &adminTestEnv{
		t:         t,
		pool:      pool,
		st:        st,
		server:    srv,
		mux:       mux,
		admin:     adminClient,
		user:      userClient,
		adminID:   adminID,
		userID:    userID,
		adminName: adminName,
		userName:  userName,
		mockKick:  kicker,
	}
}

// doJSON is a tiny helper: POST/GET/DELETE the given path with an
// optional JSON body, return status + decoded body bytes.
func (e *adminTestEnv) doJSON(method, path string, client *http.Client, body any) (int, []byte) {
	e.t.Helper()
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("marshal body: %v", err)
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.server.URL+path, reqBody)
	if err != nil {
		e.t.Fatalf("NewRequest %s %s: %v", method, path, err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

// ---- RequireAdmin middleware -----------------------------------------

func TestRequireAdminRefusesNonAdmin(t *testing.T) {
	env := setupAdminEnv(t)
	// Regular user (not admin) hits an admin endpoint.
	status, body := env.doJSON("GET", "/api/admin/users", env.user, nil)
	if status != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body=%s", status, body)
	}
	var eb errBody
	if err := json.Unmarshal(body, &eb); err != nil {
		t.Fatalf("decode error: %v (body=%s)", err, body)
	}
	if eb.Error.Code != "not_admin" {
		t.Errorf("error code = %q, want not_admin", eb.Error.Code)
	}
}

func TestRequireAdminRefusesAnonymous(t *testing.T) {
	env := setupAdminEnv(t)
	// No session cookie at all.
	anon := &http.Client{}
	status, body := env.doJSON("GET", "/api/admin/users", anon, nil)
	if status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401; body=%s", status, body)
	}
}

func TestRequireAdminAcceptsAdmin(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("GET", "/api/admin/users", env.admin, nil)
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", status, body)
	}
}

// ---- GET /api/admin/users --------------------------------------------

func TestAdminListUsersIncludesBoth(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("GET",
		"/api/admin/users?limit=200", env.admin, nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	var resp struct {
		Users  []map[string]any `json:"users"`
		Total  int64            `json:"total"`
		Limit  int              `json:"limit"`
		Offset int              `json:"offset"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if resp.Total < 2 {
		t.Errorf("Total = %d, want >= 2", resp.Total)
	}
	// Find admin and regular user in the list, check status field.
	var sawAdmin, sawUser bool
	for _, u := range resp.Users {
		switch u["username"] {
		case env.adminName:
			sawAdmin = true
			if u["status"] != "admin" {
				t.Errorf("admin status = %v, want 'admin'", u["status"])
			}
			if u["role"] != "admin" {
				t.Errorf("admin role = %v, want 'admin'", u["role"])
			}
		case env.userName:
			sawUser = true
			if u["status"] != "active" {
				t.Errorf("user status = %v, want 'active'", u["status"])
			}
		}
	}
	if !sawAdmin {
		t.Error("admin not present in list")
	}
	if !sawUser {
		t.Error("regular user not present in list")
	}
}

func TestAdminListUsersSearch(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("GET",
		"/api/admin/users?q="+env.userName, env.admin, nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	var resp struct {
		Users []map[string]any `json:"users"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Users) != 1 {
		t.Errorf("got %d results, want exactly 1", len(resp.Users))
	} else if resp.Users[0]["username"] != env.userName {
		t.Errorf("got username %v, want %s", resp.Users[0]["username"], env.userName)
	}
}

// ---- POST /api/admin/users/{id}/block --------------------------------

func TestAdminBlockUser(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST",
		"/api/admin/users/"+env.userID.String()+"/block", env.admin, nil)
	if status != http.StatusNoContent {
		t.Fatalf("block status = %d; body=%s", status, body)
	}
	// Verify DB state.
	c := context.Background()
	var blockedAt *time.Time
	if err := env.pool.QueryRow(c,
		`SELECT blocked_at FROM users WHERE id = $1`, env.userID,
	).Scan(&blockedAt); err != nil {
		t.Fatalf("read blocked_at: %v", err)
	}
	if blockedAt == nil {
		t.Error("blocked_at not set in DB")
	}
	// Mock kicker should have been called.
	if len(env.mockKick.calls) != 1 {
		t.Fatalf("mockKick calls = %d, want 1", len(env.mockKick.calls))
	}
	if env.mockKick.calls[0].userID != env.userID.String() {
		t.Errorf("kicked userID = %s, want %s",
			env.mockKick.calls[0].userID, env.userID)
	}
}

func TestAdminBlockUserRefusesAdmin(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST",
		"/api/admin/users/"+env.adminID.String()+"/block", env.admin, nil)
	if status != http.StatusConflict {
		t.Errorf("status = %d, want 409; body=%s", status, body)
	}
	var eb errBody
	if err := json.Unmarshal(body, &eb); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if eb.Error.Code != "cannot_modify_admin" {
		t.Errorf("code = %q, want cannot_modify_admin", eb.Error.Code)
	}
}

func TestAdminBlockUserBadUUID(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST",
		"/api/admin/users/not-a-uuid/block", env.admin, nil)
	if status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", status, body)
	}
}

func TestAdminBlockUserNotFound(t *testing.T) {
	env := setupAdminEnv(t)
	bogus := uuid.New()
	status, body := env.doJSON("POST",
		"/api/admin/users/"+bogus.String()+"/block", env.admin, nil)
	if status != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body=%s", status, body)
	}
}

// ---- POST /api/admin/users/{id}/unblock ------------------------------

func TestAdminUnblockUser(t *testing.T) {
	env := setupAdminEnv(t)
	// First block.
	if status, _ := env.doJSON("POST",
		"/api/admin/users/"+env.userID.String()+"/block", env.admin, nil,
	); status != http.StatusNoContent {
		t.Fatalf("setup block: status %d", status)
	}
	// Then unblock.
	status, body := env.doJSON("POST",
		"/api/admin/users/"+env.userID.String()+"/unblock", env.admin, nil)
	if status != http.StatusNoContent {
		t.Fatalf("unblock status = %d; body=%s", status, body)
	}
	// Verify.
	c := context.Background()
	var blockedAt *time.Time
	if err := env.pool.QueryRow(c,
		`SELECT blocked_at FROM users WHERE id = $1`, env.userID,
	).Scan(&blockedAt); err != nil {
		t.Fatalf("read blocked_at: %v", err)
	}
	if blockedAt != nil {
		t.Errorf("blocked_at = %v, want nil", blockedAt)
	}
}

// ---- POST /api/admin/users/{id}/soft-delete --------------------------

func TestAdminSoftDeleteUser(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST",
		"/api/admin/users/"+env.userID.String()+"/soft-delete", env.admin, nil)
	if status != http.StatusNoContent {
		t.Fatalf("soft-delete status = %d; body=%s", status, body)
	}
	c := context.Background()
	var deletedAt *time.Time
	if err := env.pool.QueryRow(c,
		`SELECT deleted_at FROM users WHERE id = $1`, env.userID,
	).Scan(&deletedAt); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	if deletedAt == nil {
		t.Error("deleted_at not set")
	}
}

func TestAdminSoftDeleteUserRefusesAdmin(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST",
		"/api/admin/users/"+env.adminID.String()+"/soft-delete", env.admin, nil)
	if status != http.StatusConflict {
		t.Errorf("status = %d, want 409; body=%s", status, body)
	}
}

// ---- DELETE /api/admin/users/{id} (purge) ----------------------------

func TestAdminPurgeUser(t *testing.T) {
	env := setupAdminEnv(t)
	// Snapshot the email so we can check blacklist insertion.
	var email string
	if err := env.pool.QueryRow(context.Background(),
		`SELECT email::text FROM users WHERE id = $1`, env.userID,
	).Scan(&email); err != nil {
		t.Fatalf("read email: %v", err)
	}
	status, body := env.doJSON("DELETE",
		"/api/admin/users/"+env.userID.String(), env.admin, nil)
	if status != http.StatusNoContent {
		t.Fatalf("purge status = %d; body=%s", status, body)
	}
	// User row should be gone.
	if _, err := env.st.GetUserByID(context.Background(), env.userID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetUserByID after purge: err = %v, want ErrNotFound", err)
	}
	// Email should be on the blacklist.
	listed, err := env.st.IsEmailBlacklisted(context.Background(), email)
	if err != nil {
		t.Fatalf("IsEmailBlacklisted: %v", err)
	}
	if !listed {
		t.Errorf("email %q not blacklisted after purge", email)
	}
}

func TestAdminPurgeUserRefusesAdmin(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("DELETE",
		"/api/admin/users/"+env.adminID.String(), env.admin, nil)
	if status != http.StatusConflict {
		t.Errorf("status = %d, want 409; body=%s", status, body)
	}
}

// ---- /api/admin/blacklist --------------------------------------------

func TestAdminBlacklistAddRemoveList(t *testing.T) {
	env := setupAdminEnv(t)
	// Add
	status, body := env.doJSON("POST", "/api/admin/blacklist", env.admin, map[string]string{
		"email":  "block-me@example.invalid",
		"reason": "manual_test",
	})
	if status != http.StatusCreated {
		t.Fatalf("add status = %d; body=%s", status, body)
	}
	// List
	status, body = env.doJSON("GET", "/api/admin/blacklist", env.admin, nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d; body=%s", status, body)
	}
	var listResp struct {
		Entries []map[string]any `json:"entries"`
		Total   int64            `json:"total"`
	}
	if err := json.Unmarshal(body, &listResp); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if listResp.Total < 1 {
		t.Errorf("Total = %d, want >= 1", listResp.Total)
	}
	found := false
	for _, e := range listResp.Entries {
		if e["email"] == "block-me@example.invalid" {
			found = true
			if e["reason"] != "manual_test" {
				t.Errorf("reason = %v, want manual_test", e["reason"])
			}
		}
	}
	if !found {
		t.Error("added entry not present in list")
	}
	// Remove
	status, body = env.doJSON("DELETE",
		"/api/admin/blacklist/block-me@example.invalid", env.admin, nil)
	if status != http.StatusNoContent {
		t.Fatalf("remove status = %d; body=%s", status, body)
	}
	// Confirm removal.
	listed, err := env.st.IsEmailBlacklisted(context.Background(), "block-me@example.invalid")
	if err != nil {
		t.Fatalf("IsEmailBlacklisted: %v", err)
	}
	if listed {
		t.Error("entry still listed after remove")
	}
}

func TestAdminBlacklistAddRejectsBadEmail(t *testing.T) {
	env := setupAdminEnv(t)
	status, body := env.doJSON("POST", "/api/admin/blacklist", env.admin, map[string]string{
		"email":  "not-an-email",
		"reason": "x",
	})
	if status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", status, body)
	}
}

// ---- shared decode helper --------------------------------------------
//
// errBody and decodeError are defined in http_test.go in the same
// auth_test package; we share them here without re-declaring.

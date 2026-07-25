package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	virtualwebauthn "github.com/descope/virtualwebauthn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// Regression tests for the WebAuthn BE-flag handling.
//
// go-webauthn compares the STORED credential's BackupEligible bit
// against the one asserted at login and rejects the ceremony on
// mismatch. chalk used to store no flags at all, so the reconstructed
// credential always claimed BE=0 and every synced passkey (iCloud
// Keychain, Google Password Manager, 1Password, …) failed login with
// "Backup Eligible flag inconsistency detected during login
// validation".
//
// The rest of the suite misses this because virtualwebauthn's default
// authenticator has BackupEligible=false — stored-zero matches
// asserted-zero and the bug is invisible. These tests deliberately use
// an authenticator with BE=1.
//
// Requires CHALK_TEST_DATABASE_URL like the other end-to-end tests.

// bitBackupEligible / bitBackupState are the raw AuthenticatorFlags bit
// positions (https://www.w3.org/TR/webauthn/#flags).
const (
	bitBackupEligible = byte(1 << 3)
	bitBackupState    = byte(1 << 4)
)

// TestSyncedPasskeyLoginEndToEnd registers and then logs in with a
// backup-eligible (synced) passkey. Before the flags column existed
// this failed at authenticate/finish with a 400.
func TestSyncedPasskeyLoginEndToEnd(t *testing.T) {
	pool, st := openFlagsTestDB(t)
	const username = "synckeytestuser"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cleanupUser(t, ctx, pool, username)

	srv, rp, client := startFlagsTestServer(t, st)

	// A synced passkey: backup-eligible and currently backed up.
	vAuth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
		BackupEligible: true,
		BackupState:    true,
	})
	vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	registerUser(t, client, srv.URL, rp, vAuth, vCred, username)
	vAuth.AddCredential(vCred)

	// Registration must have recorded the flags, BE set.
	flags := readPasskeyFlags(t, ctx, pool, username)
	if flags == nil {
		t.Fatalf("flags NULL after registration; registration must record them")
	}
	if *flags&bitBackupEligible == 0 {
		t.Errorf("stored flags = %#x, BackupEligible bit not set", *flags)
	}
	if *flags&bitBackupState == 0 {
		t.Errorf("stored flags = %#x, BackupState bit not set", *flags)
	}

	// The actual regression: logging in with a BE=1 authenticator.
	loginWithPasskey(t, client, srv.URL, rp, vAuth, vCred, username)
	checkMe(t, client, srv.URL, username)

	// Login rewrote the flags; BE must still be set.
	after := readPasskeyFlags(t, ctx, pool, username)
	if after == nil || *after&bitBackupEligible == 0 {
		t.Errorf("flags after login = %v, want BackupEligible set", after)
	}
}

// TestLegacyPasskeyFlagsAdoptedOnLogin covers rows written before
// migration 0042, whose true BE bit was never recorded and is not
// recoverable. Such a row must not lock the user out: the first login
// after the upgrade adopts the asserted flags and persists them.
func TestLegacyPasskeyFlagsAdoptedOnLogin(t *testing.T) {
	pool, st := openFlagsTestDB(t)
	const username = "legacyflagsuser"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cleanupUser(t, ctx, pool, username)

	srv, rp, client := startFlagsTestServer(t, st)

	vAuth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
		BackupEligible: true,
		BackupState:    true,
	})
	vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	registerUser(t, client, srv.URL, rp, vAuth, vCred, username)
	vAuth.AddCredential(vCred)

	// Rewind the row to its pre-0042 shape: flags unknown.
	if _, err := pool.Exec(ctx,
		`UPDATE passkeys SET flags = NULL
		   WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
		username,
	); err != nil {
		t.Fatalf("simulate legacy row: %v", err)
	}
	if flags := readPasskeyFlags(t, ctx, pool, username); flags != nil {
		t.Fatalf("setup: flags = %#x, want NULL", *flags)
	}

	// Login must succeed despite the unknown stored BE.
	loginWithPasskey(t, client, srv.URL, rp, vAuth, vCred, username)
	checkMe(t, client, srv.URL, username)

	// …and the row must no longer be unknown, so the BE-change check
	// applies from the next login onward.
	after := readPasskeyFlags(t, ctx, pool, username)
	if after == nil {
		t.Fatalf("flags still NULL after login; adoption did not persist")
	}
	if *after&bitBackupEligible == 0 {
		t.Errorf("adopted flags = %#x, want BackupEligible set", *after)
	}
}

// ---- helpers -----------------------------------------------------------

func openFlagsTestDB(t *testing.T) (*pgxpool.Pool, *store.Store) {
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

// cleanupUser removes the test user now and again when the test ends.
// The teardown deliberately uses its own context: t.Cleanup runs after
// the test's deferred cancel(), so the test's own context is already
// canceled by then.
func cleanupUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username string) {
	t.Helper()
	del := func(c context.Context) {
		if _, err := pool.Exec(c,
			`DELETE FROM users WHERE username = $1`, username); err != nil {
			t.Logf("cleanup %s: %v", username, err)
		}
	}
	del(ctx)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		del(c)
	})
}

// startFlagsTestServer mounts the auth handlers on an httptest server
// whose own URL is the configured RP origin (go-webauthn verifies the
// origin on every finish call, so the service can only be built once
// the listener's address is known).
func startFlagsTestServer(t *testing.T, st *store.Store) (*httptest.Server, virtualwebauthn.RelyingParty, *http.Client) {
	t.Helper()
	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	// The session cookie is Secure unless dev mode is on, and Go's
	// cookiejar will not send a Secure cookie back over the plain-http
	// httptest server — /me would 401 on a perfectly good session.
	t.Setenv("CHALK_DEV", "1")

	srv := httptest.NewUnstartedServer(nil)
	originURL := "http://" + srv.Listener.Addr().String()

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
	t.Cleanup(srv.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	rp := virtualwebauthn.RelyingParty{
		Name:   testRPName,
		ID:     testRPID,
		Origin: srv.URL,
	}
	return srv, rp, &http.Client{Jar: jar}
}

// loginWithPasskey drives authenticate/begin + authenticate/finish and
// fails the test if either leg errors.
func loginWithPasskey(t *testing.T, client *http.Client, baseURL string,
	rp virtualwebauthn.RelyingParty, vAuth virtualwebauthn.Authenticator,
	vCred virtualwebauthn.Credential, username string) {
	t.Helper()

	beginBody, _ := json.Marshal(map[string]any{"username": username})
	beginResp, err := client.Post(baseURL+"/api/auth/authenticate/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("authenticate/begin POST: %v", err)
	}
	defer beginResp.Body.Close()
	if beginResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(beginResp.Body)
		t.Fatalf("authenticate/begin status = %d (%s: %s)",
			beginResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var beginOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(beginResp.Body).Decode(&beginOut); err != nil {
		t.Fatalf("decode authenticate/begin: %v", err)
	}

	parsedAssertion, err := virtualwebauthn.ParseAssertionOptions(string(beginOut.Options))
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	assertionResp := virtualwebauthn.CreateAssertionResponse(rp, vAuth, vCred, *parsedAssertion)

	finishBody, _ := json.Marshal(map[string]any{
		"credential": json.RawMessage(assertionResp),
	})
	finishResp, err := client.Post(baseURL+"/api/auth/authenticate/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("authenticate/finish POST: %v", err)
	}
	defer finishResp.Body.Close()
	if finishResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(finishResp.Body)
		// The pre-fix failure mode lands exactly here.
		t.Fatalf("authenticate/finish status = %d (%s: %s)",
			finishResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var finishOut struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(finishResp.Body).Decode(&finishOut); err != nil {
		t.Fatalf("decode authenticate/finish: %v", err)
	}
	if finishOut.Username != username {
		t.Errorf("authenticate/finish username = %q, want %q", finishOut.Username, username)
	}
}

// readPasskeyFlags returns the flags column of the user's single
// passkey row, nil when SQL NULL.
func readPasskeyFlags(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username string) *byte {
	t.Helper()
	var flags *int16
	if err := pool.QueryRow(ctx,
		`SELECT p.flags FROM passkeys p
		   JOIN users u ON u.id = p.user_id
		  WHERE u.username = $1`, username,
	).Scan(&flags); err != nil {
		t.Fatalf("read passkey flags: %v", err)
	}
	if flags == nil {
		return nil
	}
	b := byte(*flags)
	return &b
}

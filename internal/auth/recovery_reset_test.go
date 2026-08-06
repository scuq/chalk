package auth_test

import (
	"bytes"
	"context"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// Tests for the 31-13 recovery reset: the recovery phrase sets a NEW password
// instead of merely signing in.
//
// What matters here is that the phrase does not quietly become a
// single-factor bypass. An account with a confirmed TOTP secret must still
// answer a live code, and a wrong answer must not burn the phrase -- getting
// that ordering wrong would lock people out on a typo.
//
// Requires CHALK_TEST_DATABASE_URL like the other end-to-end tests.

const (
	resetTestUser  = "resettestuser"
	resetTestEmail = "resettestuser@example.invalid"
)

func TestRecoveryResetRequiresLiveTOTP(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, _ := startResetTestServer(t, st)
	words, secret := signupResetUser(t, srv.URL)

	// ---- no code: refused, and the phrase survives ----------------------
	res := postReset(t, srv.URL, resetReq{words: words})
	if res.status != http.StatusUnauthorized || res.code != "totp_required" {
		t.Fatalf("reset without a code = %d %q, want 401 totp_required",
			res.status, res.code)
	}

	// ---- wrong code: refused, and the phrase still survives -------------
	res = postReset(t, srv.URL, resetReq{words: words, code: "000000"})
	if res.status != http.StatusUnauthorized || res.code != "invalid_totp" {
		t.Fatalf("reset with a wrong code = %d %q, want 401 invalid_totp",
			res.status, res.code)
	}

	// ---- live code: accepted, fresh phrase issued -----------------------
	res = postReset(t, srv.URL, resetReq{
		words: words,
		code:  auth.TOTPCodeAt(secret, time.Now()),
	})
	if res.status != http.StatusOK {
		t.Fatalf("reset with a live code = %d (%s: %s); the two failed"+
			" attempts must not have consumed the recovery phrase",
			res.status, res.code, res.message)
	}
	if len(res.words) != 24 {
		t.Fatalf("reset returned %d replacement words, want 24", len(res.words))
	}
	if res.totpReset {
		t.Error("totp_reset = true, but the account kept its authenticator")
	}

	// The consumed phrase is dead; the replacement is live.
	if again := postReset(t, srv.URL, resetReq{
		words: words,
		code:  auth.TOTPCodeAt(secret, time.Now()),
	}); again.status == http.StatusOK {
		t.Error("the old recovery phrase still works after being consumed")
	}
}

// TestRecoveryResetClearsTOTPWhenAuthenticatorLost covers the other half: the
// user cannot produce a code because the authenticator is exactly what they
// lost, so the phrase stands alone and TOTP is cleared for re-enrollment.
func TestRecoveryResetClearsTOTPWhenAuthenticatorLost(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, _ := startResetTestServer(t, st)
	words, _ := signupResetUser(t, srv.URL)

	res := postReset(t, srv.URL, resetReq{words: words, resetTOTP: true})
	if res.status != http.StatusOK {
		t.Fatalf("reset with reset_totp = %d (%s: %s), want 200",
			res.status, res.code, res.message)
	}
	if !res.totpReset {
		t.Error("totp_reset = false in the response, want true")
	}

	var secretEnc []byte
	var confirmedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT ua.totp_secret_enc, ua.totp_confirmed_at
		   FROM user_auth ua JOIN users u ON u.id = ua.user_id
		  WHERE u.username = $1`, resetTestUser,
	).Scan(&secretEnc, &confirmedAt); err != nil {
		t.Fatalf("read user_auth: %v", err)
	}
	if len(secretEnc) != 0 || confirmedAt != nil {
		t.Error("TOTP secret should be cleared for re-enrollment")
	}

	// The stale password seed wraps are gone: they were sealed under the old
	// password's KEK and can never be opened again.
	var wraps int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM identity_seed_wrap w JOIN users u ON u.id = w.user_id
		  WHERE u.username = $1 AND w.method = 'password'`, resetTestUser,
	).Scan(&wraps); err != nil {
		t.Fatalf("count seed wraps: %v", err)
	}
	if wraps != 0 {
		t.Errorf("password seed wraps = %d after reset, want 0", wraps)
	}
}

// TestRecoveryResetRevokesSessions pins 81-1: recovery is the "I may be
// compromised" path, so a session that predates the reset -- the thief's --
// must not survive it, and its live WS connections must be kicked.
func TestRecoveryResetRevokesSessions(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, kicker := startResetTestServer(t, st)
	words, _ := signupResetUser(t, srv.URL)

	user, err := st.GetUserByUsername(ctx, resetTestUser)
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	stolen, err := st.CreateSession(ctx, user.ID, "thief", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	res := postReset(t, srv.URL, resetReq{words: words, resetTOTP: true})
	if res.status != http.StatusOK {
		t.Fatalf("reset = %d (%s: %s), want 200", res.status, res.code, res.message)
	}

	if _, err := st.GetSession(ctx, stolen.Token); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("pre-reset session survived the recovery reset: got %v, want ErrNotFound", err)
	}
	kicked := false
	for _, call := range kicker.calls {
		if call.userID == user.ID.String() {
			kicked = true
		}
	}
	if !kicked {
		t.Error("recovery reset did not kick the user's WS connections")
	}
}

// ---- 81-7: the phrase gate answers with one voice -----------------------

// TestRecoveryResetResponsesAreIndistinguishable is the regression test for
// the remaining half of L-01. Four ways to fail before the phrase verifies --
// no such account, no code on file, a spent code, the wrong words -- must be
// one answer, byte for byte. Anything else lets an anonymous caller ask "does
// this username exist?" and get a reply.
func TestRecoveryResetResponsesAreIndistinguishable(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, _ := startResetTestServer(t, st)
	signupResetUser(t, srv.URL)

	user, err := st.GetUserByUsername(ctx, resetTestUser)
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	// Valid-shape but wrong words. They must pass the BIP-39 checksum, or the
	// shape check answers 400 bad_phrase before the handler looks anything up
	// -- which is that check doing its job, not the path under test.
	wrong, err := auth.GenerateRecoveryWords()
	if err != nil {
		t.Fatalf("GenerateRecoveryWords: %v", err)
	}

	type probe struct {
		name   string
		setup  func()
		req    resetReq
		status int
		body   []byte
	}
	probes := []probe{
		{
			name: "no such account",
			req:  resetReq{username: "doesnotexist_xyz", words: wrong},
		},
		{
			name: "wrong phrase",
			req:  resetReq{words: wrong},
		},
		{
			name: "no recovery code on file",
			setup: func() {
				if _, err := pool.Exec(ctx,
					`DELETE FROM recovery_codes WHERE user_id = $1`, user.ID); err != nil {
					t.Fatalf("delete recovery code: %v", err)
				}
			},
			req: resetReq{words: wrong},
		},
		{
			name: "code already spent",
			setup: func() {
				if err := st.SetRecoveryCode(ctx, user.ID, bytes.Repeat([]byte{1}, 48)); err != nil {
					t.Fatalf("SetRecoveryCode: %v", err)
				}
				if _, err := pool.Exec(ctx,
					`UPDATE recovery_codes SET used_at = now() WHERE user_id = $1`,
					user.ID); err != nil {
					t.Fatalf("mark code used: %v", err)
				}
			},
			req: resetReq{words: wrong},
		},
	}

	for i := range probes {
		if probes[i].setup != nil {
			probes[i].setup()
		}
		probes[i].status, probes[i].body = postResetRaw(t, srv.URL, probes[i].req)
		if probes[i].status != http.StatusUnauthorized {
			t.Fatalf("%s = %d, want 401 (a 429 here means the per-IP recovery"+
				" budget is tighter than this test's request count)",
				probes[i].name, probes[i].status)
		}
	}
	for _, p := range probes[1:] {
		if p.status != probes[0].status || !bytes.Equal(p.body, probes[0].body) {
			t.Errorf("%q answers %d %s but %q answers %d %s; the two must be"+
				" indistinguishable or the difference is an account oracle",
				probes[0].name, probes[0].status, probes[0].body,
				p.name, p.status, p.body)
		}
	}
	if !bytes.Contains(probes[0].body, []byte(`"recovery_failed"`)) {
		t.Errorf("merged failure body = %s, want code recovery_failed", probes[0].body)
	}
}

// TestRecoveryResetSpentPhraseNeedsTheRightWords covers the deliberate
// asymmetry: "already used" is only worth saying to someone who proved they
// hold the phrase. Answering it to anyone who guessed the username is how the
// old handler leaked.
func TestRecoveryResetSpentPhraseNeedsTheRightWords(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, _ := startResetTestServer(t, st)
	words, _ := signupResetUser(t, srv.URL)

	user, err := st.GetUserByUsername(ctx, resetTestUser)
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE recovery_codes SET used_at = now() WHERE user_id = $1`, user.ID); err != nil {
		t.Fatalf("mark code used: %v", err)
	}

	wrong, err := auth.GenerateRecoveryWords()
	if err != nil {
		t.Fatalf("GenerateRecoveryWords: %v", err)
	}
	if res := postReset(t, srv.URL, resetReq{words: wrong}); res.code != "recovery_failed" {
		t.Errorf("spent code + wrong words = %d %q, want 401 recovery_failed",
			res.status, res.code)
	}
	res := postReset(t, srv.URL, resetReq{words: words, resetTOTP: true})
	if res.status != http.StatusUnauthorized || res.code != "code_used" {
		t.Errorf("spent code + the right words = %d %q, want 401 code_used --"+
			" the owner of a spent phrase should be told so", res.status, res.code)
	}
}

// TestRecoveryResetTellsAModeratedOwner pins the reordering. Blocked and
// deleted used to be answered before the phrase was checked, so 403/410 came
// back only for usernames that exist. Now a stranger gets the merged 401 and
// only the account's owner is told -- and being told must not burn the phrase.
func TestRecoveryResetTellsAModeratedOwner(t *testing.T) {
	pool, st := openClaimTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dropResetUser(t, ctx, pool)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dropResetUser(t, c, pool)
	})

	srv, _ := startResetTestServer(t, st)
	words, _ := signupResetUser(t, srv.URL)

	if _, err := pool.Exec(ctx,
		`UPDATE users SET blocked_at = now() WHERE username = $1`, resetTestUser); err != nil {
		t.Fatalf("block user: %v", err)
	}

	wrong, err := auth.GenerateRecoveryWords()
	if err != nil {
		t.Fatalf("GenerateRecoveryWords: %v", err)
	}
	if res := postReset(t, srv.URL, resetReq{words: wrong}); res.code != "recovery_failed" {
		t.Errorf("blocked account + wrong words = %d %q, want 401 recovery_failed"+
			" -- moderation state must not be readable without the phrase",
			res.status, res.code)
	}

	res := postReset(t, srv.URL, resetReq{words: words, resetTOTP: true})
	if res.status != http.StatusForbidden || res.code != "user_blocked" {
		t.Fatalf("blocked account + the right words = %d %q, want 403 user_blocked",
			res.status, res.code)
	}
	var usedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT rc.used_at FROM recovery_codes rc JOIN users u ON u.id = rc.user_id
		  WHERE u.username = $1`, resetTestUser).Scan(&usedAt); err != nil {
		t.Fatalf("read used_at: %v", err)
	}
	if usedAt != nil {
		t.Error("refusing a blocked account consumed its recovery phrase")
	}
}

// TestRecoveryResetUnknownUserStillHashes is a lower bound, never an equality:
// scheduler noise and the two-slot Argon2 semaphore make timings unstable, but
// the gap this closes is three orders of magnitude. A handler that skipped the
// hash for an unknown username returned in well under a millisecond.
func TestRecoveryResetUnknownUserStillHashes(t *testing.T) {
	_, st := openClaimTestDB(t)

	srv, _ := startResetTestServer(t, st)
	wrong, err := auth.GenerateRecoveryWords()
	if err != nil {
		t.Fatalf("GenerateRecoveryWords: %v", err)
	}

	start := time.Now()
	status, _ := postResetRaw(t, srv.URL, resetReq{
		username: "doesnotexist_xyz", words: wrong,
	})
	elapsed := time.Since(start)
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", status)
	}
	if elapsed < 10*time.Millisecond {
		t.Errorf("an unknown username answered in %v; a real 64 MiB Argon2 pass"+
			" cannot finish that fast, so the decoy verify was skipped", elapsed)
	}
}

// TestRecoveryResetRejectsBadPhraseShape: a phrase that is not 24 valid BIP-39
// words is refused on its shape alone, before any lookup. That answer is a
// function of what was typed, so it keeps a code of its own -- and needs no
// database.
func TestRecoveryResetRejectsBadPhraseShape(t *testing.T) {
	srv, _ := startResetTestServer(t, &store.Store{}) // never reached
	res := postReset(t, srv.URL, resetReq{words: []string{"only", "three", "words"}})
	if res.status != http.StatusBadRequest || res.code != "bad_phrase" {
		t.Errorf("three-word phrase = %d %q, want 400 bad_phrase", res.status, res.code)
	}
}

// ---- helpers -----------------------------------------------------------

func dropResetUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE username = $1`, resetTestUser); err != nil {
		t.Logf("cleanup %s: %v", resetTestUser, err)
	}
}

func startResetTestServer(t *testing.T, st *store.Store) (*httptest.Server, *mockKicker) {
	t.Helper()
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
	srv.Config.Handler = mux
	srv.Start()
	t.Cleanup(srv.Close)
	return srv, kicker
}

// signupResetUser drives the two-leg auth-v2 signup and returns the account's
// recovery words plus its raw TOTP secret (so the test can produce live codes).
func signupResetUser(t *testing.T, baseURL string) (words []string, secret []byte) {
	t.Helper()
	beginBody, _ := json.Marshal(map[string]any{
		"username": resetTestUser,
		"email":    resetTestEmail,
	})
	resp, err := http.Post(baseURL+"/api/auth/register/v2/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("register/v2/begin: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		t.Fatalf("register/v2/begin = %d (%s: %s)", resp.StatusCode,
			eb.Error.Code, eb.Error.Message)
	}
	var begun struct {
		SignupToken string `json:"signup_token"`
		SecretB32   string `json:"secret_b32"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&begun); err != nil {
		t.Fatalf("decode begin: %v", err)
	}
	secret, err = base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(begun.SecretB32)
	if err != nil {
		t.Fatalf("decode totp secret: %v", err)
	}

	finishBody, _ := json.Marshal(map[string]any{
		"signup_token":   begun.SignupToken,
		"totp_code":      auth.TOTPCodeAt(secret, time.Now()),
		"auth_proof_b64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)),
		"salt_b64":       base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 16)),
		"kdf_alg":        1,
		"kdf_mem_kib":    auth.Argon2MemFloorKiB(),
		"kdf_iters":      auth.Argon2ItersFloor(),
		"kdf_par":        auth.Argon2ParFloor(),
	})
	fresp, err := http.Post(baseURL+"/api/auth/register/v2/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("register/v2/finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		eb, _ := decodeError(fresp.Body)
		t.Fatalf("register/v2/finish = %d (%s: %s)", fresp.StatusCode,
			eb.Error.Code, eb.Error.Message)
	}
	var done struct {
		RecoveryWords []string `json:"recovery_words"`
	}
	if err := json.NewDecoder(fresp.Body).Decode(&done); err != nil {
		t.Fatalf("decode finish: %v", err)
	}
	if len(done.RecoveryWords) != 24 {
		t.Fatalf("signup returned %d recovery words, want 24", len(done.RecoveryWords))
	}
	return done.RecoveryWords, secret
}

type resetReq struct {
	username  string // defaults to resetTestUser
	words     []string
	code      string
	resetTOTP bool
}

// resetBody builds the /reset-auth request body. The new-password fields are
// fixed dummies: every test here is about the phrase gate, which runs long
// before anything looks at them.
func resetBody(req resetReq) []byte {
	name := req.username
	if name == "" {
		name = resetTestUser
	}
	body, _ := json.Marshal(map[string]any{
		"username":       name,
		"words":          req.words,
		"totp_code":      req.code,
		"reset_totp":     req.resetTOTP,
		"auth_proof_b64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)),
		"salt_b64":       base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 16)),
		"kdf_alg":        1,
		"kdf_mem_kib":    auth.Argon2MemFloorKiB(),
		"kdf_iters":      auth.Argon2ItersFloor(),
		"kdf_par":        auth.Argon2ParFloor(),
	})
	return body
}

// postResetRaw returns the status and the response bytes verbatim. The
// indistinguishability test compares those bytes, so nothing may decode them
// on the way through.
func postResetRaw(t *testing.T, baseURL string, req resetReq) (int, []byte) {
	t.Helper()
	resp, err := http.Post(baseURL+"/api/auth/recovery/reset-auth",
		"application/json", bytes.NewReader(resetBody(req)))
	if err != nil {
		t.Fatalf("reset-auth POST: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read reset-auth body: %v", err)
	}
	return resp.StatusCode, raw
}

type resetResult struct {
	status    int
	code      string
	message   string
	words     []string
	totpReset bool
}

func postReset(t *testing.T, baseURL string, req resetReq) resetResult {
	t.Helper()
	resp, err := http.Post(baseURL+"/api/auth/recovery/reset-auth",
		"application/json", bytes.NewReader(resetBody(req)))
	if err != nil {
		t.Fatalf("reset-auth POST: %v", err)
	}
	defer resp.Body.Close()

	out := resetResult{status: resp.StatusCode}
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		out.code, out.message = eb.Error.Code, eb.Error.Message
		return out
	}
	var ok struct {
		RecoveryWords []string `json:"recovery_words"`
		TOTPReset     bool     `json:"totp_reset"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ok); err != nil {
		t.Fatalf("decode reset-auth: %v", err)
	}
	out.words, out.totpReset = ok.RecoveryWords, ok.TOTPReset
	return out
}

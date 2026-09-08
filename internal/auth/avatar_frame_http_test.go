package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"os"
	"testing"
	"time"

	virtualwebauthn "github.com/descope/virtualwebauthn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/store"
)

// 115-5: the allowlist is the whole validation, so pin its shape: "" first
// (the picker's "none"), no duplicates, every entry short enough for the
// column's CHECK, and nothing outside it accepted.
func TestValidAvatarFrame(t *testing.T) {
	if len(auth.AvatarFrames) == 0 || auth.AvatarFrames[0] != "" {
		t.Fatalf("AvatarFrames must start with \"\" (none): %q", auth.AvatarFrames)
	}
	seen := map[string]bool{}
	for _, f := range auth.AvatarFrames {
		if seen[f] {
			t.Errorf("duplicate frame %q", f)
		}
		seen[f] = true
		if len(f) > 16 {
			t.Errorf("frame %q longer than the column allows", f)
		}
		if !auth.ValidAvatarFrame(f) {
			t.Errorf("ValidAvatarFrame(%q) = false for a listed frame", f)
		}
	}
	for _, bad := range []string{"EMBER", "ember ", "steam", "<b>", "none"} {
		if auth.ValidAvatarFrame(bad) {
			t.Errorf("ValidAvatarFrame(%q) = true", bad)
		}
	}
}

// putFrame sends PUT /api/auth/avatar-frame with the client's cookies and
// returns the status and decoded body (error body on a 4xx).
func putFrame(t *testing.T, client *http.Client, baseURL, frame string) (int, string, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"avatar_frame": frame})
	req, err := http.NewRequest(http.MethodPut, baseURL+"/api/auth/avatar-frame", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PUT avatar-frame: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		eb, _ := decodeError(resp.Body)
		return resp.StatusCode, eb.Error.Code, ""
	}
	var out struct {
		AvatarFrame string `json:"avatar_frame"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode avatar-frame response: %v", err)
	}
	return resp.StatusCode, "", out.AvatarFrame
}

func meFrame(t *testing.T, client *http.Client, baseURL string) string {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/auth/me")
	if err != nil {
		t.Fatalf("me GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/me status = %d", resp.StatusCode)
	}
	var out struct {
		AvatarFrame string `json:"avatar_frame"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	return out.AvatarFrame
}

// TestAvatarFrameEndToEnd: the wearer sets a frame, sees it on /me, and a
// second account sees it on the directory; junk is refused; "" clears.
func TestAvatarFrameEndToEnd(t *testing.T) {
	dbURL := os.Getenv("CHALK_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CHALK_TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	st := &store.Store{Pool: pool}

	const wearer = "aftestwearer"
	const viewer = "aftestviewer"
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE username IN ($1, $2)`, wearer, viewer)
	}
	cleanup()
	defer cleanup()

	t.Setenv("CHALK_OPEN_REGISTRATION", "1")
	srv, deps, mux := setupTestServerWithStore(t, st)
	defer srv.Close()
	if err := deps.MountUserLookup(mux); err != nil {
		t.Fatalf("MountUserLookup: %v", err)
	}

	newClient := func(username string) *http.Client {
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar}
		rp := virtualwebauthn.RelyingParty{Name: testRPName, ID: testRPID, Origin: srv.URL}
		vAuth := virtualwebauthn.NewAuthenticator()
		vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
		registerUser(t, client, srv.URL, rp, vAuth, vCred, username)
		return client
	}
	wearerClient := newClient(wearer)
	viewerClient := newClient(viewer)

	// No session: refused before the body is read.
	if status, code, _ := putFrame(t, &http.Client{}, srv.URL, "ember"); status != http.StatusUnauthorized {
		t.Errorf("anonymous PUT: status = %d (%s), want 401", status, code)
	}

	// Fresh account: no frame.
	if got := meFrame(t, wearerClient, srv.URL); got != "" {
		t.Errorf("fresh /me avatar_frame = %q, want empty", got)
	}

	// Junk is refused and changes nothing.
	if status, code, _ := putFrame(t, wearerClient, srv.URL, "steam"); status != http.StatusBadRequest || code != "bad_frame" {
		t.Errorf("junk PUT: status = %d code = %q, want 400 bad_frame", status, code)
	}

	// A real frame sticks, and /me says so.
	if status, _, got := putFrame(t, wearerClient, srv.URL, "ember"); status != http.StatusOK || got != "ember" {
		t.Fatalf("PUT ember: status = %d body = %q", status, got)
	}
	if got := meFrame(t, wearerClient, srv.URL); got != "ember" {
		t.Errorf("/me avatar_frame = %q, want ember", got)
	}

	// The viewer's directory carries it.
	dirResp, err := viewerClient.Get(srv.URL + "/api/users/directory")
	if err != nil {
		t.Fatalf("directory GET: %v", err)
	}
	defer dirResp.Body.Close()
	if dirResp.StatusCode != http.StatusOK {
		t.Fatalf("directory status = %d", dirResp.StatusCode)
	}
	var dir struct {
		Users []struct {
			Username    string `json:"username"`
			AvatarFrame string `json:"avatar_frame"`
		} `json:"users"`
	}
	if err := json.NewDecoder(dirResp.Body).Decode(&dir); err != nil {
		t.Fatalf("decode directory: %v", err)
	}
	found := false
	for _, u := range dir.Users {
		if u.Username == wearer {
			found = true
			if u.AvatarFrame != "ember" {
				t.Errorf("directory avatar_frame for %s = %q, want ember", wearer, u.AvatarFrame)
			}
		}
	}
	if !found {
		t.Errorf("directory does not list %s", wearer)
	}

	// Empty clears.
	if status, _, got := putFrame(t, wearerClient, srv.URL, ""); status != http.StatusOK || got != "" {
		t.Fatalf("PUT clear: status = %d body = %q", status, got)
	}
	if got := meFrame(t, wearerClient, srv.URL); got != "" {
		t.Errorf("/me avatar_frame after clear = %q, want empty", got)
	}
}

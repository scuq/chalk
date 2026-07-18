package turncred

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestMintFormatAndHMAC(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	secret := "devsecret"
	userID := "0f9c2b7e-1111-2222-3333-444455556666"

	user, cred := Mint(secret, userID, time.Hour, now)

	wantUser := "1700003600:" + userID // now + 3600s
	if user != wantUser {
		t.Fatalf("username = %q, want %q", user, wantUser)
	}

	// Recompute the HMAC exactly as coturn does with --static-auth-secret.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(wantUser))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if cred != wantCred {
		t.Fatalf("credential = %q, want %q", cred, wantCred)
	}

	// Decodes to a 20-byte SHA-1 MAC.
	raw, err := base64.StdEncoding.DecodeString(cred)
	if err != nil {
		t.Fatalf("credential not base64: %v", err)
	}
	if len(raw) != sha1.Size {
		t.Fatalf("mac length = %d, want %d", len(raw), sha1.Size)
	}
}

func TestMintDiffersByUserSecretAndTime(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()

	u1, c1 := Mint("s", "alice", time.Hour, now)
	u2, c2 := Mint("s", "bob", time.Hour, now)
	if u1 == u2 || c1 == c2 {
		t.Fatal("different users must yield different creds")
	}

	_, c3 := Mint("other", "alice", time.Hour, now)
	if c3 == c1 {
		t.Fatal("different secrets must yield different creds")
	}

	u4, _ := Mint("s", "alice", 2*time.Hour, now)
	if u4 == u1 {
		t.Fatal("different TTLs must yield different (expiry-prefixed) usernames")
	}
	if !strings.HasSuffix(u4, ":alice") {
		t.Fatalf("username %q must end with :<user_id>", u4)
	}
}

func TestICEServers(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	stun := []string{"stun:stun.example.org:3478"}
	turn := []string{
		"turn:203.0.113.7:3478?transport=udp",
		"turns:203.0.113.7:5349?transport=tcp",
	}

	// Full config: STUN entry (no creds) + one TURN entry (shared creds).
	list := ICEServers(stun, turn, "devsecret", "alice", time.Hour, now)
	if len(list) != 2 {
		t.Fatalf("len = %d, want 2", len(list))
	}
	if list[0].Username != "" || list[0].Credential != "" {
		t.Fatal("STUN entry must be credential-less")
	}
	if len(list[1].URLs) != 2 {
		t.Fatalf("TURN entry URLs = %d, want 2 (all TURN URIs share one credential)", len(list[1].URLs))
	}
	if list[1].Username == "" || list[1].Credential == "" {
		t.Fatal("TURN entry must carry minted creds")
	}
	wantUser, wantCred := Mint("devsecret", "alice", time.Hour, now)
	if list[1].Username != wantUser || list[1].Credential != wantCred {
		t.Fatal("TURN entry creds must equal Mint output for same inputs")
	}

	// STUN-only degraded mode: no TURN URLs configured.
	deg := ICEServers(stun, nil, "", "alice", time.Hour, now)
	if len(deg) != 1 || deg[0].Username != "" {
		t.Fatal("empty turnURLs must yield a STUN-only, credential-less list")
	}

	// Nothing configured at all.
	if got := ICEServers(nil, nil, "", "alice", time.Hour, now); len(got) != 0 {
		t.Fatalf("no URLs must yield empty list, got %d", len(got))
	}
}

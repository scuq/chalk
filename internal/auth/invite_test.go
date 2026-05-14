package auth

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestGenerateInviteToken_Length(t *testing.T) {
	tok, err := GenerateInviteToken()
	if err != nil {
		t.Fatalf("GenerateInviteToken: %v", err)
	}
	if len(tok) != InviteTokenSize {
		t.Errorf("token length = %d, want %d", len(tok), InviteTokenSize)
	}
}

func TestGenerateInviteToken_Uniqueness(t *testing.T) {
	a, _ := GenerateInviteToken()
	b, _ := GenerateInviteToken()
	if bytes.Equal(a, b) {
		t.Errorf("two consecutive tokens collided (CSPRNG broken?)")
	}
}

func TestEncodeDecodeRoundtrip(t *testing.T) {
	orig, err := GenerateInviteToken()
	if err != nil {
		t.Fatal(err)
	}
	encoded := EncodeInviteToken(orig)
	// 32 bytes → 43 chars in unpadded base64url.
	if len(encoded) != 43 {
		t.Errorf("encoded length = %d, want 43", len(encoded))
	}
	// URL-safe alphabet only.
	if strings.ContainsAny(encoded, "+/=") {
		t.Errorf("encoded contains non-URL-safe characters: %q", encoded)
	}
	decoded, err := DecodeInviteToken(encoded)
	if err != nil {
		t.Fatalf("DecodeInviteToken: %v", err)
	}
	if !bytes.Equal(orig, decoded) {
		t.Errorf("roundtrip mismatch")
	}
}

func TestDecodeInviteToken_AcceptsPadded(t *testing.T) {
	orig, _ := GenerateInviteToken()
	unpadded := EncodeInviteToken(orig)
	// Some HTTP libraries normalize URLs and add padding back.
	// Convert to padded by adjusting alphabet and adding '='.
	padded := strings.ReplaceAll(unpadded, "-", "+")
	padded = strings.ReplaceAll(padded, "_", "/")
	for len(padded)%4 != 0 {
		padded += "="
	}
	// Now convert back to URL-safe (preserving padding).
	padded = strings.ReplaceAll(padded, "+", "-")
	padded = strings.ReplaceAll(padded, "/", "_")
	decoded, err := DecodeInviteToken(padded)
	if err != nil {
		t.Fatalf("DecodeInviteToken (padded form): %v", err)
	}
	if !bytes.Equal(orig, decoded) {
		t.Errorf("padded-form roundtrip mismatch")
	}
}

func TestDecodeInviteToken_RejectsEmpty(t *testing.T) {
	if _, err := DecodeInviteToken(""); err == nil {
		t.Error("expected error for empty string")
	}
	if _, err := DecodeInviteToken("   "); err == nil {
		t.Error("expected error for whitespace-only string")
	}
}

func TestDecodeInviteToken_RejectsWrongLength(t *testing.T) {
	// Valid base64 but not 32 bytes.
	short := EncodeInviteToken([]byte("too-short"))
	if _, err := DecodeInviteToken(short); err == nil {
		t.Error("expected error for short decoded length")
	}
	long := EncodeInviteToken(bytes.Repeat([]byte{0x42}, 64))
	if _, err := DecodeInviteToken(long); err == nil {
		t.Error("expected error for long decoded length")
	}
}

func TestDecodeInviteToken_RejectsGarbage(t *testing.T) {
	if _, err := DecodeInviteToken("not!!!base64!!!at!!!all"); err == nil {
		t.Error("expected error for non-base64 input")
	}
}

func TestInviteTTL_Default(t *testing.T) {
	t.Setenv("CHALK_INVITE_TTL_DAYS", "")
	got := InviteTTL()
	want := time.Duration(DefaultInviteTTLDays) * 24 * time.Hour
	if got != want {
		t.Errorf("default TTL = %v, want %v", got, want)
	}
}

func TestInviteTTL_FromEnv(t *testing.T) {
	t.Setenv("CHALK_INVITE_TTL_DAYS", "7")
	got := InviteTTL()
	want := 7 * 24 * time.Hour
	if got != want {
		t.Errorf("TTL = %v, want %v", got, want)
	}
}

func TestInviteTTL_RejectsInvalid(t *testing.T) {
	cases := []string{"abc", "0", "-5", "1.5", ""}
	for _, c := range cases {
		t.Setenv("CHALK_INVITE_TTL_DAYS", c)
		got := InviteTTL()
		// Invalid values fall back to default.
		// Exception: "" is allowed and means default.
		want := time.Duration(DefaultInviteTTLDays) * 24 * time.Hour
		if got != want {
			t.Errorf("TTL with invalid %q = %v, want default %v", c, got, want)
		}
	}
}

func TestInviteTTL_ClampsHigh(t *testing.T) {
	t.Setenv("CHALK_INVITE_TTL_DAYS", "365")
	got := InviteTTL()
	want := 60 * 24 * time.Hour
	if got != want {
		t.Errorf("TTL with 365 = %v, want clamped to 60d %v", got, want)
	}
}

func TestBuildInviteURL(t *testing.T) {
	cases := []struct {
		base, encoded, want string
	}{
		{"https://chalk.example", "abc123", "https://chalk.example/?invite=abc123"},
		{"https://chalk.example/", "abc123", "https://chalk.example/?invite=abc123"},
		{"", "tok", "/?invite=tok"},
		{"http://localhost:8443", "x_y-z", "http://localhost:8443/?invite=x_y-z"},
	}
	for _, c := range cases {
		got := BuildInviteURL(c.base, c.encoded)
		if got != c.want {
			t.Errorf("BuildInviteURL(%q, %q) = %q, want %q",
				c.base, c.encoded, got, c.want)
		}
	}
}

func TestBuildEmailChangeVerifyURL(t *testing.T) {
	got := BuildEmailChangeVerifyURL("https://chalk.example", "ttt")
	want := "https://chalk.example/?verify_email=ttt"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

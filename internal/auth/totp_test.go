// chalk -- phase31-slice31-3 TOTP tests.
package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// rfc4226Key is the ASCII seed "12345678901234567890" used by the canonical
// RFC 4226 Appendix D HOTP test vectors.
var rfc4226Key = []byte("12345678901234567890")

func TestHOTPRFC4226Vectors(t *testing.T) {
	want := []string{
		"755224", "287082", "359152", "969429", "338314",
		"254676", "287922", "162583", "399871", "520489",
	}
	for c, exp := range want {
		got := HOTPCode(rfc4226Key, uint64(c), 6)
		if got != exp {
			t.Errorf("HOTP counter=%d: got %s want %s", c, got, exp)
		}
	}
}

func TestTOTPCodeAtRFC6238(t *testing.T) {
	// RFC 6238 Appendix B (SHA1 seed), 8-digit codes truncated to our 6.
	cases := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
	}
	for _, c := range cases {
		got := TOTPCodeAt(rfc4226Key, time.Unix(c.unix, 0))
		if got != c.want {
			t.Errorf("TOTP @%d: got %s want %s", c.unix, got, c.want)
		}
	}
}

func TestValidateTOTPSkewAndStep(t *testing.T) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	curStep := TOTPStep(now)

	// exact code validates and reports the current step
	code := TOTPCodeAt(secret, now)
	step, ok := ValidateTOTP(secret, code, now, 1)
	if !ok || step != curStep {
		t.Fatalf("exact code: ok=%v step=%d want step=%d", ok, step, curStep)
	}

	// a code from the previous step validates within skew=1
	prev := TOTPCodeAt(secret, now.Add(-30*time.Second))
	step, ok = ValidateTOTP(secret, prev, now, 1)
	if !ok || step != curStep-1 {
		t.Fatalf("prev-step code: ok=%v step=%d want %d", ok, step, curStep-1)
	}

	// but not with skew=0
	if _, ok := ValidateTOTP(secret, prev, now, 0); ok {
		t.Fatal("prev-step code accepted with skew=0")
	}

	// a wrong code is rejected
	if _, ok := ValidateTOTP(secret, "000000", now, 1); ok {
		// vanishingly unlikely to be the real code; guard anyway
		if TOTPCodeAt(secret, now) != "000000" {
			t.Fatal("wrong code accepted")
		}
	}
}

func TestTOTPSecretEncryptRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("CHALK_TOTP_ENC_KEY", base64.StdEncoding.EncodeToString(key))

	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	blob, err := EncryptTOTPSecret(secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	got, err := DecryptTOTPSecret(blob)
	if err != nil {
		t.Fatalf("DecryptTOTPSecret: %v", err)
	}
	if string(got) != string(secret) {
		t.Fatal("round-trip mismatch")
	}

	// wrong key must fail to open
	other := make([]byte, 32)
	other[0] = 0xff
	t.Setenv("CHALK_TOTP_ENC_KEY", base64.StdEncoding.EncodeToString(other))
	if _, err := DecryptTOTPSecret(blob); err == nil {
		t.Fatal("decrypt succeeded under wrong key")
	}
}

func TestTOTPEncKeyUnset(t *testing.T) {
	t.Setenv("CHALK_TOTP_ENC_KEY", "")
	if _, err := EncryptTOTPSecret([]byte("x")); err != ErrTOTPEncKeyUnset {
		t.Fatalf("want ErrTOTPEncKeyUnset, got %v", err)
	}
}

func TestProvisioningURI(t *testing.T) {
	secret := []byte("12345678901234567890")
	uri := ProvisioningURI("alice", secret)
	if !strings.HasPrefix(uri, "otpauth://totp/") {
		t.Fatalf("bad scheme: %s", uri)
	}
	for _, want := range []string{"secret=", "issuer=", "algorithm=SHA1", "digits=6", "period=30"} {
		if !strings.Contains(uri, want) {
			t.Errorf("URI missing %q: %s", want, uri)
		}
	}
}

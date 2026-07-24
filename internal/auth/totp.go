// chalk -- phase31-slice31-3 TOTP engine (native RFC 6238).
//
// A dependency-free RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation on the
// standard library, chosen over a third-party module to keep the auth path
// free of new dependencies (mirroring chalk's hand-rolled BIP-39) and the
// applier self-contained. Correctness is pinned by the canonical RFC 4226
// HOTP vectors in totp_test.go.
//
// Parameters are the authenticator-app defaults so any standard app (Google
// Authenticator, Aegis, 1Password, ...) interoperates: HMAC-SHA1, 6 digits,
// 30-second period, 160-bit (20-byte) secret.
//
// TOTP secrets are shared secrets: whoever holds one can mint valid codes.
// They are stored AES-256-GCM-encrypted at rest under CHALK_TOTP_ENC_KEY
// (server-symmetric; distinct from E2E -- TOTP is authentication, not key
// material, so the server is allowed to decrypt it).
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	totpPeriod    = 30 // seconds
	totpDigits    = 6
	totpSecretLen = 20 // bytes (160-bit)
)

var totpB32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// ---- secret generation / encoding ----------------------------------------

// GenerateTOTPSecret returns a fresh 20-byte random TOTP secret.
func GenerateTOTPSecret() ([]byte, error) {
	s := make([]byte, totpSecretLen)
	if _, err := rand.Read(s); err != nil {
		return nil, fmt.Errorf("generate totp secret: %w", err)
	}
	return s, nil
}

// TOTPSecretBase32 renders a secret as unpadded uppercase base32, the form
// authenticator apps expect for manual entry and inside the otpauth URI.
func TOTPSecretBase32(secret []byte) string { return totpB32.EncodeToString(secret) }

// ProvisioningURI builds the otpauth:// URI the client renders as a QR code.
func ProvisioningURI(account string, secret []byte) string {
	issuer := TOTPIssuer()
	label := url.PathEscape(issuer) + ":" + url.PathEscape(account)
	q := url.Values{}
	q.Set("secret", TOTPSecretBase32(secret))
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", strconv.Itoa(totpDigits))
	q.Set("period", strconv.Itoa(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// ---- HOTP / TOTP ---------------------------------------------------------

// HOTPCode computes the RFC 4226 HOTP value for key and counter, as a
// zero-padded decimal string of the given digit count.
func HOTPCode(key []byte, counter uint64, digits int) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	off := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[off]&0x7f) << 24) |
		(uint32(sum[off+1]) << 16) |
		(uint32(sum[off+2]) << 8) |
		uint32(sum[off+3])

	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, bin%mod)
}

// TOTPStep returns the RFC 6238 time step for t.
func TOTPStep(t time.Time) int64 { return t.Unix() / int64(totpPeriod) }

// TOTPCodeAt returns the 6-digit TOTP for secret at time t.
func TOTPCodeAt(secret []byte, t time.Time) string {
	return HOTPCode(secret, uint64(TOTPStep(t)), totpDigits)
}

// ValidateTOTP checks code against secret within +/-skew steps of now. On a
// match it returns the matched step and true; otherwise 0 and false. The
// per-candidate comparison is constant-time. The caller enforces replay
// (matched step must exceed the last consumed step) at the DB layer.
func ValidateTOTP(secret []byte, code string, now time.Time, skew int) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return 0, false
	}
	if skew < 0 {
		skew = 0
	}
	cur := TOTPStep(now)
	for d := -skew; d <= skew; d++ {
		step := cur + int64(d)
		want := HOTPCode(secret, uint64(step), totpDigits)
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// ---- secret encryption at rest -------------------------------------------

// ErrTOTPEncKeyUnset is returned when CHALK_TOTP_ENC_KEY is required (to store
// or read a TOTP secret) but is not configured.
var ErrTOTPEncKeyUnset = errors.New("auth: CHALK_TOTP_ENC_KEY not set (required to store TOTP secrets)")

func loadTOTPEncKey() ([]byte, error) {
	v := strings.TrimSpace(os.Getenv("CHALK_TOTP_ENC_KEY"))
	if v == "" {
		return nil, ErrTOTPEncKeyUnset
	}
	key, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("CHALK_TOTP_ENC_KEY: invalid base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("CHALK_TOTP_ENC_KEY: must decode to 32 bytes, got %d", len(key))
	}
	return key, nil
}

func newTOTPGCM() (cipher.AEAD, error) {
	key, err := loadTOTPEncKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("totp aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("totp gcm: %w", err)
	}
	return gcm, nil
}

// EncryptTOTPSecret seals a TOTP secret as nonce||ciphertext||tag under
// CHALK_TOTP_ENC_KEY. Returns ErrTOTPEncKeyUnset if the key is not configured.
func EncryptTOTPSecret(plaintext []byte) ([]byte, error) {
	gcm, err := newTOTPGCM()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("totp nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// DecryptTOTPSecret opens a blob produced by EncryptTOTPSecret.
func DecryptTOTPSecret(blob []byte) ([]byte, error) {
	gcm, err := newTOTPGCM()
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, errors.New("auth: totp secret blob too short")
	}
	nonce, ct := blob[:ns], blob[ns:]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("totp decrypt: %w", err)
	}
	return pt, nil
}

// ---- config (env, openreg.go pattern) ------------------------------------

// TOTPIssuer is the issuer label in the provisioning URI. CHALK_TOTP_ISSUER,
// default "Chalk".
func TOTPIssuer() string {
	if v := strings.TrimSpace(os.Getenv("CHALK_TOTP_ISSUER")); v != "" {
		return v
	}
	return "Chalk"
}

// TOTPSkew is the accepted +/- period skew. CHALK_TOTP_SKEW, default 1, min 0.
func TOTPSkew() int { return totpEnvInt("CHALK_TOTP_SKEW", 1, 0) }

// TOTPMaxFailures is the failed-code count that triggers lockout.
// CHALK_TOTP_MAX_FAILURES, default 5, min 1.
func TOTPMaxFailures() int { return totpEnvInt("CHALK_TOTP_MAX_FAILURES", 5, 1) }

// TOTPLockout is the lockout duration after too many failures.
// CHALK_TOTP_LOCKOUT (seconds), default 900, min 1.
func TOTPLockout() time.Duration {
	return time.Duration(totpEnvInt("CHALK_TOTP_LOCKOUT", 900, 1)) * time.Second
}

func totpEnvInt(key string, def, min int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min {
		return def
	}
	return n
}

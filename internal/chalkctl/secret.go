package chalkctl

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
)

// genSecret returns a URL-safe base64 secret from nBytes of CSPRNG entropy.
// 24 bytes -> 32 chars, ample for the PG password and the coturn HMAC secret.
func genSecret(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	// URL-safe, no padding: avoids '/', '+', '=' that complicate env files.
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// genTOTPEncKey returns a fresh CHALK_TOTP_ENC_KEY value: 32 bytes of CSPRNG
// entropy, STANDARD base64 (chalkd decodes it with base64.StdEncoding and
// requires exactly 32 bytes -- phase31-slice31-10).
func genTOTPEncKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate TOTP enc key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}

// ensureTOTPEncKey backfills CHALK_TOTP_ENC_KEY into an existing env file if
// (and only if) it is absent -- the upgrade path for deployments initialized
// before auth v2. A PRESENT key is never touched: regenerating it would make
// every stored TOTP secret undecryptable. Returns whether a key was added.
func ensureTOTPEncKey(envPath string, log io.Writer) (bool, error) {
	existing, err := readEnvSecrets(envPath)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", envPath, err)
	}
	if existing["CHALK_TOTP_ENC_KEY"] != "" {
		return false, nil
	}
	key, err := genTOTPEncKey()
	if err != nil {
		return false, err
	}
	f, err := os.OpenFile(envPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return false, fmt.Errorf("open %s for append: %w", envPath, err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f,
		"\n# --- auth v2 (backfilled by chalkctl; TOTP secrets encrypted at rest) ---\nCHALK_TOTP_ENC_KEY=%s\n",
		key); err != nil {
		return false, fmt.Errorf("append to %s: %w", envPath, err)
	}
	fmt.Fprintf(log, "  backfilled CHALK_TOTP_ENC_KEY into %s (auth v2)\n", envPath)
	return true, nil
}

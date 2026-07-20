package chalkctl

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
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

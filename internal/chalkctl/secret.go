package chalkctl

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"github.com/scuq/chalk/internal/innerchan"
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

// genServerIDKey returns a fresh CHALK_SERVER_ID_KEY value (83-6): the
// 32-byte Ed25519 seed of chalkd's long-term identity, standard base64.
func genServerIDKey() (string, error) {
	return innerchan.GenerateServerKey()
}

// ensureServerIDKey backfills CHALK_SERVER_ID_KEY into an existing env file
// if (and only if) it is absent -- the upgrade path for deployments
// initialized before phase 83. A PRESENT key is never touched: every client
// has pinned it. Returns whether a key was added.
func ensureServerIDKey(envPath string, log io.Writer) (bool, error) {
	key, err := genServerIDKey()
	if err != nil {
		return false, err
	}
	return appendEnvVar(envPath, "CHALK_SERVER_ID_KEY", key,
		"phase 83 server identity (backfilled by chalkctl; clients pin this -- never regenerate casually)", log)
}

// genDecoyKey returns a fresh CHALK_AUTH_DECOY_KEY value: 32 bytes of CSPRNG
// entropy, STANDARD base64 (chalkd decodes it with base64.StdEncoding and
// wants at least 32 bytes -- internal/auth/password.go).
//
// 81-3: without it chalkd randomizes the key per process, so the fake KDF
// params it hands back for unknown usernames change on every restart while
// real ones stay put -- which is exactly the tell the decoys exist to hide.
func genDecoyKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate decoy key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}

// appendEnvVar adds key=value to an existing env file if (and only if) the key
// is absent, under the given comment header. A PRESENT value is never touched
// -- that is the whole contract these backfills rest on. Returns whether the
// line was added.
func appendEnvVar(envPath, key, value, comment string, log io.Writer) (bool, error) {
	existing, err := readEnvSecrets(envPath)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", envPath, err)
	}
	if existing[key] != "" {
		return false, nil
	}
	f, err := os.OpenFile(envPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return false, fmt.Errorf("open %s for append: %w", envPath, err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, "\n# --- %s ---\n%s=%s\n", comment, key, value); err != nil {
		return false, fmt.Errorf("append to %s: %w", envPath, err)
	}
	fmt.Fprintf(log, "  backfilled %s into %s\n", key, envPath)
	return true, nil
}

// ensureTOTPEncKey backfills CHALK_TOTP_ENC_KEY into an existing env file if
// (and only if) it is absent -- the upgrade path for deployments initialized
// before auth v2. A PRESENT key is never touched: regenerating it would make
// every stored TOTP secret undecryptable. Returns whether a key was added.
func ensureTOTPEncKey(envPath string, log io.Writer) (bool, error) {
	key, err := genTOTPEncKey()
	if err != nil {
		return false, err
	}
	return appendEnvVar(envPath, "CHALK_TOTP_ENC_KEY", key,
		"auth v2 (backfilled by chalkctl; TOTP secrets encrypted at rest)", log)
}

// ensurePhase81Env backfills the 81-3 settings into an existing env file.
//
// CHALK_TRUSTED_PROXY: without it chalkd sees every request as coming from the
// Caddy container, so the per-IP rate limits share one bucket for the whole
// internet and session rows record the proxy's address instead of the client's.
//
// CHALK_AUTH_DECOY_KEY: see genDecoyKey. Backfilling shifts the decoy salts
// once, which is harmless -- they are fake by construction.
//
// CHALK_EPHEMERAL_ENABLED: the code default flipped to false in 81-3, so a
// deployment that relied on the old default-on has to be told explicitly, or
// its guest links would stop working on the next update.
func ensurePhase81Env(envPath string, log io.Writer) error {
	if _, err := appendEnvVar(envPath, "CHALK_TRUSTED_PROXY", "private",
		"trusted proxy (chalkctl's Caddy; makes per-IP rate limits see real clients)",
		log); err != nil {
		return err
	}
	key, err := genDecoyKey()
	if err != nil {
		return err
	}
	if _, err := appendEnvVar(envPath, "CHALK_AUTH_DECOY_KEY", key,
		"stable decoy KDF params for unknown usernames (backfilled by chalkctl)",
		log); err != nil {
		return err
	}
	_, err = appendEnvVar(envPath, "CHALK_EPHEMERAL_ENABLED", "true",
		"guest voice rooms (pinned by chalkctl; the server default is now off)",
		log)
	return err
}

// ensurePhase82Env backfills CHALK_WRAP_SIG_REQUIRED=false into an existing
// env file (82-6). Writing it makes the enforcement knob VISIBLE to the
// operator, and pins today's behaviour against any change of the chalkd
// default -- flipping a deployed server to enforcement must always be the
// operator's explicit act, because doing it before the self-healing sweep has
// re-signed the existing wraps locks members out of their channels. A present
// value, either way, is never touched.
//
// 82-10 made chalkd's own default true and `chalkctl init` write true, and
// this still writes FALSE, which is the point rather than an oversight: an
// `update` runs against a deployment that already has channels full of
// unsigned wraps. `chalkctl wrapsig status` says when it is safe to flip, and
// `chalkctl wrapsig enable` is what flips it.
func ensurePhase82Env(envPath string, log io.Writer) error {
	_, err := appendEnvVar(envPath, "CHALK_WRAP_SIG_REQUIRED", "false",
		"signed channel-key wraps (backfilled by chalkctl; flip to true after the re-sign sweep, see docs/phases/PHASE-82-SIGNEDWRAP.md)",
		log)
	return err
}

// ensurePhase85Env backfills the operational-logging knobs into an existing env
// file. All three are written with the value chalkd would have assumed anyway;
// the point is to put them in front of the operator, because a knob nobody
// knows about is a knob nobody turns on.
//
// CHALK_OPLOG_SNAPSHOT_INTERVAL is backfilled as an explicit 0 rather than
// left empty. Empty reads as absent to appendEnvVar, so an empty backfill
// would append the same line on every update; 0 says the same thing and says
// it once.
func ensurePhase85Env(envPath string, log io.Writer) error {
	if _, err := appendEnvVar(envPath, "CHALK_OPLOG_SECURITY", "true",
		"log security events: lockouts, rate-limit denials, login outcomes (backfilled by chalkctl)",
		log); err != nil {
		return err
	}
	if _, err := appendEnvVar(envPath, "CHALK_OPLOG_SNAPSHOT_INTERVAL", "0",
		"periodic log of who is connected and from which address; 0 = off, set e.g. 5m to enable (backfilled by chalkctl)",
		log); err != nil {
		return err
	}
	_, err := appendEnvVar(envPath, "CHALK_OPLOG_SLOW_REQUEST", "2s",
		"log HTTP requests slower than this; 0 = off (backfilled by chalkctl)",
		log)
	return err
}

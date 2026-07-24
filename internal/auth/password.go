// chalk -- phase31-slice31-2 password auth helpers.
//
// Server-side half of password authentication. The password itself and the
// key-wrapping KEK never reach the server (see docs/phase-31 Addendum D):
// the client derives authProof = HKDF(Argon2id(password, salt), "chalk/auth")
// and sends only authProof. The server stores SHA-256(authProof) in
// user_auth.auth_proof_hash and constant-time compares on login.
//
// Why SHA-256 and not another Argon2 pass: authProof is already a 256-bit
// high-entropy output of a memory-hard KDF run client-side. A second
// expensive server hash would add login latency without meaningful security
// (a preimage of a 256-bit random is infeasible); the offline-attack cost a
// DB leak faces is the CLIENT Argon2id, governed by the parameter floor
// below and the >=20-char password policy.
//
// This file is helpers only; the HTTP handlers live in
// login_password_http.go, the pending-2FA cache in totp_pending.go.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"os"
	"strconv"
	"strings"
	"sync"
)

// KDFParams are the client-side Argon2id parameters plus salt for one
// account. They are PUBLIC (a login client must fetch them before it can
// derive authProof); secrecy rests entirely on the password. Alg is the
// user_auth.kdf_alg tag (1 = argon2id).
type KDFParams struct {
	Alg    int16
	MemKiB int32
	Iters  int32
	Par    int32
	Salt   []byte
}

// ---- Argon2id parameter floor (enrollment) -------------------------------
//
// These are the MINIMUM client parameters the server accepts at enrollment
// (signup / migration / change-password, later slices). Login does not
// re-check them -- the stored params are used as-is so the same password
// reproduces authProof. Read from env, mirroring openreg.go's pattern so
// tests can t.Setenv without rebuilding a Config.
//
//	CHALK_AUTH_ARGON2_MEM_KIB   default 262144 (256 MiB)
//	CHALK_AUTH_ARGON2_ITERS     default 3
//	CHALK_AUTH_ARGON2_PAR       default 1
//
// The DB also fences kdf_mem_kib >= 8192 as defence in depth; the env floor
// is the higher recommended value.

const (
	defaultArgon2MemKiB int32 = 262144
	defaultArgon2Iters  int32 = 3
	defaultArgon2Par    int32 = 1
)

// Argon2MemFloorKiB returns the configured minimum Argon2id memory cost.
func Argon2MemFloorKiB() int32 { return envInt32("CHALK_AUTH_ARGON2_MEM_KIB", defaultArgon2MemKiB) }

// Argon2ItersFloor returns the configured minimum Argon2id iteration count.
func Argon2ItersFloor() int32 { return envInt32("CHALK_AUTH_ARGON2_ITERS", defaultArgon2Iters) }

// Argon2ParFloor returns the configured minimum Argon2id parallelism.
func Argon2ParFloor() int32 { return envInt32("CHALK_AUTH_ARGON2_PAR", defaultArgon2Par) }

// ParamsMeetFloor reports whether client-submitted Argon2id parameters are at
// or above the configured floor. Enrollment handlers (later slices) call this
// to reject a client that lowballs its KDF cost. alg must be 1 (argon2id).
func ParamsMeetFloor(alg int16, memKiB, iters, par int32) bool {
	if alg != 1 {
		return false
	}
	return memKiB >= Argon2MemFloorKiB() &&
		iters >= Argon2ItersFloor() &&
		par >= Argon2ParFloor()
}

// ---- authProof hashing / verification ------------------------------------

// HashAuthProof returns the value stored in user_auth.auth_proof_hash for a
// given client authProof: SHA-256(authProof). Enrollment handlers use this to
// compute the stored hash; the verify path recomputes and compares.
func HashAuthProof(authProof []byte) []byte {
	sum := sha256.Sum256(authProof)
	return sum[:]
}

// VerifyAuthProof reports whether authProof hashes to storedHash, in constant
// time. A zero-length storedHash (no enrollment) always returns false but
// still performs the compare against a dummy of equal length so callers can
// keep timing uniform.
func VerifyAuthProof(storedHash, authProof []byte) bool {
	got := HashAuthProof(authProof)
	if len(storedHash) != len(got) {
		// Compare against a dummy to avoid a fast length-based early return.
		subtle.ConstantTimeCompare(got, got)
		return false
	}
	return subtle.ConstantTimeCompare(got, storedHash) == 1
}

// ---- anti-enumeration decoy params ---------------------------------------
//
// prelogin must return KDF params for ANY username, or it becomes a user-
// existence oracle. For an unknown (or not-yet-password-enrolled) username we
// return deterministic decoy params that are indistinguishable from a real
// enrollment: floor Argon2id parameters and a salt derived by HMAC over the
// username. Deterministic so repeated prelogins for the same username return
// the same salt (a changing salt would itself leak).
//
// The decoy HMAC key comes from CHALK_AUTH_DECOY_KEY (base64, >=32 bytes) when
// set, so decoys are stable across restarts. When unset, a per-process random
// key is generated once; decoys are then stable within a process lifetime,
// which is sufficient to defeat same-session enumeration. Operators who want
// cross-restart stability set the env var.

var (
	decoyKeyOnce sync.Once
	decoyKey     []byte
)

func decoyHMACKey() []byte {
	decoyKeyOnce.Do(func() {
		if v := strings.TrimSpace(os.Getenv("CHALK_AUTH_DECOY_KEY")); v != "" {
			if k, err := base64.StdEncoding.DecodeString(v); err == nil && len(k) >= 32 {
				decoyKey = k
				return
			}
		}
		k := make([]byte, 32)
		if _, err := rand.Read(k); err != nil {
			// rand.Read failing is catastrophic; fall back to a fixed key so
			// the process still runs (decoys become predictable, but that is
			// strictly better than crashing the auth path).
			for i := range k {
				k[i] = byte(i)
			}
		}
		decoyKey = k
	})
	return decoyKey
}

// DecoyKDFParams returns deterministic decoy params for username, used by
// prelogin when the account does not exist or has no password enrolled.
func DecoyKDFParams(username string) KDFParams {
	mac := hmac.New(sha256.New, decoyHMACKey())
	mac.Write([]byte("chalk/decoy-salt/v1|"))
	mac.Write([]byte(strings.ToLower(strings.TrimSpace(username))))
	salt := mac.Sum(nil)[:16]
	return KDFParams{
		Alg:    1,
		MemKiB: Argon2MemFloorKiB(),
		Iters:  Argon2ItersFloor(),
		Par:    Argon2ParFloor(),
		Salt:   salt,
	}
}

// ---- small env helper -----------------------------------------------------

func envInt32(key string, def int32) int32 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 32)
	if err != nil || n <= 0 {
		return def
	}
	return int32(n)
}

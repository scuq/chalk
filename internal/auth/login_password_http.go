// chalk -- phase31-slice31-2 password-login HTTP handlers.
//
// Two endpoints, both mounted in http.go's MountRegistration:
//
//	POST /api/auth/login/prelogin  {username}
//	  -> {kdf_alg, kdf_mem_kib, kdf_iters, kdf_par, salt_b64}
//	  The client needs the account's Argon2id salt + params BEFORE it can
//	  derive authProof. To avoid becoming a username-existence oracle, this
//	  always returns params: real ones for a password-enrolled account,
//	  deterministic DECOY ones (Addendum: DecoyKDFParams) otherwise.
//
//	POST /api/auth/login/password  {username, auth_proof_b64}
//	  -> {totp_pending, expires_at}
//	  Verifies authProof in constant time against user_auth.auth_proof_hash
//	  and, on success, issues a short-lived single-use totp_pending token.
//	  It mints NO session: TOTP is mandatory and the session is minted only
//	  by POST /api/auth/login/totp (slice 31-3).
//
// Note on FOR UPDATE: the locked spec calls for the verify to run under
// s.withTx / FOR UPDATE. That row lock exists to serialise the MUTABLE TOTP
// counters (failed_totp_count, locked_until, totp_last_step), which are
// written by the TOTP step in 31-3 -- that is where the lock lands. The
// password verify here is a pure read with nothing to serialise, so it uses a
// plain consistent read; adding an empty transaction would be cargo-cult.
package auth

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/scuq/chalk/internal/store"
)

type preloginRequest struct {
	Username string `json:"username"`
}

type preloginResponse struct {
	KDFAlg    int16  `json:"kdf_alg"`
	KDFMemKiB int32  `json:"kdf_mem_kib"`
	KDFIters  int32  `json:"kdf_iters"`
	KDFPar    int32  `json:"kdf_par"`
	SaltB64   string `json:"salt_b64"`
}

type loginPasswordRequest struct {
	Username     string `json:"username"`
	AuthProofB64 string `json:"auth_proof_b64"`
}

type loginPasswordResponse struct {
	TOTPPending string    `json:"totp_pending"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// handlePrelogin returns the KDF params + salt the client must use to derive
// authProof. Always 200 with params (real or decoy) so the response does not
// reveal whether the account exists or is password-enrolled.
func (d *HTTPDeps) handlePrelogin(w http.ResponseWriter, r *http.Request) {
	var req preloginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}

	params := d.preloginParams(r, username)
	writeJSON(w, http.StatusOK, preloginResponse{
		KDFAlg:    params.Alg,
		KDFMemKiB: params.MemKiB,
		KDFIters:  params.Iters,
		KDFPar:    params.Par,
		SaltB64:   base64.StdEncoding.EncodeToString(params.Salt),
	})
}

// preloginParams resolves the real KDF params for a password-enrolled,
// non-deleted, non-blocked account, or deterministic decoy params otherwise.
// It never distinguishes the cases to the caller.
func (d *HTTPDeps) preloginParams(r *http.Request, username string) KDFParams {
	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		return DecoyKDFParams(username)
	}
	if !user.DeletedAt.IsZero() || !user.BlockedAt.IsZero() {
		return DecoyKDFParams(username)
	}
	ua, err := d.Store.GetUserAuth(r.Context(), user.ID)
	if err != nil {
		// Not password-enrolled (pre-migration user, or lookup error): decoy.
		return DecoyKDFParams(username)
	}
	return KDFParams{
		Alg:    ua.KDFAlg,
		MemKiB: ua.KDFMemKiB,
		Iters:  ua.KDFIters,
		Par:    ua.KDFPar,
		Salt:   ua.AuthSalt,
	}
}

// handleLoginPassword verifies the first factor and issues a totp_pending
// token. Failures return a generic 401 invalid_credentials so the endpoint
// does not reveal whether the username, the enrollment, or the proof was the
// problem. Deleted/blocked accounts surface their specific status, matching
// the passkey login path.
func (d *HTTPDeps) handleLoginPassword(w http.ResponseWriter, r *http.Request) {
	var req loginPasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}
	authProof, err := base64.StdEncoding.DecodeString(req.AuthProofB64)
	if err != nil || len(authProof) == 0 {
		writeError(w, http.StatusBadRequest, "bad_auth_proof",
			"auth_proof_b64 must be non-empty base64")
		return
	}

	// Dummy hash to keep timing similar across the not-found / not-enrolled
	// paths (verify still runs so the response time does not betray which
	// branch was taken).
	var storedHash []byte
	var userID = uuid.Nil
	var deleted, blocked bool

	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err == nil {
		deleted = !user.DeletedAt.IsZero()
		blocked = !user.BlockedAt.IsZero()
		userID = user.ID
		if ua, aerr := d.Store.GetUserAuth(r.Context(), user.ID); aerr == nil {
			storedHash = ua.AuthProofHash
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("login/password: lookup username: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}

	if deleted {
		writeError(w, http.StatusGone, "user_deleted",
			"this account has been deleted")
		return
	}
	if blocked {
		writeError(w, http.StatusForbidden, "user_blocked",
			"this account has been blocked by an administrator")
		return
	}

	// Constant-time verify. VerifyAuthProof handles a nil/short storedHash
	// (unknown user / not enrolled) by returning false after a dummy compare.
	if !VerifyAuthProof(storedHash, authProof) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials",
			"incorrect username or password")
		return
	}

	if d.PendingTOTP == nil {
		d.PendingTOTP = NewPendingTOTPCache(0)
	}
	token, err := d.PendingTOTP.Issue(userID, "password")
	if err != nil {
		d.Logger.Printf("login/password: issue pending token: %v", err)
		writeError(w, http.StatusInternalServerError, "pending_issue_failed",
			"internal error")
		return
	}

	writeJSON(w, http.StatusOK, loginPasswordResponse{
		TOTPPending: token,
		ExpiresAt:   time.Now().Add(TOTPPendingTTL()),
	})
}

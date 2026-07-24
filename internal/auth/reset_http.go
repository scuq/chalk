// chalk -- phase31-slice31-4 password reset HTTP handlers.
//
//	POST /api/auth/password/change  (session)
//	  {current_auth_proof_b64, auth_proof_b64, salt_b64, kdf_alg,
//	   kdf_mem_kib, kdf_iters, kdf_par, generation, wrap_suite, wrap_b64}
//	  Change password while logged in. Verifies the CURRENT authProof, then
//	  atomically installs the new proof/salt/params AND the password seed
//	  wrap the client re-sealed under the new password's KEK (the client
//	  unwrapped the entropy with the old KEK first, so E2E is preserved and
//	  the server never sees plaintext entropy).
//
//	POST /api/auth/recovery/reset-auth
//	  {username, words|phrase, auth_proof_b64, salt_b64, kdf_alg,
//	   kdf_mem_kib, kdf_iters, kdf_par, reset_totp}
//	  Forgot-password path, gated by the RECOVERY phrase (the auth-only
//	  phrase; NOT the encryption phrase, which never leaves the client).
//	  Verifies + consumes the recovery code exactly like /api/auth/recovery,
//	  installs the new password, optionally clears TOTP (lost-authenticator
//	  case: reset_totp=true forces re-enrollment via the minted session),
//	  deletes the now-stale password seed wraps, mints a session, and
//	  returns FRESH recovery words (the old code is consumed; the store
//	  contract requires immediately installing a new one). The client must
//	  afterwards re-create the password seed wrap from the ENCRYPTION
//	  phrase so new devices can unlock keys with the new password.
package auth

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/scuq/chalk/internal/store"
)

type newPasswordFields struct {
	AuthProofB64 string `json:"auth_proof_b64"`
	SaltB64      string `json:"salt_b64"`
	KDFAlg       int16  `json:"kdf_alg"`
	KDFMemKiB    int32  `json:"kdf_mem_kib"`
	KDFIters     int32  `json:"kdf_iters"`
	KDFPar       int32  `json:"kdf_par"`
}

// decodeNewPassword validates the shared new-password fields and returns the
// decoded proof hash + salt. Writes the error response itself on failure and
// returns ok=false.
func decodeNewPassword(w http.ResponseWriter, f newPasswordFields) (proofHash, salt []byte, ok bool) {
	proof, err := base64.StdEncoding.DecodeString(f.AuthProofB64)
	if err != nil || len(proof) == 0 {
		writeError(w, http.StatusBadRequest, "bad_auth_proof",
			"auth_proof_b64 must be non-empty base64")
		return nil, nil, false
	}
	s, err := base64.StdEncoding.DecodeString(f.SaltB64)
	if err != nil || len(s) < 16 {
		writeError(w, http.StatusBadRequest, "bad_salt",
			"salt_b64 must decode to at least 16 bytes")
		return nil, nil, false
	}
	if !ParamsMeetFloor(f.KDFAlg, f.KDFMemKiB, f.KDFIters, f.KDFPar) {
		writeError(w, http.StatusBadRequest, "kdf_params_too_weak",
			"argon2id parameters are below the server floor")
		return nil, nil, false
	}
	return HashAuthProof(proof), s, true
}

type changePasswordRequest struct {
	CurrentAuthProofB64 string `json:"current_auth_proof_b64"`
	newPasswordFields
	Generation int    `json:"generation"`
	WrapSuite  int16  `json:"wrap_suite"`
	WrapB64    string `json:"wrap_b64"`
}

type changePasswordResponse struct {
	Changed bool `json:"changed"`
}

func (d *HTTPDeps) handleChangePassword(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req changePasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	current, err := base64.StdEncoding.DecodeString(req.CurrentAuthProofB64)
	if err != nil || len(current) == 0 {
		writeError(w, http.StatusBadRequest, "bad_auth_proof",
			"current_auth_proof_b64 must be non-empty base64")
		return
	}
	wrap, err := base64.StdEncoding.DecodeString(req.WrapB64)
	if err != nil || len(wrap) == 0 {
		writeError(w, http.StatusBadRequest, "bad_wrap",
			"wrap_b64 must be non-empty base64 (the seed re-sealed under the new password)")
		return
	}
	if req.WrapSuite < 1 {
		writeError(w, http.StatusBadRequest, "bad_wrap", "wrap_suite must be >= 1")
		return
	}
	proofHash, salt, ok := decodeNewPassword(w, req.newPasswordFields)
	if !ok {
		return
	}

	ua, err := d.Store.GetUserAuth(r.Context(), su.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "password_required",
				"no password is set on this account")
			return
		}
		d.Logger.Printf("password/change: get user_auth: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if !VerifyAuthProof(ua.AuthProofHash, current) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials",
			"current password is incorrect")
		return
	}

	if err := d.Store.ChangePasswordAuth(r.Context(), su.UserID,
		proofHash, salt, req.KDFAlg, req.KDFMemKiB, req.KDFIters, req.KDFPar,
		req.Generation, req.WrapSuite, wrap,
	); err != nil {
		d.Logger.Printf("password/change: %v", err)
		writeError(w, http.StatusInternalServerError, "change_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, changePasswordResponse{Changed: true})
}

type resetAuthRequest struct {
	Username string   `json:"username"`
	Words    []string `json:"words"`
	Phrase   string   `json:"phrase"`
	newPasswordFields
	ResetTOTP bool `json:"reset_totp"`
}

type resetAuthResponse struct {
	UserID        string   `json:"user_id"`
	Username      string   `json:"username"`
	RecoveryWords []string `json:"recovery_words"`
	TOTPReset     bool     `json:"totp_reset"`
}

func (d *HTTPDeps) handleRecoveryResetAuth(w http.ResponseWriter, r *http.Request) {
	var req resetAuthRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.TrimSpace(strings.ToLower(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}
	var words []string
	if len(req.Words) > 0 {
		words = NormalizeRecoveryWords(strings.Join(req.Words, " "))
	} else {
		words = NormalizeRecoveryWords(req.Phrase)
	}
	if err := VerifyRecoveryWords(words); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_words", err.Error())
		return
	}
	proofHash, salt, ok := decodeNewPassword(w, req.newPasswordFields)
	if !ok {
		return
	}

	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist, or has no recovery code")
			return
		}
		d.Logger.Printf("recovery/reset-auth: GetUserByUsername: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if !user.DeletedAt.IsZero() {
		writeError(w, http.StatusGone, "user_deleted", "this account has been deleted")
		return
	}
	if !user.BlockedAt.IsZero() {
		writeError(w, http.StatusForbidden, "user_blocked",
			"this account has been blocked by an administrator")
		return
	}

	rec, err := d.Store.GetRecoveryCode(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist, or has no recovery code")
			return
		}
		d.Logger.Printf("recovery/reset-auth: GetRecoveryCode: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if rec.HasBeenUsed() {
		writeError(w, http.StatusUnauthorized, "code_used",
			"that recovery code was already used; contact the admin if locked out")
		return
	}
	if err := VerifyRecoveryCodeHash(rec.Hash, words); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_words",
			"the recovery words don't match this account")
		return
	}
	if err := d.Store.MarkRecoveryCodeUsed(r.Context(), user.ID); err != nil {
		d.Logger.Printf("recovery/reset-auth: MarkRecoveryCodeUsed: %v", err)
		writeError(w, http.StatusInternalServerError, "mark_used_failed",
			"could not mark recovery code as used")
		return
	}

	// Install the new password (+ optional TOTP clear, + stale wrap purge).
	if err := d.Store.ResetAuthViaRecovery(r.Context(), user.ID,
		proofHash, salt, req.KDFAlg, req.KDFMemKiB, req.KDFIters, req.KDFPar,
		req.ResetTOTP,
	); err != nil {
		d.Logger.Printf("recovery/reset-auth: ResetAuthViaRecovery: %v", err)
		writeError(w, http.StatusInternalServerError, "reset_failed", "internal error")
		return
	}

	// Fresh recovery words: the old code is consumed and the store contract
	// (recovery_codes.go) requires immediately installing a new one.
	newWords, err := GenerateRecoveryWords()
	if err != nil {
		d.Logger.Printf("recovery/reset-auth: GenerateRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_gen_failed",
			"password was reset but new recovery words could not be generated;"+
				" regenerate from account settings immediately")
		return
	}
	newHash, err := HashRecoveryWords(newWords)
	if err != nil {
		d.Logger.Printf("recovery/reset-auth: HashRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_hash_failed",
			"password was reset but new recovery words could not be stored;"+
				" regenerate from account settings immediately")
		return
	}
	if err := d.Store.SetRecoveryCode(r.Context(), user.ID, newHash); err != nil {
		d.Logger.Printf("recovery/reset-auth: SetRecoveryCode: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_store_failed",
			"password was reset but new recovery words could not be stored;"+
				" regenerate from account settings immediately")
		return
	}

	// Mint a session so the user can immediately re-enroll TOTP (when reset)
	// and re-create the password seed wrap from their encryption phrase.
	if _, err := MintSession(r.Context(), d.Store, w,
		user.ID, UserAgentFromRequest(r), IPFromRequest(r)); err != nil {
		d.Logger.Printf("recovery/reset-auth: MintSession: %v", err)
		// Password IS reset; the user can log in normally. Continue.
	}

	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, resetAuthResponse{
		UserID:        user.ID.String(),
		Username:      user.Username,
		RecoveryWords: newWords,
		TOTPReset:     req.ResetTOTP,
	})
}

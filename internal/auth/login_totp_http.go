// chalk -- phase31-slice31-3 TOTP HTTP handlers.
//
// Three endpoints (mounted in http.go's MountRegistration):
//
//	POST /api/auth/login/totp   {totp_pending, code}
//	  The second factor. Peeks the pending token from the password step,
//	  verifies the code (skew + replay + lockout, atomically in the store),
//	  and on success MINTS THE SESSION. This is the only login path that
//	  produces a session, which is what makes TOTP mandatory. A wrong code
//	  does NOT consume the pending token (the DB lockout bounds guessing);
//	  the token is consumed only on success.
//
//	POST /api/auth/totp/enroll  (session)  -> {provisioning_uri, secret_b32}
//	POST /api/auth/totp/confirm (session)  {code} -> {confirmed:true}
//	  Set up / reset TOTP while logged in. Enrollment requires a password to
//	  already exist (user_auth row); the secret is stored encrypted and
//	  INACTIVE until confirm succeeds.
package auth

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/scuq/chalk/internal/store"
)

type loginTOTPRequest struct {
	TOTPPending string `json:"totp_pending"`
	Code        string `json:"code"`
}

type totpEnrollResponse struct {
	ProvisioningURI string `json:"provisioning_uri"`
	SecretB32       string `json:"secret_b32"`
}

type totpConfirmRequest struct {
	Code string `json:"code"`
}

type totpConfirmResponse struct {
	Confirmed bool `json:"confirmed"`
}

// handleLoginTOTP completes login: second factor + session mint.
func (d *HTTPDeps) handleLoginTOTP(w http.ResponseWriter, r *http.Request) {
	var req loginTOTPRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	token := strings.TrimSpace(req.TOTPPending)
	code := strings.TrimSpace(req.Code)
	if token == "" || code == "" {
		writeError(w, http.StatusBadRequest, "bad_request",
			"totp_pending and code are required")
		return
	}

	if d.PendingTOTP == nil {
		d.PendingTOTP = NewPendingTOTPCache(0)
	}
	pend, err := d.PendingTOTP.Peek(token)
	if err != nil {
		// Not found or expired: the first factor must be redone.
		writeError(w, http.StatusUnauthorized, "pending_invalid",
			"login session expired; sign in again")
		return
	}

	now := time.Now()
	skew := TOTPSkew()
	verify := func(secretEnc []byte, lastStep int64) (int64, bool) {
		secret, derr := DecryptTOTPSecret(secretEnc)
		if derr != nil {
			d.Logger.Printf("login/totp: decrypt secret: %v", derr)
			return 0, false
		}
		return ValidateTOTP(secret, code, now, skew)
	}

	res, lockedUntil, err := d.Store.VerifyConsumeTOTP(
		r.Context(), pend.UserID, now, TOTPMaxFailures(), TOTPLockout(), verify)
	if err != nil {
		d.Logger.Printf("login/totp: verify/consume: %v", err)
		writeError(w, http.StatusInternalServerError, "verify_failed", "internal error")
		return
	}

	switch res {
	case store.TOTPNotEnrolled:
		writeError(w, http.StatusConflict, "totp_enrollment_required",
			"two-factor authentication is not set up for this account")
		return
	case store.TOTPLocked:
		retry := int(time.Until(lockedUntil).Seconds())
		if retry < 1 {
			retry = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		writeError(w, http.StatusTooManyRequests, "totp_locked",
			"too many incorrect codes; try again later")
		return
	case store.TOTPBadCode:
		writeError(w, http.StatusUnauthorized, "invalid_totp",
			"incorrect authentication code")
		return
	case store.TOTPSuccess:
		// consume the pending token (one-shot) now that we've succeeded
		_, _ = d.PendingTOTP.Take(token)

		sess, err := MintSession(r.Context(), d.Store, w,
			pend.UserID, UserAgentFromRequest(r), IPFromRequest(r))
		if err != nil {
			d.Logger.Printf("login/totp: mint session: %v", err)
			writeError(w, http.StatusInternalServerError, "session_mint_failed",
				"could not create session")
			return
		}
		username, displayName, role := "", "", "user"
		if user, uerr := d.Store.GetUserByID(r.Context(), pend.UserID); uerr == nil {
			username, displayName, role = user.Username, user.DisplayName, user.Role
		} else {
			d.Logger.Printf("login/totp: GetUserByID for response: %v", uerr)
		}
		writeJSON(w, http.StatusOK, authFinishResponse{
			UserID:           pend.UserID.String(),
			Username:         username,
			DisplayName:      displayName,
			Role:             role,
			SessionExpiresAt: sess.ExpiresAt,
		})
		return
	default:
		writeError(w, http.StatusInternalServerError, "verify_failed", "internal error")
		return
	}
}

// handleTOTPEnroll issues a fresh (inactive) TOTP secret for the session user.
func (d *HTTPDeps) handleTOTPEnroll(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		d.Logger.Printf("totp/enroll: generate: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_gen_failed", "internal error")
		return
	}
	enc, err := EncryptTOTPSecret(secret)
	if err != nil {
		if errors.Is(err, ErrTOTPEncKeyUnset) {
			d.Logger.Printf("totp/enroll: %v", err)
			writeError(w, http.StatusInternalServerError, "totp_enc_key_unset",
				"server is missing CHALK_TOTP_ENC_KEY; TOTP cannot be stored")
			return
		}
		d.Logger.Printf("totp/enroll: encrypt: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_enc_failed", "internal error")
		return
	}
	if err := d.Store.SetTOTPSecret(r.Context(), su.UserID, enc); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "password_required",
				"set a password before enrolling two-factor authentication")
			return
		}
		d.Logger.Printf("totp/enroll: store: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_store_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, totpEnrollResponse{
		ProvisioningURI: ProvisioningURI(su.Username, secret),
		SecretB32:       TOTPSecretBase32(secret),
	})
}

// handleTOTPConfirm activates a pending TOTP secret after the user proves they
// scanned it by supplying one valid code.
func (d *HTTPDeps) handleTOTPConfirm(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req totpConfirmRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "code is required")
		return
	}
	ua, err := d.Store.GetUserAuth(r.Context(), su.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "not_enrolled",
				"no pending two-factor secret to confirm")
			return
		}
		d.Logger.Printf("totp/confirm: get user_auth: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if len(ua.TOTPSecretEnc) == 0 {
		writeError(w, http.StatusConflict, "no_pending_totp",
			"no pending two-factor secret to confirm")
		return
	}
	secret, err := DecryptTOTPSecret(ua.TOTPSecretEnc)
	if err != nil {
		d.Logger.Printf("totp/confirm: decrypt: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_decrypt_failed", "internal error")
		return
	}
	if _, ok := ValidateTOTP(secret, code, time.Now(), TOTPSkew()); !ok {
		writeError(w, http.StatusUnauthorized, "invalid_totp", "incorrect authentication code")
		return
	}
	if err := d.Store.ConfirmTOTP(r.Context(), su.UserID); err != nil {
		d.Logger.Printf("totp/confirm: confirm: %v", err)
		writeError(w, http.StatusInternalServerError, "confirm_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, totpConfirmResponse{Confirmed: true})
}

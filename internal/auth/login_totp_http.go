// chalk -- phase31-slice31-4 TOTP HTTP handlers (staging-aware).
// (Supersedes the phase31-slice31-3 version: enrollment now STAGES the new
// secret so any ACTIVE secret keeps working until confirm promotes it.)
//
//	POST /api/auth/login/totp   {totp_pending, code}
//	  Second factor against the ACTIVE secret; mints the session on success.
//	  A wrong code does not consume the pending token (DB lockout bounds
//	  guessing); the token is consumed only on success.
//
//	POST /api/auth/totp/enroll  (session)  -> {provisioning_uri, secret_b32}
//	  Stages a fresh secret in totp_pending_secret_enc. First-time setup and
//	  reset are the same path; an existing active secret is untouched.
//
//	POST /api/auth/totp/confirm (session)  {code} -> {confirmed:true}
//	  Verifies the code against the STAGED secret and atomically promotes it
//	  to active (PromotePendingTOTP).
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

	// 85-1: the whole point of a lockout is that it happens to someone who is
	// not watching the server. Each outcome below leaves a trace.
	ip := clientIPString(r)

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
		// Throttled: every attempt during the lockout window lands here, and
		// that window is minutes long by design.
		d.secLogThrottled("totp_locked|"+pend.UserID.String(),
			"totp_locked user=%s ip=%s retry_after=%ds", pend.UserID, ip, retry)
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		writeError(w, http.StatusTooManyRequests, "totp_locked",
			"too many incorrect codes; try again later")
		return
	case store.TOTPBadCode:
		// A non-zero lockedUntil on a bad code means this attempt is the one
		// that armed the lockout. That fires once per CHALK_TOTP_MAX_FAILURES,
		// so it logs unthrottled -- it is the event an operator is looking for
		// when a user says they cannot get in.
		if !lockedUntil.IsZero() {
			d.secLog("totp_lockout_armed user=%s ip=%s until=%s",
				pend.UserID, ip, lockedUntil.UTC().Format(time.RFC3339))
		} else {
			d.secLogThrottled("totp_bad|"+pend.UserID.String(),
				"totp_failed user=%s ip=%s", pend.UserID, ip)
		}
		writeError(w, http.StatusUnauthorized, "invalid_totp",
			"incorrect authentication code")
		return
	case store.TOTPSuccess:
		_, _ = d.PendingTOTP.Take(token)
		d.secLog("login_ok user=%s ip=%s method=%s", pend.UserID, ip, pend.Method)

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

// handleTOTPEnroll stages a fresh (inactive) TOTP secret for the session user.
//
// 81-2: REPLACING a confirmed authenticator takes the current password plus a
// live code from the old one. Initial enrollment (no confirmed secret yet --
// the migration wizard, or re-enrollment after a recovery reset cleared TOTP)
// passes straight through; requireStepUp makes that distinction.
func (d *HTTPDeps) handleTOTPEnroll(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var stepUp stepUpFields
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &stepUp); err != nil {
			writeError(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
	}
	if !d.requireStepUp(w, r, "totp/enroll", su.UserID, stepUp) {
		return
	}

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
	if err := d.Store.SetPendingTOTPSecret(r.Context(), su.UserID, enc); err != nil {
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

// handleTOTPConfirm verifies a code against the STAGED secret and promotes it.
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
	enc, err := d.Store.GetPendingTOTPSecret(r.Context(), su.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "no_pending_totp",
				"no pending two-factor secret to confirm")
			return
		}
		d.Logger.Printf("totp/confirm: get pending: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	secret, err := DecryptTOTPSecret(enc)
	if err != nil {
		d.Logger.Printf("totp/confirm: decrypt: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_decrypt_failed", "internal error")
		return
	}
	if _, ok := ValidateTOTP(secret, code, time.Now(), TOTPSkew()); !ok {
		writeError(w, http.StatusUnauthorized, "invalid_totp", "incorrect authentication code")
		return
	}
	if err := d.Store.PromotePendingTOTP(r.Context(), su.UserID); err != nil {
		d.Logger.Printf("totp/confirm: promote: %v", err)
		writeError(w, http.StatusInternalServerError, "confirm_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, totpConfirmResponse{Confirmed: true})
}

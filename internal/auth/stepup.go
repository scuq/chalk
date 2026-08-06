// chalk -- 81-2 step-up authentication for factor rotation.
//
// A session cookie proves "someone was signed in on this device once." That
// is a weak enough claim that it must not, by itself, let the holder replace
// the factors that define who owns the account: the recovery phrase, the
// TOTP secret, or the set of passkeys. Otherwise a stolen session converts
// into permanent account takeover -- mint a fresh phrase, stage a new
// authenticator, and the real owner is locked out of their own account.
//
// So the sensitive rotations re-ask for what the session cannot supply: the
// current password (as the same authProof the login path derives) plus a
// live TOTP code. No server-side grant is minted -- the proof travels with
// the request that uses it, exactly as /password/change has always done.
//
// Deliberate carve-out: an account with no confirmed TOTP secret is NOT
// asked for a code. That is initial enrollment (the migration wizard, or
// re-enrollment after a recovery reset cleared TOTP) -- there is no second
// factor yet to prove, and demanding one would be a lockout.

package auth

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// stepUpFields are embedded in the request body of every step-up-gated
// endpoint. Both are omitted by callers acting on an account that has
// neither a password nor a confirmed TOTP secret.
type stepUpFields struct {
	AuthProofB64 string `json:"auth_proof_b64"`
	TOTPCode     string `json:"totp_code"`
}

// requireStepUp verifies the current password and (when enrolled) a live TOTP
// code before a factor-rotating operation. Writes the error response itself
// and returns false when the caller has not proven enough.
//
// Accounts with no user_auth row pass through: they predate auth v2 and have
// no password to prove. The recovery path is where such an account regains
// control, and it has its own phrase gate.
func (d *HTTPDeps) requireStepUp(
	w http.ResponseWriter,
	r *http.Request,
	logPrefix string,
	userID uuid.UUID,
	f stepUpFields,
) bool {
	ua, err := d.Store.GetUserAuth(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		return true
	}
	if err != nil {
		d.Logger.Printf("%s: GetUserAuth: %v", logPrefix, err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return false
	}

	proof, derr := base64.StdEncoding.DecodeString(f.AuthProofB64)
	if derr != nil || len(proof) == 0 {
		writeError(w, http.StatusUnauthorized, "invalid_credentials",
			"confirm your password to make this change")
		return false
	}
	if !VerifyAuthProof(ua.AuthProofHash, proof) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials",
			"that password is incorrect")
		return false
	}

	if !ua.TOTPConfirmed() {
		return true // initial enrollment: nothing to prove yet
	}
	return d.verifyLiveTOTP(w, r, logPrefix, userID, strings.TrimSpace(f.TOTPCode))
}

// revokeOtherSessions signs every other device out after a factor changed,
// and drops the matching live WS connections.
//
// 81-8 applies this uniformly to all four step-up-gated rotations rather than
// picking between them. 81-1 already did it for password change and recovery
// reset; leaving the others alone meant a user who replaced their
// authenticator because they suspected a thief left the thief signed in. Every
// caller here is gated on the current password plus a live code, so "a factor
// changed, so other devices sign in again" is a rule a user can predict --
// which is worth more than saving one phone re-login after adding a passkey.
//
// Best-effort by design: the rotation itself has already been committed, and
// failing the request afterwards would tell the user their change did not land
// when it did. Logged instead.
func (d *HTTPDeps) revokeOtherSessions(
	r *http.Request,
	logPrefix string,
	userID uuid.UUID,
	reason string,
) {
	keepToken, err := SessionTokenFromRequest(r)
	if err != nil {
		keepToken = nil // revoke everything rather than skip the revocation
	}
	if _, err := d.Store.DeleteSessionsForUserExcept(r.Context(), userID, keepToken); err != nil {
		d.Logger.Printf("%s: revoke other sessions: %v", logPrefix, err)
		return
	}
	// The hub tracks connections per user, so this also drops the caller's own
	// socket; the SPA reconnects against its still-valid session.
	if d.Kicker != nil {
		d.Kicker.CloseConnsForUser(userID.String(), errors.New(reason))
	}
	d.secLog("factor_changed_sessions_revoked user=%s change=%s ip=%s",
		userID, reason, clientIPString(r))
}

// verifyLiveTOTP checks one live second-factor code, consuming it against the
// replay/lockout counters. Accounts without a confirmed secret pass through.
// Writes the error response itself and returns false on failure.
//
// Shared by the recovery reset (which calls it with an empty code to produce
// the "enter a code, or choose to reset two-factor" prompt) and by
// requireStepUp above.
func (d *HTTPDeps) verifyLiveTOTP(
	w http.ResponseWriter,
	r *http.Request,
	logPrefix string,
	userID uuid.UUID,
	code string,
) bool {
	if code == "" {
		ua, err := d.Store.GetUserAuth(r.Context(), userID)
		if errors.Is(err, store.ErrNotFound) {
			return true // pre-migration account: no second factor to prove
		}
		if err != nil {
			d.Logger.Printf("%s: GetUserAuth: %v", logPrefix, err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return false
		}
		if ua.TOTPConfirmed() {
			writeError(w, http.StatusUnauthorized, "totp_required",
				"enter a code from your authenticator app")
			return false
		}
		return true
	}

	now := time.Now()
	skew := TOTPSkew()
	res, lockedUntil, err := d.Store.VerifyConsumeTOTP(r.Context(), userID, now,
		TOTPMaxFailures(), TOTPLockout(),
		func(secretEnc []byte, lastStep int64) (int64, bool) {
			secret, derr := DecryptTOTPSecret(secretEnc)
			if derr != nil {
				d.Logger.Printf("%s: decrypt totp secret: %v", logPrefix, derr)
				return 0, false
			}
			return ValidateTOTP(secret, code, now, skew)
		})
	if err != nil {
		d.Logger.Printf("%s: VerifyConsumeTOTP: %v", logPrefix, err)
		writeError(w, http.StatusInternalServerError, "verify_failed", "internal error")
		return false
	}
	switch res {
	case store.TOTPNotEnrolled, store.TOTPSuccess:
		return true
	case store.TOTPLocked:
		retry := int(time.Until(lockedUntil).Seconds())
		if retry < 1 {
			retry = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		writeError(w, http.StatusTooManyRequests, "totp_locked",
			"too many incorrect codes; try again later")
		return false
	default:
		writeError(w, http.StatusUnauthorized, "invalid_totp",
			"incorrect authentication code")
		return false
	}
}

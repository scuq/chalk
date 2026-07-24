// chalk -- phase31-slice31-9 auth-v2 cutover: migration endpoints + gate.
//
// The hard-cutover machinery (Addendum C). When CHALK_AUTH_V2_REQUIRED is on
// (the default), a session belonging to a user who has NOT enrolled in
// auth v2 (password + confirmed TOTP) is rejected with 409
// auth_v2_enrollment_required on every session-gated endpoint EXCEPT the
// small allowlist needed to complete enrollment. The client sees the 409 (or
// the auth_v2_enrolled=false field on /api/auth/me) and routes the user into
// the migration wizard.
//
//	POST /api/auth/migration/password  (session; only while un-enrolled)
//	  {auth_proof_b64, salt_b64, kdf_alg, kdf_mem_kib, kdf_iters, kdf_par}
//	  Installs the password half (UpsertPasswordAuth). Refused once enrolled
//	  -- enrolled accounts change passwords via /password/change, which
//	  demands the current password.
//
//	POST /api/auth/migration/complete  (session)
//	  Verifies password + confirmed TOTP are both present, then flips
//	  auth_v2_enrolled=true. Idempotent.
//
// Existing v2 signups never touch any of this (enrolled=true from birth).
package auth

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/scuq/chalk/internal/store"
)

// AuthV2Required reports whether the hard cutover is active. Defaults to ON;
// set CHALK_AUTH_V2_REQUIRED=0 to run the transition period with mixed auth.
func AuthV2Required() bool {
	v := strings.TrimSpace(os.Getenv("CHALK_AUTH_V2_REQUIRED"))
	switch strings.ToLower(v) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

// enrollmentExemptPaths are the session-gated endpoints an un-enrolled user
// may still reach: everything needed to finish enrollment, plus logout/me so
// the SPA can orient itself, plus the seed-wrap endpoints so the migration
// wizard's optional phrase re-link works in the same sitting.
var enrollmentExemptPaths = map[string]bool{
	"/api/auth/me":                 true,
	"/api/auth/logout":             true,
	"/api/auth/totp/enroll":        true,
	"/api/auth/totp/confirm":       true,
	"/api/auth/migration/password": true,
	"/api/auth/migration/complete": true,
	"/api/auth/seed-wrap":          true,
	"/api/auth/seed-wraps":         true,
}

// enrollmentExempt reports whether the request path may bypass the gate.
func enrollmentExempt(path string) bool {
	return enrollmentExemptPaths[path]
}

type migrationPasswordRequest struct {
	newPasswordFields
}

func (d *HTTPDeps) handleMigrationPassword(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req migrationPasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	proofHash, salt, ok := decodeNewPassword(w, req.newPasswordFields)
	if !ok {
		return
	}
	ua, err := d.Store.GetUserAuth(r.Context(), su.UserID)
	if err == nil && ua.AuthV2Enrolled {
		writeError(w, http.StatusConflict, "already_enrolled",
			"this account already uses password auth; change it in your profile")
		return
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("migration/password: GetUserAuth: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if err := d.Store.UpsertPasswordAuth(r.Context(), su.UserID,
		proofHash, salt, req.KDFAlg, req.KDFMemKiB, req.KDFIters, req.KDFPar,
	); err != nil {
		d.Logger.Printf("migration/password: UpsertPasswordAuth: %v", err)
		writeError(w, http.StatusInternalServerError, "persist_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"stored": true})
}

func (d *HTTPDeps) handleMigrationComplete(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	ua, err := d.Store.GetUserAuth(r.Context(), su.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "password_required",
				"set a password before completing enrollment")
			return
		}
		d.Logger.Printf("migration/complete: GetUserAuth: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if len(ua.AuthProofHash) == 0 {
		writeError(w, http.StatusConflict, "password_required",
			"set a password before completing enrollment")
		return
	}
	if !ua.TOTPConfirmed() {
		writeError(w, http.StatusConflict, "totp_required",
			"set up and confirm two-factor authentication before completing enrollment")
		return
	}
	if !ua.AuthV2Enrolled {
		if err := d.Store.SetAuthV2Enrolled(r.Context(), su.UserID, true); err != nil {
			d.Logger.Printf("migration/complete: SetAuthV2Enrolled: %v", err)
			writeError(w, http.StatusInternalServerError, "persist_failed", "internal error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"enrolled": true})
}

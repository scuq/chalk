// chalk -- phase31-slice31-11 admin bootstrap token.
//
// Between `chalkctl init` and the operator's first signup, the reserved
// admin username was claimable by ANY visitor: the reserved-list exemption
// keyed on the username alone. This closes that window. Claiming the admin
// username now additionally requires the one-shot bootstrap token:
//
//	CHALK_ADMIN_BOOTSTRAP_TOKEN   set by chalkctl init; printed as
//	                              https://<domain>/?admin_token=<token>
//
// Fail closed: env unset => the admin username cannot be claimed at all.
// Naturally one-shot: once the admin account exists, the username-taken
// check rejects every further attempt, token or not -- so the URL is dead
// the moment enrollment (password+TOTP, or a passkey added later) is done.
package auth

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
)

// adminBootstrapOK reports whether the provided token authorizes claiming
// the admin username. Constant-time compare; empty env or empty provided
// token always fails.
func adminBootstrapOK(provided string) bool {
	want := strings.TrimSpace(os.Getenv("CHALK_ADMIN_BOOTSTRAP_TOKEN"))
	provided = strings.TrimSpace(provided)
	if want == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(provided)) == 1
}

// isAdminClaim reports whether this (already normalized) username plus
// token is the operator claiming the admin account. Both halves must
// hold: the name has to be the configured CHALK_ADMIN_USERNAME and the
// token has to match. A deployment with no admin username configured
// has no claimable account.
func (d *HTTPDeps) isAdminClaim(username, token string) bool {
	admin := strings.ToLower(strings.TrimSpace(d.AdminUsername))
	if admin == "" || username != admin {
		return false
	}
	return adminBootstrapOK(token)
}

// ---- claim probe ---------------------------------------------------------

type adminClaimProbeRequest struct {
	AdminToken string `json:"admin_token"`
}

type adminClaimProbeResponse struct {
	Claimable bool   `json:"claimable"`
	Username  string `json:"username,omitempty"`
}

// handleAdminClaimProbe answers "does this enrollment URL still do
// anything, and for which username?" so the SPA can open the signup
// wizard prefilled instead of dropping the operator on a login form with
// no explanation.
//
// It deliberately reveals nothing without a valid token: a bad token
// gets {claimable:false} with no username, the same answer a spent token
// gets. The response is never cached — unlike /api/auth/config, whose
// max-age would leak one visitor's answer to the next.
//
// Claimable means the token matches AND the account has not been taken
// yet. "Not taken" is the absence of an admin row entirely (nothing
// seeded) or a seeded row with no credentials on it.
func (d *HTTPDeps) handleAdminClaimProbe(w http.ResponseWriter, r *http.Request) {
	var req adminClaimProbeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store, private")

	username := strings.ToLower(strings.TrimSpace(d.AdminUsername))
	if username == "" || !adminBootstrapOK(req.AdminToken) {
		writeJSON(w, http.StatusOK, adminClaimProbeResponse{Claimable: false})
		return
	}

	if _, err := d.Store.GetUnclaimedAdmin(r.Context()); err != nil {
		// No unclaimed admin row. That is either "already claimed" or
		// "never seeded"; the latter is still claimable, since the
		// signup path creates the admin outright in that case.
		if _, adminErr := d.Store.GetAdminUser(r.Context()); adminErr == nil {
			writeJSON(w, http.StatusOK, adminClaimProbeResponse{Claimable: false})
			return
		}
	}

	writeJSON(w, http.StatusOK, adminClaimProbeResponse{
		Claimable: true,
		Username:  username,
	})
}

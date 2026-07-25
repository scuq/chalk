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

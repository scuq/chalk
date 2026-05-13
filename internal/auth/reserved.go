// Package auth is chalk's authentication layer. It wraps go-webauthn for
// passkey ceremonies, handles session minting, recovery-code generation
// and verification, and the admin-bootstrap flow.
//
// Phase 09b sub-step 2 ships the skeleton: types, interfaces, and the
// service constructor. HTTP routing arrives in sub-step 3 (registration)
// and 4 (authentication). The dev-login bypass is wired up in
// sub-step 5 when ws.go drops ensureDeviceForTesting.
package auth

import (
	"regexp"
	"strings"
)

// usernameRe matches the username shape constraint enforced by migration
// 0011 (users_username_shape CHECK). The regex is duplicated here so
// the application can reject invalid inputs with a friendly error
// before going to the database, but the database is the source of
// truth.
//
// ^[a-z0-9_]{3,32}$ -- strict ASCII lowercase letters, digits, and
// underscore; 3 to 32 characters inclusive. No hyphens, no Unicode,
// no leading/trailing whitespace.
var usernameRe = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// reservedUsernames lists usernames that the application refuses to
// allocate to ordinary users. The admin's chosen username (from the
// CHALK_ADMIN_USERNAME env var) is allowed even if it matches one of
// these -- the env-set admin name is the only legitimate use.
//
// This list is conservative on purpose. Adding entries is cheap;
// removing entries after a user has claimed one is not.
//
// Source: the chalk plan, DECISION 8 ("reserved usernames").
var reservedUsernames = map[string]struct{}{
	"admin":         {},
	"administrator": {},
	"root":          {},
	"system":        {},
	"chalk":         {},
	"chalkd":        {},
	"support":       {},
	"help":          {},
	"moderator":     {},
	"mod":           {},
	"official":      {},
	"noreply":       {},
	"postmaster":    {},
}

// IsValidUsername reports whether s satisfies the chalk username shape
// constraint. It does NOT check the reserved-username list or
// existing-user collisions; those are layered on top by the auth
// service.
func IsValidUsername(s string) bool {
	return usernameRe.MatchString(s)
}

// IsReservedUsername reports whether s is on the reserved list. The
// check is case-insensitive even though the shape requires lowercase,
// because the input may not have been shape-checked yet.
func IsReservedUsername(s string) bool {
	_, ok := reservedUsernames[strings.ToLower(s)]
	return ok
}

// ReservedUsernames returns a sorted snapshot of the reserved-username
// set. Intended for diagnostic output and tests; the application
// itself uses IsReservedUsername.
func ReservedUsernames() []string {
	out := make([]string, 0, len(reservedUsernames))
	for u := range reservedUsernames {
		out = append(out, u)
	}
	// Stable order across calls for predictability in tests/UI.
	sortStrings(out)
	return out
}

// sortStrings is a tiny insertion sort to avoid pulling in "sort"
// just for this. The list is 13 entries.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		j := i
		for j > 0 && s[j-1] > s[j] {
			s[j-1], s[j] = s[j], s[j-1]
			j--
		}
	}
}

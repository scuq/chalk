package auth

import (
	"os"
	"strings"
)

// IsDevMode reports whether the dev login bypass is enabled. It reads
// the CHALK_DEV environment variable; any of "1", "true", "yes",
// "on" (case-insensitive) enables it. Anything else is dev-off.
//
// Sub-step 5 will wire this into the HTTP layer: a /api/dev/login
// endpoint that mints a session for a named fixture user without a
// passkey ceremony, AND a 404 response from that endpoint when
// IsDevMode() returns false. Sub-step 2 ships only the predicate so
// other components (e.g. the SPA's "Log in as alice/bob/carol"
// quick-login buttons) can branch on it once we expose it via the
// welcome frame.
//
// The plan also describes a //go:build dev tag for compile-time
// elimination. We deliberately do NOT add that yet: the runtime
// check is simpler to test, and the cost of the unused endpoint
// existing in a production binary (when CHALK_DEV is unset) is one
// extra route registration that returns 404. We can add the build
// tag later if the security review insists on belt-and-suspenders.
func IsDevMode() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("CHALK_DEV")))
	switch v {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// DevModeBanner returns a single-line stderr-friendly banner that
// chalkd prints at startup when IsDevMode() is true. The text is
// stable so log scrapers can match it.
func DevModeBanner() string {
	return "CHALK DEV MODE ENABLED: /api/dev/login is exposed and accepts fixture-user logins without authentication"
}

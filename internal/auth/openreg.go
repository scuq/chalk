package auth

import (
	"os"
	"strings"
)

// IsOpenRegistration reports whether chalkd is running in open-
// registration mode. When true, POST /api/auth/register/begin
// accepts requests without an invite token, and any caller can
// claim any (non-reserved, non-taken) username.
//
// Default is OFF. The intended use is initial bootstrap of a self-
// hosted instance (admin creates their own account before invites
// exist) and development. Production deploys should leave it off
// after the admin has registered; once invites land in 09c, the
// invite path is the only way in.
//
// Read from CHALK_OPEN_REGISTRATION (any truthy variant: 1, true,
// yes, on; case-insensitive). The cmd/chalkd entry point also
// exposes a --open-registration flag via the config package; the
// flag wins over the env var per chalk's standard precedence.
//
// This predicate is the runtime check the HTTP handler consults at
// request time. The config field is the boot-time-known value;
// IsOpenRegistration() reads the env directly so tests can use
// t.Setenv without rebuilding a Config. In production the two
// agree by construction (chalkd sets the env from its own flag
// resolution).
func IsOpenRegistration() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("CHALK_OPEN_REGISTRATION")))
	switch v {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

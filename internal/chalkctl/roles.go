package chalkctl

import (
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
)

// 80-1: database roles. chalkd's day-to-day pool connects as chalk_app, a
// non-superuser member of the owner role (membership confers ownership for
// migrations and partition DDL, but SUPERUSER is an attribute and does not
// inherit). Guest connections use chalk_guest, which has no membership and is
// fenced by the FORCE RLS policies of migration 0050.
//
// Roles live in the cluster, outside the database, so a dump/restore does not
// carry them: init, update and restore all run ensureDBRoles, which is
// idempotent (create if absent, always re-assert LOGIN + password).

// rolesSQL returns the idempotent role-bootstrap script. Passwords are
// embedded as quoted literals; pgQuoteLiteral guards against quote characters
// even though genSecret only emits URL-safe base64.
func rolesSQL(appPassword, guestPassword string) string {
	return fmt.Sprintf(`DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chalk_app') THEN
    CREATE ROLE chalk_app;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chalk_guest') THEN
    CREATE ROLE chalk_guest;
  END IF;
END $$;
ALTER ROLE chalk_app LOGIN PASSWORD %s;
ALTER ROLE chalk_guest LOGIN PASSWORD %s;
GRANT chalk TO chalk_app;
`, pgQuoteLiteral(appPassword), pgQuoteLiteral(guestPassword))
}

// pgQuoteLiteral single-quotes s for embedding in SQL, doubling any embedded
// quotes.
func pgQuoteLiteral(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// ensureDBRoles creates/refreshes chalk_app and chalk_guest inside the running
// Postgres container. The owner role (chalk) authenticates over the
// container-local socket (trust), the same way backup and restore already do.
func ensureDBRoles(p *Podman, appPassword, guestPassword string) error {
	if err := waitForPostgres(p, 30*time.Second); err != nil {
		return err
	}
	sql := rolesSQL(appPassword, guestPassword)
	args := append([]string{"psql", "-U", "chalk", "-d", "chalk"}, "-q", "-v", "ON_ERROR_STOP=1")
	if err := p.ExecIn(strings.NewReader(sql), pgContainer, args...); err != nil {
		return fmt.Errorf("create db roles: %w", err)
	}
	return nil
}

// rewriteDBURLUser swaps the userinfo of a postgres URL, preserving host,
// database and options — so an upgrade repoints an existing (possibly
// customized) CHALK_DB_URL at chalk_app without touching anything else.
func rewriteDBURLUser(dbURL, user, password string) (string, error) {
	u, err := url.Parse(dbURL)
	if err != nil {
		return "", fmt.Errorf("parse CHALK_DB_URL: %w", err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("CHALK_DB_URL %q has no host", dbURL)
	}
	u.User = url.UserPassword(user, password)
	return u.String(), nil
}

// ensureDBRolesEnv is the upgrade path shared by update and restore: make sure
// the env file carries the role passwords + both URLs (generating and
// appending them on first contact, preserving them afterwards), then assert
// the roles in the running Postgres. Returns the two passwords.
func ensureDBRolesEnv(envPath string, p *Podman, out io.Writer) (appPw, guestPw string, err error) {
	existing, err := readEnvSecrets(envPath)
	if err != nil {
		return "", "", fmt.Errorf("read %s: %w", envPath, err)
	}
	appPw = existing["CHALK_PG_APP_PASSWORD"]
	guestPw = existing["CHALK_PG_GUEST_PASSWORD"]

	if appPw == "" || guestPw == "" {
		if appPw == "" {
			if appPw, err = genSecret(24); err != nil {
				return "", "", err
			}
		}
		if guestPw == "" {
			if guestPw, err = genSecret(24); err != nil {
				return "", "", err
			}
		}
		if _, err := setEnvValue(envPath, "CHALK_PG_APP_PASSWORD", appPw); err != nil {
			return "", "", err
		}
		if _, err := setEnvValue(envPath, "CHALK_PG_GUEST_PASSWORD", guestPw); err != nil {
			return "", "", err
		}
		// Repoint the app URL at chalk_app, preserving host/db/options of
		// whatever the deployment currently uses.
		oldURL := existing["CHALK_DB_URL"]
		if oldURL == "" {
			return "", "", fmt.Errorf("no CHALK_DB_URL in %s to derive the chalk_app URL from", envPath)
		}
		newURL, err := rewriteDBURLUser(oldURL, "chalk_app", appPw)
		if err != nil {
			return "", "", err
		}
		if _, err := setEnvValue(envPath, "CHALK_DB_URL", newURL); err != nil {
			return "", "", err
		}
		guestURL, err := rewriteDBURLUser(oldURL, "chalk_guest", guestPw)
		if err != nil {
			return "", "", err
		}
		if _, err := setEnvValue(envPath, "CHALK_DB_URL_GUEST", guestURL); err != nil {
			return "", "", err
		}
		fmt.Fprintf(out, "  backfilled chalk_app/chalk_guest DB roles into %s (phase 80)\n", envPath)
	}

	if err := ensureDBRoles(p, appPw, guestPw); err != nil {
		return "", "", err
	}
	return appPw, guestPw, nil
}

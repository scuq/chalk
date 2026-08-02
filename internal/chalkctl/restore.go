package chalkctl

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

// 72-3: `chalkctl restore` -- load a backup into a freshly initialized host.
//
// The intended sequence for moving a deployment is: `chalkctl backup` on the
// old host, a normal `chalkctl init` on the new one (so Caddy issues real
// certificates and the stack is proven healthy before any data is at stake),
// then this. Restore therefore REQUIRES an initialized host and never touches
// the units, the Caddyfile or the image pin.
//
// It replaces exactly two things: the contents of the database, and the one
// env value that the database cannot be read without.

// carriedEnvKeys are the values restore copies out of the archived env file
// into the live one, overwriting what init generated.
//
// Only CHALK_TOTP_ENC_KEY qualifies, and it does so absolutely: every TOTP
// secret in the dump is AES-GCM ciphertext under the OLD host's key, so
// keeping the new host's freshly generated one would lock every account out at
// the second factor with no way back.
//
// Everything else is deliberately left as init generated it:
//   - CHALK_PG_PASSWORD / POSTGRES_PASSWORD / CHALK_DB_URL belong to the new
//     host's Postgres, which was initialized with them;
//   - CHALK_TURN_SECRET is only ever shared between this host's coturn and
//     chalkd, both rendered from this file;
//   - CHALK_RP_ID / CHALK_RP_ORIGINS must match the domain actually being
//     served, not the one the backup came from;
//   - CHALK_ADMIN_* only seed a first-boot row that the restore replaces.
var carriedEnvKeys = []string{"CHALK_TOTP_ENC_KEY"}

// RestoreWipeSQL is prepended to the dump so the load starts from a clean
// schema. Dropping it beats relying on a dump's own DROP statements: if this
// host's chalkd has already applied migrations the backup predates, only a
// clean slate leaves schema_migrations agreeing with the schema it describes.
// chalkd applies anything newer forward on its next start.
const RestoreWipeSQL = "DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n"

// PSQLLoadArgs make the load all-or-nothing: one transaction, aborting on the
// first error, so a failed restore leaves the database exactly as it was.
var PSQLLoadArgs = []string{"-q", "-v", "ON_ERROR_STOP=1", "--single-transaction"}

// RestoreOptions configures a restore.
type RestoreOptions struct {
	Cfg        Config
	Path       string // archive to load
	Password   string
	Podman     *Podman
	StatePath  string
	EnvPath    string
	ConfigPath string
	Out        io.Writer

	// Confirm gates the destructive load. nil -> the interactive
	// type-the-domain prompt; a func returning true for --yes.
	Confirm func(prompt string) bool
	// SkipHealth skips the post-restore health poll.
	SkipHealth    bool
	HealthURL     string
	HealthTimeout time.Duration
}

func (o *RestoreOptions) defaults() {
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	if o.StatePath == "" {
		o.StatePath = DefaultStatePath
	}
	if o.EnvPath == "" {
		o.EnvPath = DefaultEnvPath
	}
	if o.ConfigPath == "" {
		o.ConfigPath = DefaultConfigPath
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Confirm == nil {
		o.Confirm = promptConfirm
	}
	if o.HealthURL == "" && o.Cfg.Domain != "" {
		o.HealthURL = "https://" + o.Cfg.Domain + "/healthz"
	}
	if o.HealthTimeout == 0 {
		o.HealthTimeout = 60 * time.Second
	}
}

func (o *RestoreOptions) logf(format string, a ...any) {
	fmt.Fprintf(o.Out, "  "+format+"\n", a...)
}

// Restore loads an archive into the current deployment, replacing its
// database. The archive is read in a single streaming pass -- the manifest
// arrives first, so the operator sees what they are about to load (and is
// asked to confirm it) before the dump is touched.
func Restore(o RestoreOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	if o.Password == "" {
		return fmt.Errorf("no backup password (use --password-file, $%s, or answer the prompt)", BackupPasswordEnv)
	}
	if _, ok, err := LoadState(o.StatePath); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("not initialized (%s missing) -- run `chalkctl init` on this host first, then restore", o.StatePath)
	}

	f, err := os.Open(o.Path)
	if err != nil {
		return err
	}
	defer f.Close()

	fmt.Fprintf(o.Out, "chalkctl restore: %s -> %s\n", o.Path, o.Cfg.Domain)
	o.logf("decrypting (Argon2id + AES-256-GCM)...")
	sealed, err := newOpenReader(bufio.NewReader(f), o.Password)
	if err != nil {
		return err
	}
	tr := tar.NewReader(sealed)

	mfData, err := nextMember(tr, manifestName)
	if err != nil {
		return err
	}
	var mf Manifest
	if err := json.Unmarshal(mfData, &mf); err != nil {
		return fmt.Errorf("parse %s: %w", manifestName, err)
	}
	if mf.Format > ManifestFormat {
		return fmt.Errorf("archive is format v%d, this chalkctl understands v%d -- use a newer chalkctl", mf.Format, ManifestFormat)
	}
	o.describe(mf)

	if !o.Confirm(fmt.Sprintf(
		"\nThis REPLACES the entire database of this deployment with the archive.\nType the domain (%s) to confirm: ",
		o.Cfg.Domain)) {
		return fmt.Errorf("aborted: restore not confirmed")
	}

	envData, err := nextMember(tr, envName)
	if err != nil {
		return err
	}
	// chalkctl.conf is optional (an archive from a host that had none), so
	// walk to the dump rather than assuming a fixed member count.
	hdr, err := tr.Next()
	if err != nil {
		return fmt.Errorf("archive is missing %s: %w", dumpName, err)
	}
	var confData []byte
	if hdr.Name == confName {
		if confData, err = io.ReadAll(tr); err != nil {
			return err
		}
		if hdr, err = tr.Next(); err != nil {
			return fmt.Errorf("archive is missing %s: %w", dumpName, err)
		}
	}
	if hdr.Name != dumpName {
		return fmt.Errorf("archive member %q where %s was expected", hdr.Name, dumpName)
	}

	// chalkd must be down before the schema goes: it holds a pool of
	// connections and would write into a half-loaded database. Caddy stays up
	// so ACME and the certificate it just earned are untouched.
	o.logf("stopping chalkd...")
	if _, err := Systemctl("stop", "chalkd.service"); err != nil {
		return fmt.Errorf("stop chalkd: %w", err)
	}
	if _, err := Systemctl("start", "chalk-postgres.service"); err != nil {
		return fmt.Errorf("start chalk-postgres: %w", err)
	}
	// systemd calls the unit started once the container is up, which is before
	// Postgres accepts connections. Wait for the server itself, or the load
	// fails on a race that a second attempt would have won.
	if err := o.waitForPostgres(30 * time.Second); err != nil {
		_, _ = Systemctl("start", "chalkd.service")
		return err
	}

	if err := o.loadDump(tr); err != nil {
		// Leave the operator with a running app rather than a stopped one;
		// the load ran in one transaction, so the database is as it was.
		_, _ = Systemctl("start", "chalkd.service")
		return err
	}

	if err := carryEnv(o.EnvPath, envData, o.logf); err != nil {
		return err
	}

	o.logf("starting chalkd...")
	if _, err := Systemctl("start", "chalkd.service"); err != nil {
		return fmt.Errorf("start chalkd (check `journalctl -u chalkd`): %w", err)
	}
	if !o.SkipHealth {
		o.logf("waiting for health at %s (up to %s)...", o.HealthURL, o.HealthTimeout)
		if err := pollHealth(o.HealthURL, o.HealthTimeout); err != nil {
			return fmt.Errorf("restored, but the health check failed: %w (check `journalctl -u chalkd`)", err)
		}
		o.logf("healthy.")
	}

	fmt.Fprintf(o.Out, "\nrestore complete. https://%s is serving the restored data.\n", o.Cfg.Domain)
	o.reportConfigDrift(confData)
	if !strings.EqualFold(mf.Domain, o.Cfg.Domain) {
		fmt.Fprintf(o.Out, "\nreminder: the domain changed, so existing passkeys will not work here.\n")
		fmt.Fprintf(o.Out, "          everyone signs in with password + TOTP and can enrol a new passkey.\n")
	}
	return nil
}

func (o *RestoreOptions) describe(mf Manifest) {
	fmt.Fprintf(o.Out, "\narchive contents:\n")
	fmt.Fprintf(o.Out, "  taken     %s\n", mf.CreatedAt.Local().Format("2006-01-02 15:04:05 MST"))
	fmt.Fprintf(o.Out, "  domain    %s\n", mf.Domain)
	fmt.Fprintf(o.Out, "  chalk     %s\n", mf.ChalkVersion)
	fmt.Fprintf(o.Out, "  postgres  %s\n", mf.PostgresTag)
	fmt.Fprintf(o.Out, "  admin     %s\n", mf.AdminUsername)

	if !strings.EqualFold(mf.Domain, o.Cfg.Domain) {
		fmt.Fprintf(o.Out, "\nWARNING: this host serves %s, the backup came from %s.\n", o.Cfg.Domain, mf.Domain)
		fmt.Fprintf(o.Out, "         passkeys are bound to the domain and will stop working; password + TOTP\n")
		fmt.Fprintf(o.Out, "         still work, and a new passkey can be enrolled from the profile panel.\n")
	}
	if mf.PostgresTag != "" && mf.PostgresTag != o.Cfg.PostgresTag {
		fmt.Fprintf(o.Out, "\nWARNING: backup is from Postgres %s, this host runs %s.\n", mf.PostgresTag, o.Cfg.PostgresTag)
		fmt.Fprintf(o.Out, "         a dump loads forward across majors, but not backward.\n")
	}
	if mf.AdminUsername != "" && !strings.EqualFold(mf.AdminUsername, o.Cfg.AdminUsername) {
		fmt.Fprintf(o.Out, "\nnote: this host was initialized with admin %q; the restore brings back %q.\n",
			o.Cfg.AdminUsername, mf.AdminUsername)
	}
}

func (o *RestoreOptions) waitForPostgres(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		if last = o.Podman.ExecIn(strings.NewReader(""), pgContainer,
			"pg_isready", "-U", "chalk", "-d", "chalk"); last == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("postgres did not become ready within %s: %w", timeout, last)
}

// loadDump streams the dump member through psql, with RestoreWipeSQL
// prepended to the same stream so the wipe and the load share one transaction.
func (o *RestoreOptions) loadDump(tr *tar.Reader) error {
	gz, err := gzip.NewReader(tr)
	if err != nil {
		return fmt.Errorf("read %s: %w", dumpName, err)
	}
	defer gz.Close()

	o.logf("loading database (dropping the current schema, then the dump)...")
	args := append([]string{"psql", "-U", "chalk", "-d", "chalk"}, PSQLLoadArgs...)
	if err := o.Podman.ExecIn(
		io.MultiReader(strings.NewReader(RestoreWipeSQL), gz), pgContainer, args...); err != nil {
		return fmt.Errorf("load dump: %w (the database was NOT modified)", err)
	}
	o.logf("database loaded.")
	return nil
}

// carryEnv writes the carriedEnvKeys values from the archived env file into
// the live one.
func carryEnv(envPath string, archived []byte, logf func(string, ...any)) error {
	old := parseEnvBytes(archived)
	for _, key := range carriedEnvKeys {
		val, ok := old[key]
		if !ok || val == "" {
			logf("WARNING: the archive has no %s; TOTP secrets in the restored database cannot be decrypted", key)
			continue
		}
		changed, err := setEnvValue(envPath, key, val)
		if err != nil {
			return fmt.Errorf("write %s to %s: %w", key, envPath, err)
		}
		if changed {
			logf("carried %s from the archive into %s", key, envPath)
		} else {
			logf("%s already matches the archive", key)
		}
	}
	return nil
}

// setEnvValue replaces (or appends) KEY=value in an env file, preserving every
// other line. Reports whether the file changed.
func setEnvValue(path, key, value string) (bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	want := key + "=" + value
	lines := strings.Split(string(b), "\n")
	found, changed := false, false
	for i, ln := range lines {
		if !strings.HasPrefix(strings.TrimSpace(ln), key+"=") {
			continue
		}
		found = true
		if lines[i] != want {
			lines[i] = want
			changed = true
		}
		break
	}
	if !found {
		lines = append(lines, want, "")
		changed = true
	}
	if !changed {
		return false, nil
	}
	return true, os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}

// reportConfigDrift prints the deployment knobs the backed-up host had that
// this one does not (or has differently). It is informational only: applying
// them means re-running `chalkctl init --force` with the matching flags, which
// is the operator's decision, not a side effect of loading data.
func (o *RestoreOptions) reportConfigDrift(archived []byte) {
	if archived == nil {
		return
	}
	old := parseEnvBytes(archived)
	cur, err := os.ReadFile(o.ConfigPath)
	if err != nil {
		return
	}
	now := parseEnvBytes(cur)

	// Keys that describe the host, not the deployment's behaviour, differ by
	// design after a move and would only be noise here.
	skip := map[string]bool{"DOMAIN": true, "PUBLIC_IP": true, "ADMIN_USERNAME": true, "ADMIN_EMAIL": true}

	var drift []string
	for k, v := range old {
		if skip[k] || now[k] == v {
			continue
		}
		drift = append(drift, fmt.Sprintf("  %-26s was %-20s now %s", k, v, orNone(now[k])))
	}
	if len(drift) == 0 {
		return
	}
	sort.Strings(drift)
	fmt.Fprintf(o.Out, "\nconfig differences from the backed-up host (NOT applied):\n")
	for _, d := range drift {
		fmt.Fprintln(o.Out, d)
	}
	fmt.Fprintf(o.Out, "to adopt them: chalkctl init --force with the matching flags.\n")
}

func orNone(s string) string {
	if s == "" {
		return "(unset)"
	}
	return s
}

// nextMember reads the next tar member, requiring it to be named want.
func nextMember(tr *tar.Reader, want string) ([]byte, error) {
	hdr, err := tr.Next()
	if err != nil {
		return nil, fmt.Errorf("archive is missing %s: %w", want, err)
	}
	if hdr.Name != want {
		return nil, fmt.Errorf("archive member %q where %s was expected", hdr.Name, want)
	}
	return io.ReadAll(tr)
}

func parseEnvBytes(b []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}

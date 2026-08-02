package chalkctl

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/scuq/chalk/internal/version"
)

// 72-2: `chalkctl backup` -- everything needed to stand this deployment up on
// another host, in one password-encrypted file.
//
// What goes in, and why only this:
//   - the database, which holds every message, channel, membership, device and
//     attachment (attachment ciphertext is a bytea column, not a file), plus
//     the wrapped identity seeds and the encrypted TOTP secrets;
//   - chalk.env, because CHALK_TOTP_ENC_KEY is the key those TOTP secrets are
//     encrypted under. A database restored without it locks every account out
//     at the second factor;
//   - chalkctl.conf, so restore can tell the operator which deployment knobs
//     the old host had set.
//
// What stays out: Caddy's certificate volume (the new host issues its own),
// and the chalk-blobs volume (chalkd never writes to it -- attachments are in
// Postgres).
const (
	DefaultBackupDir = "/var/lib/chalk/backups"

	manifestName = "manifest.json"
	dumpName     = "db.sql.gz"
	envName      = "chalk.env"
	confName     = "chalkctl.conf"

	pgContainer = "postgres"
)

// PGDumpArgs keep the dump loadable whatever the target host's role names are:
// the restore host's chalk role ends up owning everything it loads.
var PGDumpArgs = []string{"--no-owner", "--no-privileges"}

// Manifest describes the deployment a backup was taken from. It is the first
// member of the archive so restore can report what it is about to load before
// it touches anything.
type Manifest struct {
	Format          int       `json:"format"`
	CreatedAt       time.Time `json:"created_at"`
	Domain          string    `json:"domain"`
	ChalkVersion    string    `json:"chalk_version"`
	ChalkDigest     string    `json:"chalk_digest"`
	PostgresTag     string    `json:"postgres_tag"`
	AdminUsername   string    `json:"admin_username"`
	VoiceEnabled    bool      `json:"voice_enabled"`
	ChalkctlVersion string    `json:"chalkctl_version"`
}

// ManifestFormat is the archive's logical layout version, independent of the
// crypto envelope's archiveVersion.
const ManifestFormat = 1

// BackupOptions configures a backup.
type BackupOptions struct {
	Cfg        Config
	Password   string
	OutPath    string // "" -> DefaultBackupDir/chalk-<domain>-<ts>.chalkbak
	Podman     *Podman
	StatePath  string
	EnvPath    string
	ConfigPath string
	Out        io.Writer
}

func (o *BackupOptions) defaults() {
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
}

func (o *BackupOptions) logf(format string, a ...any) {
	fmt.Fprintf(o.Out, "  "+format+"\n", a...)
}

// Backup dumps the database and seals it, the env file and the config into an
// encrypted archive. The stack keeps running throughout: pg_dump reads a
// consistent snapshot, so there is no window where the backup and a live
// writer disagree.
func Backup(o BackupOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	if o.Password == "" {
		return fmt.Errorf("no backup password (use --password-file, $%s, or answer the prompt)", BackupPasswordEnv)
	}
	st, ok, err := LoadState(o.StatePath)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("not initialized (%s missing) -- nothing to back up", o.StatePath)
	}

	outPath := o.OutPath
	if outPath == "" {
		ts := time.Now().UTC().Format("20060102-150405")
		outPath = filepath.Join(DefaultBackupDir, fmt.Sprintf("chalk-%s-%s.chalkbak", o.Cfg.Domain, ts))
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o700); err != nil {
		return err
	}

	fmt.Fprintf(o.Out, "chalkctl backup: %s -> %s\n", o.Cfg.Domain, outPath)

	// pg_dump streams through gzip into a temp file: tar needs each member's
	// size up front, and the dump is the one member too big to hold in memory.
	// The temp file sits beside the archive so the space it needs is on the
	// filesystem the operator chose.
	tmp, err := os.CreateTemp(filepath.Dir(outPath), ".chalk-dump-*.gz")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}

	o.logf("dumping database (pg_dump, live snapshot)...")
	gz := gzip.NewWriter(tmp)
	args := append([]string{"pg_dump", "-U", "chalk", "-d", "chalk"}, PGDumpArgs...)
	if err := o.Podman.ExecOut(gz, pgContainer, args...); err != nil {
		return fmt.Errorf("pg_dump: %w (is chalk-postgres running?)", err)
	}
	if err := gz.Close(); err != nil {
		return err
	}
	dumpSize, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	o.logf("dump: %s compressed", humanBytes(dumpSize))

	envData, err := os.ReadFile(o.EnvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", o.EnvPath, err)
	}
	confData, err := os.ReadFile(o.ConfigPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", o.ConfigPath, err)
	}

	mf := Manifest{
		Format:          ManifestFormat,
		CreatedAt:       time.Now().UTC(),
		Domain:          o.Cfg.Domain,
		ChalkVersion:    st.CurrentVersion,
		ChalkDigest:     st.CurrentDigest,
		PostgresTag:     o.Cfg.PostgresTag,
		AdminUsername:   o.Cfg.AdminUsername,
		VoiceEnabled:    o.Cfg.VoiceEnabled,
		ChalkctlVersion: version.Version,
	}
	mfData, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		return err
	}

	// 0600 from the moment it exists: the archive is only as private as its
	// password, and the password is not on this host.
	f, err := os.OpenFile(outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	o.logf("encrypting (Argon2id + AES-256-GCM)...")
	sealed, err := newSealWriter(f, o.Password)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(sealed)
	// Manifest first so restore can describe the archive from a single pass.
	if err := tarBytes(tw, manifestName, mfData); err != nil {
		return err
	}
	if err := tarBytes(tw, envName, envData); err != nil {
		return err
	}
	if confData != nil {
		if err := tarBytes(tw, confName, confData); err != nil {
			return err
		}
	}
	if err := tarStream(tw, dumpName, dumpSize, tmp); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := sealed.Close(); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}

	info, err := f.Stat()
	if err != nil {
		return err
	}

	// Read the archive back before claiming success. A backup nobody has ever
	// opened is not a backup, and the cheapest moment to find that out is now.
	if err := verifyArchive(outPath, o.Password); err != nil {
		return fmt.Errorf("wrote %s but could not read it back: %w", outPath, err)
	}
	o.logf("verified: the archive opens and its manifest reads back")

	fmt.Fprintf(o.Out, "\nwrote %s (%s)\n", outPath, humanBytes(info.Size()))
	fmt.Fprintf(o.Out, "contains: the database, %s (incl. CHALK_TOTP_ENC_KEY) and %s\n", envName, confName)
	fmt.Fprintf(o.Out, "the password is the ONLY way in -- there is no recovery path if it is lost.\n")
	fmt.Fprintf(o.Out, "restore on the new host with: chalkctl restore %s\n", filepath.Base(outPath))
	return nil
}

// verifyArchive re-opens a just-written archive and reads its manifest, which
// exercises the header, the key derivation and the first frame.
func verifyArchive(path, password string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r, err := newOpenReader(bufio.NewReader(f), password)
	if err != nil {
		return err
	}
	data, err := nextMember(tar.NewReader(r), manifestName)
	if err != nil {
		return err
	}
	var mf Manifest
	return json.Unmarshal(data, &mf)
}

func tarBytes(tw *tar.Writer, name string, data []byte) error {
	if err := tw.WriteHeader(&tar.Header{
		Name: name, Mode: 0o600, Size: int64(len(data)), ModTime: time.Now().UTC(),
	}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

func tarStream(tw *tar.Writer, name string, size int64, r io.Reader) error {
	if err := tw.WriteHeader(&tar.Header{
		Name: name, Mode: 0o600, Size: size, ModTime: time.Now().UTC(),
	}); err != nil {
		return err
	}
	n, err := io.Copy(tw, r)
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("%s: wrote %d bytes, header declared %d", name, n, size)
	}
	return nil
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	// KMGTPE covers every int64, so exp can never run off the end.
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

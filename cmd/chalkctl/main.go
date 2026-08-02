// Command chalkctl is the chalk deployment manager.
//
// The single binary a server operator downloads; from there every deploy
// action is a chalkctl subcommand. `init` self-installs the whole stack
// (ops-3+ops-7): it verifies the signed image, pulls + digest-pins it,
// renders the embedded Quadlet units / Caddyfile / env from flags, and brings
// the rootful-podman stack up behind Caddy (HTTP-01). Other bodies
// (rollback/logs) arrive in later ops slices.
//
// chalkctl versions INDEPENDENTLY of chalkd: its ldflags stamp
// version.Binary="chalkctl".
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/scuq/chalk/internal/chalkctl"
	"github.com/scuq/chalk/internal/version"
)

const binaryName = "chalkctl"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, binaryName+": "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if version.Binary == "chalkd" {
		version.Binary = binaryName // un-stamped dev build
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "version", "--version", "-v":
		fmt.Println(version.String())
		return nil
	case "", "help", "--help", "-h":
		usage()
		return nil
	case "init":
		return runInit(args[1:])
	case "down":
		return runDown(args[1:])
	case "up":
		return runUp(args[1:])
	case "status":
		return runStatus(args[1:])
	case "images":
		return runImages(args[1:])
	case "reconfigure-turn":
		return runReconfigureTurn(args[1:])
	case "update":
		return runUpdate(args[1:])
	case "backup":
		return runBackup(args[1:])
	case "restore":
		return runRestore(args[1:])
	case "self-update", "rollback", "logs":
		return fmt.Errorf("%q is not implemented yet in this build (arrives in a later ops slice)", cmd)
	default:
		return fmt.Errorf("unknown command %q (try `chalkctl help`)", cmd)
	}
}

// runInit parses init flags (which OVERRIDE the config file) and runs the
// bootstrap. Flag precedence: defaults < config file < flags.
func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	var (
		domain     = fs.String("domain", "", "public hostname (required)")
		verTag     = fs.String("version", "", "release tag to deploy (default: channel, e.g. stable)")
		channel    = fs.String("channel", chalkctl.DefaultChannel, "update channel: stable | <tag>")
		image      = fs.String("image", chalkctl.DefaultImage, "GHCR image (no tag)")
		pgTag      = fs.String("postgres-tag", chalkctl.DefaultPostgresTag, "postgres image tag")
		caddyTag   = fs.String("caddy-tag", chalkctl.DefaultCaddyTag, "caddy image tag")
		voice      = fs.Bool("voice", true, "enable Phase 30 voice/video (coturn + TURN)")
		rootful    = fs.Bool("rootful", false, "REQUIRED: run the rootful-podman base (binds 80/443/3478)")
		skipVerify = fs.Bool("skip-verify", false, "skip cosign signature verification (accepts the risk)")
		noStart    = fs.Bool("no-start", false, "write units but do not start the stack")
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file (flags override it)")

		force  = fs.Bool("force", false, "re-apply config over an existing deployment (keeps the DB)")
		dropDB = fs.Bool("drop-db", false, "with --force: WIPE the database (fresh schema); prompts to confirm")
		assume = fs.Bool("yes", false, "skip the --drop-db confirmation prompt (non-interactive)")

		adminUser   = fs.String("admin-username", "", "admin username to seed on first boot (required)")
		adminEmail  = fs.String("admin-email", "", "admin email to seed on first boot (required)")
		openReg     = fs.Bool("open-registration", true, "let anyone register (bootstrap; tighten later)")
		voiceMax    = fs.Int("voice-max-participants", 0, "CHALK_VOICE_MAX_PARTICIPANTS (0 = chalkd default of 5)")
		attachMax   = fs.Int64("attach-max-bytes", 0, "CHALK_ATTACH_MAX_BYTES upload cap (0 = chalkd default)")
		giphyKey    = fs.String("giphy-api-key", "", "CHALK_GIPHY_API_KEY for the GIF picker (optional)")
		lpEnabled   = fs.Bool("linkpreview", true, "enable link previews (sender-side page fetch)")
		lpDomains   = fs.String("linkpreview-domains", "", "CHALK_LINKPREVIEW_DOMAINS whitelist override, comma-separated (default: YouTube + Steam)")
		threadWin   = fs.Int("thread-active-window-hours", 0, "CHALK_THREAD_ACTIVE_WINDOW_HOURS thread-inbox recency (0 = chalkd default of 48)")
		turnVerbose = fs.Bool("turn-verbose", true, "coturn --verbose logging (default on)")
		publicIP    = fs.String("public-ip", "", "coturn listening/relay/external IPv4 (default: detect)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Precedence: start from defaults, overlay the config file, then apply
	// any flag the user explicitly set (tracked via fs.Visit).
	cfg := chalkctl.DefaultConfig()
	cfg, err := chalkctl.LoadConfigFile(cfg, *configPath)
	if err != nil {
		return err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if set["domain"] {
		cfg.Domain = *domain
	}
	if set["channel"] {
		cfg.Channel = *channel
	}
	if set["image"] {
		cfg.Image = *image
	}
	if set["postgres-tag"] {
		cfg.PostgresTag = *pgTag
	}
	if set["caddy-tag"] {
		cfg.CaddyTag = *caddyTag
	}
	if set["voice"] {
		cfg.VoiceEnabled = *voice
	}
	if set["rootful"] {
		cfg.Rootful = *rootful
	}
	if set["admin-username"] {
		cfg.AdminUsername = *adminUser
	}
	if set["admin-email"] {
		cfg.AdminEmail = *adminEmail
	}
	if set["open-registration"] {
		cfg.OpenRegistration = *openReg
	}
	if set["voice-max-participants"] {
		cfg.VoiceMaxParticipants = *voiceMax
	}
	if set["attach-max-bytes"] {
		cfg.AttachMaxBytes = *attachMax
	}
	if set["giphy-api-key"] {
		cfg.GiphyAPIKey = *giphyKey
	}
	if set["linkpreview"] {
		cfg.LinkPreviewEnabled = *lpEnabled
	}
	if set["linkpreview-domains"] {
		cfg.LinkPreviewDomains = *lpDomains
	}
	if set["thread-active-window-hours"] {
		cfg.ThreadActiveWindowHours = *threadWin
	}
	if set["turn-verbose"] {
		cfg.TurnVerbose = *turnVerbose
	}
	if set["public-ip"] {
		cfg.PublicIP = *publicIP
	}

	var verifier chalkctl.Verifier
	if *skipVerify {
		verifier = chalkctl.NoopVerifier{}
	} else {
		verifier = chalkctl.NewCosignVerifier(repoFromImage(cfg.Image))
	}

	var confirm func(string) bool
	if *assume {
		confirm = func(string) bool { return true }
	}
	// --drop-db only meaningful with --force; guard for a clearer error.
	if *dropDB && !*force {
		return fmt.Errorf("--drop-db requires --force (it re-applies then wipes the DB)")
	}

	return chalkctl.Init(chalkctl.InitOptions{
		Cfg:        cfg,
		Version:    *verTag,
		Verifier:   verifier,
		ConfigPath: *configPath,
		NoStart:    *noStart,
		Force:      *force,
		DropDB:     *dropDB,
		Confirm:    confirm,
	})
}

// repoFromImage turns "ghcr.io/scuq/chalk" into "scuq/chalk" for the cosign
// identity pin. Falls back to the last two path segments.
// voiceFromConfig reads the saved config to decide whether coturn is part of
// the stack, so down/up/status act on the right service set. Defaults to true
// (voice on) if the config can't be read -- stopping a non-existent coturn is
// harmless, and it's the safer default for down.
func voiceFromConfig(configPath string) bool {
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), configPath)
	if err != nil {
		return true
	}
	return cfg.VoiceEnabled
}

// runDown stops the stack. --purge removes state.json (so init can re-run);
// --purge-data ALSO wipes the postgres volume (destroys the database).
func runDown(args []string) error {
	fs := flag.NewFlagSet("down", flag.ContinueOnError)
	var (
		purge      = fs.Bool("purge", false, "also remove state.json so `init` can run fresh")
		purgeData  = fs.Bool("purge-data", false, "ALSO wipe the postgres volume (destroys the database)")
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file (for voice detection)")
		statePath  = fs.String("state", chalkctl.DefaultStatePath, "state file path")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	// --purge-data implies --purge (a wiped DB with stale state is incoherent).
	if *purgeData {
		*purge = true
	}
	return chalkctl.Down(chalkctl.LifecycleOptions{
		StatePath:  *statePath,
		PurgeState: *purge,
		PurgeData:  *purgeData,
		Voice:      voiceFromConfig(*configPath),
	})
}

// runUp starts a stack that init already wrote.
func runUp(args []string) error {
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file (for voice detection)")
		statePath  = fs.String("state", chalkctl.DefaultStatePath, "state file path")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return chalkctl.Up(chalkctl.LifecycleOptions{
		StatePath: *statePath,
		Voice:     voiceFromConfig(*configPath),
	})
}

// runStatus prints deployed version + service states.
func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file (for voice detection)")
		statePath  = fs.String("state", chalkctl.DefaultStatePath, "state file path")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return chalkctl.Status(chalkctl.LifecycleOptions{
		StatePath: *statePath,
		Voice:     voiceFromConfig(*configPath),
	})
}

func runImages(args []string) error {
	fs := flag.NewFlagSet("images", flag.ContinueOnError)
	configPath := fs.String("config", chalkctl.DefaultConfigPath, "config file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), *configPath)
	if err != nil {
		return err
	}
	return chalkctl.Images(chalkctl.ImagesOptions{Cfg: cfg})
}

func runReconfigureTurn(args []string) error {
	fs := flag.NewFlagSet("reconfigure-turn", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file")
		verbose    = fs.Bool("turn-verbose", true, "coturn --verbose logging")
		publicIP   = fs.String("public-ip", "", "coturn listening/relay/external IPv4 (default: detect)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), *configPath)
	if err != nil {
		return err
	}
	var vp *bool
	// Only override if the flag was explicitly set.
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "turn-verbose" {
			vp = verbose
		}
	})
	return chalkctl.ReconfigureTurn(chalkctl.ReconfigureTurnOptions{
		Cfg: cfg, ConfigPath: *configPath, Verbose: vp, PublicIP: *publicIP,
	})
}

func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file")
		version    = fs.String("version", "", "target release tag (default: channel, e.g. stable)")
		skipVerify = fs.Bool("skip-verify", false, "skip cosign signature verification")
		skipHealth = fs.Bool("skip-health", false, "skip the post-swap health check (disables auto-rollback)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), *configPath)
	if err != nil {
		return err
	}
	var verifier chalkctl.Verifier
	if *skipVerify {
		verifier = chalkctl.NoopVerifier{}
	} else {
		verifier = chalkctl.NewCosignVerifier(repoFromImage(cfg.Image))
	}
	return chalkctl.Update(chalkctl.UpdateOptions{
		Cfg:        cfg,
		Version:    *version,
		Verifier:   verifier,
		SkipHealth: *skipHealth,
	})
}

// runBackup writes an encrypted archive of the database + env + config.
func runBackup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file")
		statePath  = fs.String("state", chalkctl.DefaultStatePath, "state file path")
		out        = fs.String("out", "", "archive path (default: "+chalkctl.DefaultBackupDir+"/chalk-<domain>-<ts>.chalkbak)")
		pwFile     = fs.String("password-file", "", "read the archive password from this file (default: $"+chalkctl.BackupPasswordEnv+", else prompt)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), *configPath)
	if err != nil {
		return err
	}
	// Fail on the things we can know before asking for a password twice.
	if err := chalkctl.RequireRoot(); err != nil {
		return err
	}
	pw, err := chalkctl.ResolveBackupPassword(*pwFile, true)
	if err != nil {
		return err
	}
	return chalkctl.Backup(chalkctl.BackupOptions{
		Cfg:        cfg,
		Password:   pw,
		OutPath:    *out,
		StatePath:  *statePath,
		ConfigPath: *configPath,
	})
}

// runRestore loads an archive into an already-initialized host.
func runRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	var (
		configPath = fs.String("config", chalkctl.DefaultConfigPath, "config file")
		statePath  = fs.String("state", chalkctl.DefaultStatePath, "state file path")
		pwFile     = fs.String("password-file", "", "read the archive password from this file (default: $"+chalkctl.BackupPasswordEnv+", else prompt)")
		assume     = fs.Bool("yes", false, "skip the confirmation prompt (non-interactive)")
		skipHealth = fs.Bool("skip-health", false, "skip the post-restore health check")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: chalkctl restore <archive> [flags]")
	}
	cfg, err := chalkctl.LoadConfigFile(chalkctl.DefaultConfig(), *configPath)
	if err != nil {
		return err
	}
	if err := chalkctl.RequireRoot(); err != nil {
		return err
	}
	if _, err := os.Stat(fs.Arg(0)); err != nil {
		return err
	}
	pw, err := chalkctl.ResolveBackupPassword(*pwFile, false)
	if err != nil {
		return err
	}
	var confirm func(string) bool
	if *assume {
		confirm = func(string) bool { return true }
	}
	return chalkctl.Restore(chalkctl.RestoreOptions{
		Cfg:        cfg,
		Path:       fs.Arg(0),
		Password:   pw,
		StatePath:  *statePath,
		ConfigPath: *configPath,
		Confirm:    confirm,
		SkipHealth: *skipHealth,
	})
}

func repoFromImage(image string) string {
	parts := splitSlash(image)
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return image
}

func splitSlash(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '/' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	return append(out, cur)
}

func usage() {
	fmt.Print(`chalkctl -- chalk deployment manager

Usage:
  chalkctl <command> [flags]

Commands:
  init         bootstrap a deployment (verify, pull+pin, render, bring up, timer)
  up           start the stack (after init)
  down         stop the stack (--purge to clear state, --purge-data to wipe DB)
  status       show deployed version, digest, and service states
  images       show version/revision/created for chalk, postgres, coturn images
  reconfigure-turn  re-render coturn config+unit and restart coturn only
  update       update the chalk app to a release (verify, swap, health-check, rollback)
  backup       write an encrypted archive of the database + env + config
  restore      load such an archive into this (already initialized) host
  self-update  update the chalkctl binary itself
  rollback     re-pin the previous chalk image
  logs         tail the stack's logs
  version      print version and exit

init flags:
  --domain <host>            public hostname (required)
  --rootful                  REQUIRED: run the rootful-podman base
  --admin-username <name>    admin to seed on first boot (required)
  --admin-email <addr>       admin email (required)
  --version <tag>            release to deploy (default: --channel, e.g. stable)
  --voice[=false]            enable/disable voice (default on)
  --voice-max-participants   mesh room cap (0 = chalkd default of 5)
  --attach-max-bytes         upload size cap (0 = chalkd default)
  --thread-active-window-hours
                             thread-inbox recency window (0 = chalkd default of 48)
  --giphy-api-key <key>      enable the GIF picker (optional)
  --linkpreview[=false]      enable link previews (default on)
  --linkpreview-domains <l>  preview whitelist override, comma-separated
                             (default: YouTube + Steam)
  --turn-verbose[=false]     coturn verbose logging (default on)
  --open-registration[=false] let anyone register (default on; tighten later)
  --force                    re-apply config over an existing deploy (keeps DB)
  --drop-db                  with --force: WIPE the database (prompts to confirm)
  --yes                      skip the --drop-db confirmation (non-interactive)
  --skip-verify              skip cosign signature verification
  --no-start                 write units without starting
  --config <path>            config file (flags override it)

backup flags:
  --out <path>               archive destination
  --password-file <path>     password source (default: $CHALK_BACKUP_PASSWORD,
                             else an interactive prompt)

restore flags:
  chalkctl restore <archive> [flags]
  --password-file <path>     password source (as above)
  --yes                      skip the confirmation prompt
  --skip-health              skip the post-restore health check

Moving a deployment to a new host:
  old host:  chalkctl backup --out /root/chalk.chalkbak
  copy the archive across (scp), then on the new host:
  new host:  chalkctl init --domain <same-or-new> --rootful \
                 --admin-username <name> --admin-email <addr>
             chalkctl restore /root/chalk.chalkbak
  init issues the certificates and proves the stack healthy; restore then
  replaces the database and carries over CHALK_TOTP_ENC_KEY, without which
  every account's second factor would be unreadable. Keep the domain the
  same to keep existing passkeys working.
`)
}

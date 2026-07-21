// Command chalkctl is the chalk deployment manager.
//
// The single binary a server operator downloads; from there every deploy
// action is a chalkctl subcommand. `init` self-installs the whole stack
// (ops-3+ops-7): it verifies the signed image, pulls + digest-pins it,
// renders the embedded Quadlet units / Caddyfile / env from flags, and brings
// the rootful-podman stack up behind Caddy (HTTP-01). Other bodies
// (update/rollback/backup/logs) arrive in later ops slices.
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
	case "status", "update", "self-update", "rollback", "backup", "logs":
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

		adminUser  = fs.String("admin-username", "", "admin username to seed on first boot (required)")
		adminEmail = fs.String("admin-email", "", "admin email to seed on first boot (required)")
		openReg    = fs.Bool("open-registration", true, "let anyone register (bootstrap; tighten later)")
		voiceMax   = fs.Int("voice-max-participants", 0, "CHALK_VOICE_MAX_PARTICIPANTS (0 = chalkd default of 5)")
		attachMax  = fs.Int64("attach-max-bytes", 0, "CHALK_ATTACH_MAX_BYTES upload cap (0 = chalkd default)")
		giphyKey   = fs.String("giphy-api-key", "", "CHALK_GIPHY_API_KEY for the GIF picker (optional)")
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

	var verifier chalkctl.Verifier
	if *skipVerify {
		verifier = chalkctl.NoopVerifier{}
	} else {
		verifier = chalkctl.NewCosignVerifier(repoFromImage(cfg.Image))
	}

	return chalkctl.Init(chalkctl.InitOptions{
		Cfg:        cfg,
		Version:    *verTag,
		Verifier:   verifier,
		ConfigPath: *configPath,
		NoStart:    *noStart,
	})
}

// repoFromImage turns "ghcr.io/scuq/chalk" into "scuq/chalk" for the cosign
// identity pin. Falls back to the last two path segments.
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
  status       show deployed version, health, and update availability
  update       update the chalk app to the newest release
  self-update  update the chalkctl binary itself
  rollback     restore the previous chalk image
  backup       take a database backup now
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
  --giphy-api-key <key>      enable the GIF picker (optional)
  --open-registration[=false] let anyone register (default on; tighten later)
  --skip-verify              skip cosign signature verification
  --no-start                 write units without starting
  --config <path>            config file (flags override it)

Only init/version/help are wired in this build.
`)
}

// Command chalkctl is the chalk deployment manager.
//
// The single binary a server operator downloads; from there every deploy
// action is a chalkctl subcommand (init, status, update, self-update,
// rollback, backup, logs). This is the ops-1b SKELETON: it establishes the
// binary, its own release train (ctl-v* tags), and version stamping shared
// with chalkd via internal/version. The real command bodies land in the
// later ops slices (ops-3 config/state/status, ops-4 podman driver,
// ops-6 auto-update, ops-7 init, ops-8 signature verify).
//
// chalkctl versions INDEPENDENTLY of chalkd: its ldflags stamp
// version.Binary="chalkctl" so `chalkctl version` reads correctly even
// though it reuses the chalkd version package.
package main

import (
	"fmt"
	"os"

	"github.com/scuq/chalk/internal/version"
)

// binaryName overrides version.Binary for this command's banner, since the
// shared package defaults to "chalkd". The release ldflags also set it, but
// this keeps `go run ./cmd/chalkctl` honest without ldflags.
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
	case "init", "status", "update", "self-update", "rollback", "backup", "logs":
		// Established as the command surface; bodies arrive in later ops
		// slices. Fail loudly rather than silently no-op.
		return fmt.Errorf("%q is not implemented yet in this build (ops-1b skeleton)", cmd)
	default:
		return fmt.Errorf("unknown command %q (try `chalkctl help`)", cmd)
	}
}

func usage() {
	fmt.Print(`chalkctl -- chalk deployment manager

Usage:
  chalkctl <command> [flags]

Commands:
  init         bootstrap a deployment (env, units, pull, bring-up, timer)
  status       show deployed version, health, and update availability
  update       update the chalk app to the newest release (backup, swap,
               healthcheck, rollback on failure)
  self-update  update the chalkctl binary itself
  rollback     restore the previous chalk image (optionally the DB backup)
  backup       take a database backup now
  logs         tail the stack's logs
  version      print version and exit

This build is the ops-1b skeleton: only version/help are wired.
`)
}

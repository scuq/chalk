package chalkctl

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// The stack's services in dependency order. down stops in reverse; up starts
// forward. coturn is included conditionally (voice only) by the caller.
var stackServicesBase = []string{
	"chalk-postgres.service",
	"chalkd.service",
	"chalk-caddy.service",
}

// LifecycleOptions carries paths + output for down/up/status.
type LifecycleOptions struct {
	StatePath string
	Out       io.Writer
	// PurgeState removes state.json so `init` can run fresh (down only).
	PurgeState bool
	// PurgeData ALSO removes the postgres data volume (down only) -- wipes
	// the database. Never implied; requires explicit --purge-data.
	PurgeData bool
	// Voice controls whether coturn is part of the stack.
	Voice bool
}

func (o *LifecycleOptions) defaults() {
	if o.StatePath == "" {
		o.StatePath = DefaultStatePath
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
}

func (o *LifecycleOptions) services() []string {
	svcs := append([]string{}, stackServicesBase...)
	if o.Voice {
		svcs = append(svcs, "chalk-coturn.service")
	}
	return svcs
}

// Down stops the whole stack. It is idempotent and tolerant: a service that is
// already stopped or was never created is not an error (we reset-failed then
// stop, ignoring "not loaded"). With PurgeState it removes state.json so
// `init` can run again; with PurgeData it also removes the postgres volume
// (destroys the database -- explicit opt-in only).
//
// This replaces the manual `systemctl stop ... && rm state.json && podman
// volume rm chalk-pgdata` dance.
func Down(o LifecycleOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	// Stop in REVERSE dependency order (caddy -> chalkd -> postgres),
	// plus coturn and the update timer.
	svcs := o.services()
	stopOrder := append([]string{"chalk-update.timer"}, reversed(svcs)...)
	for _, svc := range stopOrder {
		// reset-failed clears any restart-limit lockout so a later `up`
		// isn't blocked; ignore errors (service may not exist).
		_, _ = Systemctl("reset-failed", svc)
		if _, err := Systemctl("stop", svc); err != nil {
			// "not loaded" / "not found" are fine -- report others.
			fmt.Fprintf(o.Out, "  (stop %s: %v)\n", svc, err)
		} else {
			fmt.Fprintf(o.Out, "  stopped %s\n", svc)
		}
	}

	if o.PurgeState {
		if err := os.Remove(o.StatePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove state %s: %w", o.StatePath, err)
		}
		fmt.Fprintf(o.Out, "  removed %s (init can run fresh)\n", o.StatePath)
	}
	if o.PurgeData {
		p := NewPodman()
		if _, err := p.run("volume", "rm", "-f", "chalk-pgdata"); err != nil {
			fmt.Fprintf(o.Out, "  (volume rm chalk-pgdata: %v)\n", err)
		} else {
			fmt.Fprintf(o.Out, "  removed chalk-pgdata volume (DATABASE WIPED)\n")
		}
	}
	fmt.Fprintln(o.Out, "stack down.")
	return nil
}

// Up starts the whole stack in dependency order. Requires that init has
// already written the units (state.json present); otherwise points the
// operator at init.
func Up(o LifecycleOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	if _, ok, err := LoadState(o.StatePath); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("not initialized (%s missing) -- run `chalkctl init` first", o.StatePath)
	}
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	for _, svc := range o.services() {
		if _, err := Systemctl("start", svc); err != nil {
			return fmt.Errorf("start %s (check `journalctl -u %s`): %w", svc, svc, err)
		}
		fmt.Fprintf(o.Out, "  started %s\n", svc)
	}
	// Re-enable the weekly timer if present.
	_, _ = Systemctl("start", "chalk-update.timer")
	fmt.Fprintln(o.Out, "stack up.")
	return nil
}

// Status prints the deployed version/digest from state and each service's
// active state. Read-only.
func Status(o LifecycleOptions) error {
	o.defaults()
	st, ok, err := LoadState(o.StatePath)
	if err != nil {
		return err
	}
	if !ok {
		fmt.Fprintf(o.Out, "not initialized (%s missing) -- run `chalkctl init`\n", o.StatePath)
		return nil
	}
	fmt.Fprintf(o.Out, "deployed: %s\n", st.CurrentVersion)
	fmt.Fprintf(o.Out, "digest:   %s\n", st.CurrentDigest)
	fmt.Fprintf(o.Out, "channel:  %s\n", st.Channel)
	if !st.UpdatedAt.IsZero() {
		fmt.Fprintf(o.Out, "since:    %s\n", st.UpdatedAt.Format("2006-01-02 15:04:05 MST"))
	}
	fmt.Fprintln(o.Out, "services:")
	for _, svc := range o.services() {
		// `systemctl is-active` exits non-zero for inactive/failed but still
		// prints the state to stdout, so read the output directly rather than
		// through Systemctl (which treats non-zero as an error).
		state := isActiveState(svc)
		fmt.Fprintf(o.Out, "  %-24s %s\n", svc, state)
	}
	return nil
}

// isActiveState returns systemctl's is-active word ("active", "inactive",
// "failed", "activating", ...), tolerating the non-zero exit that is-active
// uses for non-active units.
func isActiveState(svc string) string {
	out, _ := exec.Command("systemctl", "is-active", svc).Output()
	s := strings.TrimSpace(string(out))
	if s == "" {
		return "unknown"
	}
	return s
}

func reversed(in []string) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[len(in)-1-i] = v
	}
	return out
}

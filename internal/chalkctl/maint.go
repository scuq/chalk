package chalkctl

import (
	"fmt"
	"html"
	"io"
	"os"
	"strings"
)

// 72-5: `chalkctl maint on|off` -- take the app down without taking the site
// down.
//
// Stopping chalkd leaves Caddy returning a bare 502 to anyone who happens to
// be mid-sentence. Maintenance mode re-renders ONLY the Caddyfile so Caddy
// answers every request itself with a 503 notice, and reloads Caddy in place.
// Nothing else moves: not the units, not the image pin, not chalkd, not the
// database. That is what makes it safe to flip on before a restore or a
// Postgres upgrade and off again afterwards.
//
// It is the same shape as ReconfigureTurn: re-render one template, act on one
// service, and persist the flag that drives the next re-render.

// DefaultMaintenanceMessage is used when `maint on` is given no --message.
const DefaultMaintenanceMessage = "someone is working on the server. it will be back shortly."

const caddyContainer = "caddy"

// MaintOptions configures a maintenance-mode switch.
type MaintOptions struct {
	Cfg         Config
	On          bool
	Message     string // "" -> DefaultMaintenanceMessage (ignored when On is false)
	Podman      *Podman
	StatePath   string
	CaddyfileAt string
	Out         io.Writer
}

func (o *MaintOptions) defaults() {
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	if o.StatePath == "" {
		o.StatePath = DefaultStatePath
	}
	if o.CaddyfileAt == "" {
		o.CaddyfileAt = DefaultCaddyfile
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
}

// MaintenanceMessageHTML validates an operator-supplied notice and returns it
// ready to embed. The message lands inside a backtick-quoted Caddyfile string
// that is also HTML, so a backtick would end the string early and a tag would
// end up live on the page -- the first is rejected outright, the second
// escaped.
func MaintenanceMessageHTML(msg string) (string, error) {
	msg = strings.TrimSpace(msg)
	if msg == "" {
		msg = DefaultMaintenanceMessage
	}
	if strings.ContainsAny(msg, "`") {
		return "", fmt.Errorf("maintenance message cannot contain a backtick (it would terminate the Caddyfile string)")
	}
	if strings.ContainsAny(msg, "\r\n") {
		return "", fmt.Errorf("maintenance message must be a single line")
	}
	return html.EscapeString(msg), nil
}

// Maint switches maintenance mode on or off.
func Maint(o MaintOptions) error {
	o.defaults()
	if err := RequireRoot(); err != nil {
		return err
	}
	st, ok, err := LoadState(o.StatePath)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("not initialized (%s missing) -- run `chalkctl init` first", o.StatePath)
	}

	msg := ""
	if o.On {
		if msg, err = MaintenanceMessageHTML(o.Message); err != nil {
			return err
		}
	}
	if st.Maintenance == o.On && st.MaintenanceMessage == msg {
		fmt.Fprintf(o.Out, "maintenance mode is already %s; nothing to do.\n", onOff(o.On))
		return nil
	}

	if err := writeCaddyfile(o.Cfg, o.CaddyfileAt, o.On, msg); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "  wrote %s\n", o.CaddyfileAt)

	if err := reloadCaddy(o.Podman, o.Out); err != nil {
		return err
	}

	st.Maintenance = o.On
	st.MaintenanceMessage = msg
	if err := st.Save(o.StatePath); err != nil {
		return err
	}

	if o.On {
		fmt.Fprintf(o.Out, "\nmaintenance mode ON -- https://%s serves the notice (503).\n", o.Cfg.Domain)
		fmt.Fprintf(o.Out, "chalkd is untouched and still running; stop it separately if the work needs it.\n")
		fmt.Fprintf(o.Out, "/healthz still reaches chalkd, so update/restore health checks keep working.\n")
		fmt.Fprintf(o.Out, "turn it off with: chalkctl maint off\n")
	} else {
		fmt.Fprintf(o.Out, "\nmaintenance mode OFF -- https://%s is serving chalk again.\n", o.Cfg.Domain)
	}
	return nil
}

// MaintStatus reports the current mode without changing anything.
func MaintStatus(statePath string, out io.Writer) error {
	if statePath == "" {
		statePath = DefaultStatePath
	}
	if out == nil {
		out = os.Stdout
	}
	st, ok, err := LoadState(statePath)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("not initialized (%s missing)", statePath)
	}
	fmt.Fprintf(out, "maintenance: %s\n", onOff(st.Maintenance))
	if st.Maintenance && st.MaintenanceMessage != "" {
		fmt.Fprintf(out, "message:     %s\n", html.UnescapeString(st.MaintenanceMessage))
	}
	return nil
}

// writeCaddyfile re-renders the Caddyfile in the requested mode. Only the
// fields the Caddyfile template reads are filled in -- rendering the whole
// InitParams here would mean reconstructing secrets this command has no
// business touching.
func writeCaddyfile(cfg Config, path string, maintenance bool, message string) error {
	data, err := renderTemplate("Caddyfile", InitParams{
		Domain:             cfg.Domain,
		Maintenance:        maintenance,
		MaintenanceMessage: message,
	})
	if err != nil {
		return err
	}
	return writeFile(path, data, 0o644)
}

// reloadCaddy applies the new Caddyfile without dropping connections. A
// restart is the fallback: it costs a blip, but leaving Caddy on the old
// config after the file has changed is worse -- the operator would believe
// maintenance is on when it is not.
func reloadCaddy(p *Podman, out io.Writer) error {
	if _, err := p.run("exec", caddyContainer, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"); err == nil {
		fmt.Fprintln(out, "  reloaded caddy (no connections dropped)")
		return nil
	}
	fmt.Fprintln(out, "  caddy reload failed; restarting chalk-caddy instead")
	if _, err := Systemctl("restart", "chalk-caddy.service"); err != nil {
		return fmt.Errorf("reload and restart both failed (check `journalctl -u chalk-caddy`): %w", err)
	}
	fmt.Fprintln(out, "  restarted chalk-caddy")
	return nil
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

package chalkctl

// 80-11: operator surface for ephemeral voice channels.
//
//	chalkctl ephemeral list                     what exists, who is in it
//	chalkctl ephemeral purge [--channel <id>]   destroy now (one room or all)
//	chalkctl ephemeral disable                  feature off + all links revoked
//
// Purge deliberately does NOT re-implement the deletion: it sets expires_at
// to now() (and revokes the room's links), and chalkd's minutely expiry
// janitor performs the actual hard delete -- one deletion path, audited in
// chalkd's log, with the same client push + call kick a natural expiry gets.
// Two deletion implementations would drift; this one cannot.

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
)

// EphemeralOptions configures the ephemeral subcommands.
type EphemeralOptions struct {
	Cfg        Config
	Podman     *Podman
	EnvPath    string
	ConfigPath string
	Out        io.Writer
	// Confirm gates purge (type-the-domain). nil -> interactive prompt; a
	// func returning true for --yes.
	Confirm func(prompt string) bool
	// Restart restarts chalkd after disable. nil -> systemctl; tests stub it.
	Restart func() error
}

func (o *EphemeralOptions) defaults() {
	if o.Podman == nil {
		o.Podman = NewPodman()
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
	if o.Restart == nil {
		o.Restart = func() error {
			_, err := Systemctl("restart", "chalkd.service")
			return err
		}
	}
}

// ephemeralRoom is one row of `ephemeral list` / the purge pre-report.
type ephemeralRoom struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	Guests      int       `json:"guests"`
	LiveInvites int       `json:"live_invites"`
	Invites     int       `json:"invites"`
	InCall      int       `json:"in_call"`
	Messages    int       `json:"messages"`
}

// listEphemeralRooms queries the rooms (optionally one) through the postgres
// container, the metrics pattern: one query, one JSON value.
func listEphemeralRooms(p *Podman, channelID string) ([]ephemeralRoom, error) {
	where := "c.expires_at IS NOT NULL"
	if channelID != "" {
		// Caller has validated the UUID; embed the canonical form.
		where += " AND c.id = '" + channelID + "'"
	}
	var rooms []ephemeralRoom
	err := psqlJSON(p, `
SELECT COALESCE(json_agg(r ORDER BY r.expires_at), '[]'::json) FROM (
  SELECT c.id, c.name, c.created_at, c.expires_at,
         (SELECT count(*) FROM users u WHERE u.guest_channel_id = c.id)          AS guests,
         (SELECT count(*) FROM ephemeral_invites i
           WHERE i.channel_id = c.id AND i.revoked_at IS NULL
             AND i.expires_at > now())                                           AS live_invites,
         (SELECT count(*) FROM ephemeral_invites i WHERE i.channel_id = c.id)    AS invites,
         (SELECT count(*) FROM voice_participants vp WHERE vp.channel_id = c.id) AS in_call,
         (SELECT count(*) FROM messages m
           WHERE m.channel_id = c.id AND m.ts >= c.created_at)                   AS messages
    FROM channels c
   WHERE `+where+`
) r`, &rooms)
	if err != nil {
		return nil, err
	}
	return rooms, nil
}

// EphemeralList prints every ephemeral room.
func EphemeralList(o EphemeralOptions) error {
	o.defaults()
	rooms, err := listEphemeralRooms(o.Podman, "")
	if err != nil {
		return err
	}
	if len(rooms) == 0 {
		fmt.Fprintln(o.Out, "no ephemeral channels.")
		return nil
	}
	fmt.Fprintf(o.Out, "%-36s  %-20s  %-16s  %6s  %6s  %7s  %8s\n",
		"CHANNEL", "NAME", "EXPIRES", "GUESTS", "LINKS", "IN-CALL", "MESSAGES")
	now := time.Now()
	for _, r := range rooms {
		expires := "EXPIRED"
		if r.ExpiresAt.After(now) {
			expires = "in " + time.Until(r.ExpiresAt).Round(time.Minute).String()
		}
		name := r.Name
		if len(name) > 20 {
			name = name[:19] + "…"
		}
		fmt.Fprintf(o.Out, "%-36s  %-20s  %-16s  %6d  %2d/%-3d  %7d  %8d\n",
			r.ID, name, expires, r.Guests, r.LiveInvites, r.Invites, r.InCall, r.Messages)
	}
	return nil
}

// EphemeralPurge expires one room (channelID != "") or every ephemeral room
// NOW: links are revoked and expires_at set to now(); chalkd's janitor
// hard-deletes within the minute (or at its next start if chalkd is down).
func EphemeralPurge(o EphemeralOptions, channelID string) error {
	o.defaults()
	if channelID != "" {
		id, err := uuid.Parse(channelID)
		if err != nil {
			return fmt.Errorf("--channel %q is not a UUID", channelID)
		}
		channelID = id.String()
	}

	rooms, err := listEphemeralRooms(o.Podman, channelID)
	if err != nil {
		return err
	}
	if len(rooms) == 0 {
		if channelID != "" {
			return fmt.Errorf("%s is not an ephemeral channel (or is already gone)", channelID)
		}
		fmt.Fprintln(o.Out, "no ephemeral channels to purge.")
		return nil
	}

	var guests, inCall int
	for _, r := range rooms {
		guests += r.Guests
		inCall += r.InCall
	}
	fmt.Fprintf(o.Out, "about to destroy %d ephemeral channel(s): %d guest account(s), %d live call participant(s).\n",
		len(rooms), guests, inCall)
	if !o.Confirm(fmt.Sprintf(
		"This PERMANENTLY DESTROYS the room(s), their messages and their guests.\nType the domain (%s) to confirm: ",
		o.Cfg.Domain)) {
		return fmt.Errorf("aborted: purge not confirmed")
	}

	where := "expires_at IS NOT NULL"
	if channelID != "" {
		where += " AND id = '" + channelID + "'"
	}
	sql := `BEGIN;
UPDATE ephemeral_invites SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND channel_id IN (SELECT id FROM channels WHERE ` + where + `);
UPDATE channels SET expires_at = now() WHERE ` + where + `;
COMMIT;
`
	args := append([]string{"psql", "-U", "chalk", "-d", "chalk"}, "-q", "-v", "ON_ERROR_STOP=1")
	if err := o.Podman.ExecIn(strings.NewReader(sql), pgContainer, args...); err != nil {
		return fmt.Errorf("purge: %w", err)
	}
	fmt.Fprintf(o.Out, "done. %d channel(s) expired; chalkd's janitor hard-deletes them within a minute\n", len(rooms))
	fmt.Fprintln(o.Out, "(if chalkd is stopped, the delete happens at its next start; watch `journalctl -u chalkd | grep 'ephemeral janitor'`).")
	return nil
}

// EphemeralDisable turns the feature off: CHALK_EPHEMERAL_ENABLED=false in
// the env (and the chalkctl config so a later init --force keeps it off),
// every outstanding link revoked, chalkd restarted to load the flag.
// Existing rooms and guests live out their TTL -- follow with
// `ephemeral purge` to destroy them too.
func EphemeralDisable(o EphemeralOptions) error {
	o.defaults()
	if _, err := setEnvValue(o.EnvPath, "CHALK_EPHEMERAL_ENABLED", "false"); err != nil {
		return fmt.Errorf("write %s: %w", o.EnvPath, err)
	}
	fmt.Fprintf(o.Out, "  set CHALK_EPHEMERAL_ENABLED=false in %s\n", o.EnvPath)
	if _, err := os.Stat(o.ConfigPath); err == nil {
		if _, err := setEnvValue(o.ConfigPath, "EPHEMERAL_ENABLED", "false"); err != nil {
			return fmt.Errorf("write %s: %w", o.ConfigPath, err)
		}
		fmt.Fprintf(o.Out, "  set EPHEMERAL_ENABLED=false in %s\n", o.ConfigPath)
	}

	sql := `UPDATE ephemeral_invites SET revoked_at = now() WHERE revoked_at IS NULL;`
	args := append([]string{"psql", "-U", "chalk", "-d", "chalk"}, "-q", "-v", "ON_ERROR_STOP=1")
	if err := o.Podman.ExecIn(strings.NewReader(sql), pgContainer, args...); err != nil {
		return fmt.Errorf("revoke outstanding links: %w", err)
	}
	fmt.Fprintln(o.Out, "  revoked all outstanding invite links")

	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd (the env flag loads on boot): %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	fmt.Fprintln(o.Out, "ephemeral channels are disabled. Existing rooms live out their TTL;")
	fmt.Fprintln(o.Out, "run `chalkctl ephemeral purge` to destroy them now.")
	return nil
}

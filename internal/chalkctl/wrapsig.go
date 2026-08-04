package chalkctl

// 82-9: the operator surface for CHALK_WRAP_SIG_REQUIRED.
//
// Phase 82 made every channel-key wrap signed, but shipped the enforcement
// flag OFF: existing channels were full of unsigned (suite-1) wraps, and
// refusing those on day one would have locked members out of their own
// channels. A self-healing sweep re-signs a channel's wraps whenever a member
// on a current build opens it, so the population drains on its own -- and the
// flag is what finally withdraws acceptance of what is left.
//
// That leaves the operator with a question they cannot answer by looking:
// "has the sweep finished?" This command answers it from the one place that
// knows -- channel_keys.wrap_suite. The server cannot verify a signature (it
// is the party signatures defend against) but the SUITE is a plain column, and
// "which slots are still suite 1" is exactly the readiness question.
//
// Scope, deliberately: only each channel's CURRENT key version counts. Old
// versions are never re-fetched by a client (decryptForChannel reads the local
// cache and nothing else), so an unsigned wrap at an old version cannot block
// anyone -- a device either cached that key long ago or already could not read
// that history, flag or no flag. Counting them would manufacture blockers.

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// WrapSigOptions mirrors EphemeralOptions: the paths to edit, how to reach
// Postgres, and how to restart chalkd once a flag changes.
type WrapSigOptions struct {
	Podman     *Podman
	EnvPath    string
	ConfigPath string
	Out        io.Writer
	// Restart reloads chalkd after the flag changes. nil -> systemctl.
	Restart func() error
}

func (o *WrapSigOptions) defaults() {
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
	if o.Restart == nil {
		o.Restart = func() error {
			_, err := Systemctl("restart", "chalkd.service")
			return err
		}
	}
}

// laggingChannel is one channel still holding unsigned wraps at its current
// key version, with the members those wraps belong to -- the actionable part,
// since the fix is "those people open chalk" or "a holder re-shares".
type laggingChannel struct {
	ChannelID string   `json:"channel_id"`
	Name      string   `json:"name"`
	Unsigned  int      `json:"unsigned_wraps"`
	Total     int      `json:"total_wraps"`
	Members   []string `json:"members"`
}

// wrapSigTotals is the whole-deployment count behind the verdict.
type wrapSigTotals struct {
	UnsignedWraps int `json:"unsigned_wraps"`
	TotalWraps    int `json:"total_wraps"`
	Channels      int `json:"channels"`
}

// Expired channels are excluded everywhere below: chalkd's janitor hard-deletes
// them within the minute, so letting a dead guest room report "not ready"
// would block the operator on something that is about to cease to exist.
const wrapSigLiveFrom = `
	  FROM channels c
	  JOIN channel_keys k
	    ON k.channel_id = c.id AND k.key_version = c.current_key_version`

const wrapSigLiveWhere = `
	 WHERE (c.expires_at IS NULL OR c.expires_at > now())`

const qWrapSigTotals = `SELECT row_to_json(t) FROM (
	SELECT count(*) FILTER (WHERE k.wrap_suite < 2)::int AS unsigned_wraps,
	       count(*)::int                                 AS total_wraps,
	       count(DISTINCT c.id)::int                     AS channels` +
	wrapSigLiveFrom + wrapSigLiveWhere + `) t;`

// The members column names who the lagging wraps belong to, so the users join
// is part of the lagging query and not of the shared FROM clause above.
const qWrapSigLagging = `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json) FROM (
	SELECT c.id::text AS channel_id,
	       c.name     AS name,
	       count(*) FILTER (WHERE k.wrap_suite < 2)::int AS unsigned_wraps,
	       count(*)::int                                 AS total_wraps,
	       coalesce(
	         array_agg(u.handle::text ORDER BY u.handle) FILTER (WHERE k.wrap_suite < 2),
	         '{}'
	       ) AS members` +
	wrapSigLiveFrom + `
	  JOIN users u ON u.id = k.recipient_id` +
	wrapSigLiveWhere + `
	 GROUP BY c.id, c.name
	HAVING count(*) FILTER (WHERE k.wrap_suite < 2) > 0
) t;`

// Guest invites parked before 82-7 carry an unsigned wrap. They are NOT
// blockers -- the redeem path copies a parked wrap rather than minting a new
// one, so it is not gated by the flag, and the links expire within hours.
// Reported so the number is not a surprise.
const qWrapSigInvites = `SELECT count(*)::int FROM ephemeral_invites
	 WHERE wrap_suite < 2 AND revoked_at IS NULL AND expires_at > now();`

// WrapSigReport is the readiness answer, split from the printing so the
// verdict is testable without a database.
type WrapSigReport struct {
	Totals         wrapSigTotals
	Lagging        []laggingChannel
	UnsignedGuests int
}

// Ready reports whether CHALK_WRAP_SIG_REQUIRED=true can be turned on without
// stranding anyone: every wrap at every live channel's current key version is
// signed. Unsigned GUEST INVITES do not gate it (see qWrapSigInvites).
func (r WrapSigReport) Ready() bool {
	return r.Totals.UnsignedWraps == 0
}

func collectWrapSig(p *Podman) (WrapSigReport, error) {
	var r WrapSigReport
	if err := psqlJSON(p, qWrapSigTotals, &r.Totals); err != nil {
		return r, fmt.Errorf("count wraps: %w", err)
	}
	if err := psqlJSON(p, qWrapSigLagging, &r.Lagging); err != nil {
		return r, fmt.Errorf("list lagging channels: %w", err)
	}
	if err := psqlJSON(p, qWrapSigInvites, &r.UnsignedGuests); err != nil {
		return r, fmt.Errorf("count guest invites: %w", err)
	}
	return r, nil
}

// WrapSigStatus prints whether the deployment is ready for enforcement.
func WrapSigStatus(o WrapSigOptions) error {
	o.defaults()
	r, err := collectWrapSig(o.Podman)
	if err != nil {
		return err
	}
	current := currentWrapSigSetting(o.EnvPath)
	fmt.Fprintf(o.Out, "CHALK_WRAP_SIG_REQUIRED is currently %s\n\n", current)

	signed := r.Totals.TotalWraps - r.Totals.UnsignedWraps
	fmt.Fprintf(o.Out, "channel keys at current versions: %d of %d signed, across %d channel(s)\n",
		signed, r.Totals.TotalWraps, r.Totals.Channels)

	if r.Ready() {
		fmt.Fprintln(o.Out, "\nREADY: every channel key in use is signed.")
		if current == "true" {
			fmt.Fprintln(o.Out, "Enforcement is already on; nothing to do.")
			return nil
		}
		fmt.Fprintln(o.Out, "Turn enforcement on with `chalkctl wrapsig enable`.")
		return nil
	}

	fmt.Fprintf(o.Out, "\nNOT READY: %d wrap(s) are still unsigned.\n", r.Totals.UnsignedWraps)
	fmt.Fprintln(o.Out, "These members would be blocked ('waiting') until a key holder re-shares:")
	for _, ch := range r.Lagging {
		fmt.Fprintf(o.Out, "  %-28s %d/%d unsigned  %s\n",
			truncate(ch.Name, 28), ch.Unsigned, ch.Total, strings.Join(ch.Members, ", "))
	}
	fmt.Fprintln(o.Out, "\nA channel re-signs itself when any member on a current build opens it,")
	fmt.Fprintln(o.Out, "so this list drains on its own. Nudge the people above to open chalk,")
	fmt.Fprintln(o.Out, "or have a key holder open each channel and use 're-share' in the members panel.")

	if r.UnsignedGuests > 0 {
		fmt.Fprintf(o.Out, "\nAlso: %d outstanding guest link(s) carry an unsigned key. These do NOT\n", r.UnsignedGuests)
		fmt.Fprintln(o.Out, "block enforcement -- redeeming an already-issued link is not gated -- and")
		fmt.Fprintln(o.Out, "they expire within hours. New links are signed either way.")
	}
	return nil
}

// WrapSigEnable turns enforcement on: unsigned wraps are refused server-side on
// publish, and clients are told (welcome.wrap_sig_required) to refuse them on
// read. Refuses to run while anyone would be stranded unless force is set.
func WrapSigEnable(o WrapSigOptions, force bool) error {
	o.defaults()
	r, err := collectWrapSig(o.Podman)
	if err != nil {
		return err
	}
	if !r.Ready() && !force {
		return fmt.Errorf(
			"%d wrap(s) at current key versions are still unsigned across %d channel(s); "+
				"run `chalkctl wrapsig status` to see who, or pass --force to enforce anyway "+
				"(they will be blocked until a key holder re-shares)",
			r.Totals.UnsignedWraps, len(r.Lagging))
	}
	if !r.Ready() {
		fmt.Fprintf(o.Out, "--force: enforcing with %d unsigned wrap(s) still out there.\n", r.Totals.UnsignedWraps)
	}
	return setWrapSig(o, "true")
}

// WrapSigDisable turns enforcement back off. The way out when enabling turns
// out to have stranded someone: unsigned wraps are accepted again immediately,
// so a blocked member recovers on their next channel open rather than needing
// anyone to re-share.
func WrapSigDisable(o WrapSigOptions) error {
	o.defaults()
	return setWrapSig(o, "false")
}

func setWrapSig(o WrapSigOptions, value string) error {
	if _, err := setEnvValue(o.EnvPath, "CHALK_WRAP_SIG_REQUIRED", value); err != nil {
		return fmt.Errorf("write %s: %w", o.EnvPath, err)
	}
	fmt.Fprintf(o.Out, "  set CHALK_WRAP_SIG_REQUIRED=%s in %s\n", value, o.EnvPath)
	// The chalkctl config too, so a later `init --force` re-renders the same
	// choice instead of quietly reverting it.
	if _, err := os.Stat(o.ConfigPath); err == nil {
		if _, err := setEnvValue(o.ConfigPath, "WRAP_SIG_REQUIRED", value); err != nil {
			return fmt.Errorf("write %s: %w", o.ConfigPath, err)
		}
		fmt.Fprintf(o.Out, "  set WRAP_SIG_REQUIRED=%s in %s\n", value, o.ConfigPath)
	}
	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd (the env flag loads on boot): %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	if value == "true" {
		fmt.Fprintln(o.Out, "signed channel keys are now REQUIRED. Open browser tabs pick this up on reload.")
	} else {
		fmt.Fprintln(o.Out, "enforcement is off; unsigned channel keys are accepted again.")
	}
	return nil
}

// currentWrapSigSetting reads the flag as deployed. An absent value reads as
// "false (unset)" rather than "false", because those differ operationally:
// unset means the env file predates 82-6 and `chalkctl update` has not
// backfilled it yet.
func currentWrapSigSetting(envPath string) string {
	env, err := readEnvSecrets(envPath) // a plain KEY=value parse despite the name
	if err != nil {
		return "unknown (could not read " + envPath + ")"
	}
	v := strings.TrimSpace(env["CHALK_WRAP_SIG_REQUIRED"])
	if v == "" {
		return "false (unset)"
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

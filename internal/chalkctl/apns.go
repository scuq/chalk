package chalkctl

import (
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/scuq/chalk/internal/apns"
)

// 136-4c: the operator commands for native push to the iOS app.
//
// `chalkctl push apns set` reads the .p8 key file of Apple, checks it with the
// same parser as chalkd, and writes the five CHALK_APNS_* values into the env
// file. `chalkctl push apns clear --yes` empties them. Both restart chalkd,
// because chalkd reads the values at start.
//
// The values go in the env file only. The key is a secret, and the chalkctl
// config file is not.

// apnsEnvKeys are the five env values of the APNs settings, in the order of
// [APNsSettings.values].
var apnsEnvKeys = []string{
	"CHALK_APNS_KEY",
	"CHALK_APNS_KEY_ID",
	"CHALK_APNS_TEAM_ID",
	"CHALK_APNS_TOPIC",
	"CHALK_APNS_ENV",
}

// maxAPNsKeyFile is the largest key file in bytes that set reads. A .p8 file
// of Apple is far smaller.
const maxAPNsKeyFile = 16 << 10

// APNsSettings holds the five CHALK_APNS_* values. Key is the key of Apple
// as one base64 line (the DER of the .p8 file). Environment is "production" or
// "sandbox". If Environment is empty, chalkd uses production. The zero value
// means that no APNs settings exist.
type APNsSettings struct {
	Key         string
	KeyID       string
	TeamID      string
	Topic       string
	Environment string
}

// apnsFromEnv returns the APNs settings that the env map holds.
func apnsFromEnv(env map[string]string) APNsSettings {
	return APNsSettings{
		Key:         env["CHALK_APNS_KEY"],
		KeyID:       env["CHALK_APNS_KEY_ID"],
		TeamID:      env["CHALK_APNS_TEAM_ID"],
		Topic:       env["CHALK_APNS_TOPIC"],
		Environment: env["CHALK_APNS_ENV"],
	}
}

// complete reports whether the key, the key id, the team id, and the topic are
// all set. An empty Environment is allowed.
func (a APNsSettings) complete() bool {
	return a.Key != "" && a.KeyID != "" && a.TeamID != "" && a.Topic != ""
}

// partial reports whether some of the four required values are set and some
// are not. With push on, chalkd does not start in this state.
func (a APNsSettings) partial() bool {
	return !a.complete() && (a.Key != "" || a.KeyID != "" || a.TeamID != "" || a.Topic != "")
}

// values returns the five values in the order of apnsEnvKeys.
func (a APNsSettings) values() []string {
	return []string{a.Key, a.KeyID, a.TeamID, a.Topic, a.Environment}
}

// validate returns an error unless the settings are complete and chalkd
// accepts them. It uses the parsers of package apns, so set and chalkd agree.
func (a APNsSettings) validate() error {
	if !a.complete() {
		return errors.New("the APNs key, key id, team id and topic are all necessary")
	}
	if _, err := apns.ParseKey(a.Key, a.KeyID, a.TeamID); err != nil {
		return err
	}
	if err := apns.ValidateTopic(a.Topic); err != nil {
		return err
	}
	_, err := apns.ParseEnvironment(a.Environment)
	return err
}

// apnsKeyLine returns the key in p8 as one base64 line, so that it fits on one
// line of an env file. If p8 is a PEM file, the line is the base64 of its DER
// body. Otherwise p8 is bare base64, and apnsKeyLine joins its lines.
// apnsKeyLine returns an error if the PEM block does not decode.
func apnsKeyLine(p8 []byte) (string, error) {
	text := strings.TrimSpace(string(p8))
	if strings.Contains(text, "-----BEGIN") {
		block, _ := pem.Decode([]byte(text))
		if block == nil {
			return "", errors.New("the key file is not a PEM file")
		}
		return base64.StdEncoding.EncodeToString(block.Bytes), nil
	}
	return strings.Join(strings.Fields(text), ""), nil
}

// APNsSetOptions are the arguments of [PushAPNsSet]. KeyFile is the path of the
// .p8 file. Sandbox selects the APNs sandbox. If Sandbox is false, the
// environment is production.
type APNsSetOptions struct {
	KeyFile string
	KeyID   string
	TeamID  string
	Topic   string
	Sandbox bool
}

// PushAPNsSet checks the key file and the ids, writes the five CHALK_APNS_*
// values into the env file, and restarts chalkd. It replaces the lines that
// exist and appends the others. It does not change other lines.
// If a check fails, PushAPNsSet changes nothing and does not restart chalkd.
// It never prints the key. If push is off, it says so and names the command
// that turns push on.
func PushAPNsSet(o PushOptions, s APNsSetOptions) error {
	o.defaults()
	info, err := os.Stat(s.KeyFile)
	if err != nil {
		return fmt.Errorf("read the APNs key: %w", err)
	}
	if info.Size() > maxAPNsKeyFile {
		return fmt.Errorf("%s is larger than an APNs key file", s.KeyFile)
	}
	raw, err := os.ReadFile(s.KeyFile)
	if err != nil {
		return fmt.Errorf("read the APNs key: %w", err)
	}
	line, err := apnsKeyLine(raw)
	if err != nil {
		return fmt.Errorf("%s: %w", s.KeyFile, err)
	}
	env := apns.Production
	if s.Sandbox {
		env = apns.Sandbox
	}
	set := APNsSettings{Key: line, KeyID: s.KeyID, TeamID: s.TeamID, Topic: s.Topic, Environment: string(env)}
	if err := set.validate(); err != nil {
		return err
	}
	if err := writeAPNs(o.EnvPath, set); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "  set CHALK_APNS_* in %s (topic=%s environment=%s key id=%s)\n", o.EnvPath, set.Topic, set.Environment, set.KeyID)
	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd (the key loads on boot): %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	if current, err := readEnvSecrets(o.EnvPath); err == nil && current["CHALK_PUSH_ENABLED"] != "true" {
		fmt.Fprintln(o.Out, "push is off on this server; `chalkctl push enable` turns it on.")
	}
	fmt.Fprintln(o.Out, "you can delete the key file now; chalk.env holds the key.")
	return nil
}

// PushAPNsClear empties the five CHALK_APNS_* values and restarts chalkd.
// Native push to every iOS app of this server then stops. If yes is false,
// PushAPNsClear returns an error and changes nothing.
func PushAPNsClear(o PushOptions, yes bool) error {
	o.defaults()
	if !yes {
		return errors.New("clearing the APNs settings stops native push to EVERY iOS app of this server; re-run with --yes if that is what you want")
	}
	if err := writeAPNs(o.EnvPath, APNsSettings{}); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "  cleared CHALK_APNS_* in %s\n", o.EnvPath)
	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd: %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	return nil
}

// writeAPNs writes the five values of set into the env file, one value at a
// time. An empty value leaves an empty line in place.
func writeAPNs(envPath string, set APNsSettings) error {
	for i, v := range set.values() {
		if _, err := setEnvValue(envPath, apnsEnvKeys[i], v); err != nil {
			return fmt.Errorf("write %s: %w", envPath, err)
		}
	}
	return nil
}

// apnsStatus returns the text of the apns line of `chalkctl push status`. It
// shows the topic, the environment, and the key id. It never shows the key.
// If only some of the four required values are set, the text starts with
// INCOMPLETE.
func apnsStatus(env map[string]string) string {
	set := apnsFromEnv(env)
	switch {
	case set.complete():
		e := set.Environment
		if e == "" {
			e = string(apns.Production)
		}
		return fmt.Sprintf("set (topic=%s environment=%s key id=%s)", set.Topic, e, set.KeyID)
	case set.partial():
		return "INCOMPLETE -- chalkd does not start with push on; run `chalkctl push apns set` or `chalkctl push apns clear --yes`"
	}
	return "not set (`chalkctl push apns set` adds it)"
}

// carryAPNs copies a complete set of APNs values from the archived env into the
// live one. The device rows in the restored dump are bound to the topic and
// the environment, and the key comes from Apple, so init cannot make it again.
// An incomplete set is not carried. carryAPNs logs that case.
func carryAPNs(envPath string, old map[string]string, logf func(string, ...any)) error {
	set := apnsFromEnv(old)
	if !set.complete() {
		if set.partial() {
			logf("the archive has incomplete APNs settings; not carried")
		}
		return nil
	}
	if err := writeAPNs(envPath, set); err != nil {
		return err
	}
	logf("carried CHALK_APNS_* from the archive into %s", envPath)
	return nil
}

// keepAPNs returns the complete set of APNs values in the existing env file,
// so that `init --force` writes them again when it renders the file from the
// template. If the set is incomplete, keepAPNs logs a warning and returns the
// zero value, so the values are dropped. If the file is absent, it returns the
// zero value.
func keepAPNs(envPath string, logf func(string, ...any)) APNsSettings {
	existing, err := readEnvSecrets(envPath)
	if err != nil {
		return APNsSettings{}
	}
	set := apnsFromEnv(existing)
	switch {
	case set.complete():
		logf("keeping CHALK_APNS_* (the APNs key comes from Apple and cannot be generated again)")
		return set
	case set.partial():
		logf("WARNING: incomplete CHALK_APNS_* in the old env file are dropped; run `chalkctl push apns set` again")
	}
	return APNsSettings{}
}

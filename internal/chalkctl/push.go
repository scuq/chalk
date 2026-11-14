package chalkctl

import (
	"fmt"
	"io"
	"os"
)

// 65-3: the operator commands for Web Push.
//
// `chalkctl push status` shows the switch, the subject, and the public key.
// `enable` and `disable` change CHALK_PUSH_ENABLED and restart chalkd.
// `rotate-key --yes` replaces the VAPID key pair and restarts chalkd.
// Every subscription is bound to the old public key. After a rotation, no
// device gets a push until it opens chalk and subscribes again.

// PushOptions holds the files to edit and how to restart chalkd.
type PushOptions struct {
	EnvPath    string
	ConfigPath string
	Out        io.Writer
	// Restart restarts chalkd after a change. If it is nil, PushOptions uses
	// systemctl.
	Restart func() error
}

func (o *PushOptions) defaults() {
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

// PushStatus prints the push switch, the subject and the public key.
func PushStatus(o PushOptions) error {
	o.defaults()
	env, err := readEnvSecrets(o.EnvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", o.EnvPath, err)
	}
	if _, _, err := vapidPair(env, o.EnvPath); err != nil {
		return err
	}
	enabled := env["CHALK_PUSH_ENABLED"]
	if enabled == "" {
		enabled = "false (unset)"
	}
	pub := env["CHALK_VAPID_PUBLIC_KEY"]
	if pub == "" {
		pub = "none -- run `chalkctl update` to generate a pair"
	}
	fmt.Fprintf(o.Out, "push enabled: %s\n", enabled)
	fmt.Fprintf(o.Out, "subject:      %s\n", env["CHALK_VAPID_SUBJECT"])
	fmt.Fprintf(o.Out, "public key:   %s\n", pub)
	return nil
}

// PushEnable turns Web Push on. If the env file has no key pair or no subject,
// it returns an error, because chalkd would not start.
func PushEnable(o PushOptions) error {
	o.defaults()
	env, err := readEnvSecrets(o.EnvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", o.EnvPath, err)
	}
	priv, _, err := vapidPair(env, o.EnvPath)
	if err != nil {
		return err
	}
	if priv == "" || env["CHALK_VAPID_SUBJECT"] == "" {
		return fmt.Errorf("%s has no web push key pair or subject; run `chalkctl update` first", o.EnvPath)
	}
	if err := setPush(o, "true"); err != nil {
		return err
	}
	fmt.Fprintln(o.Out, "web push is on. Each user turns it on per device in the notification settings.")
	return nil
}

// PushDisable turns Web Push off. Subscriptions stay stored. Pushes start
// again after `chalkctl push enable`.
func PushDisable(o PushOptions) error {
	o.defaults()
	if err := setPush(o, "false"); err != nil {
		return err
	}
	fmt.Fprintln(o.Out, "web push is off.")
	return nil
}

// setPush writes CHALK_PUSH_ENABLED to the env file, writes PUSH_ENABLED to
// the config file if it exists, and restarts chalkd.
func setPush(o PushOptions, value string) error {
	if _, err := setEnvValue(o.EnvPath, "CHALK_PUSH_ENABLED", value); err != nil {
		return fmt.Errorf("write %s: %w", o.EnvPath, err)
	}
	fmt.Fprintf(o.Out, "  set CHALK_PUSH_ENABLED=%s in %s\n", value, o.EnvPath)
	// Write the chalkctl config file also. Then a later `init --force` renders
	// the same choice.
	if _, err := os.Stat(o.ConfigPath); err == nil {
		if _, err := setEnvValue(o.ConfigPath, "PUSH_ENABLED", value); err != nil {
			return fmt.Errorf("write %s: %w", o.ConfigPath, err)
		}
		fmt.Fprintf(o.Out, "  set PUSH_ENABLED=%s in %s\n", value, o.ConfigPath)
	}
	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd (the env flag loads on boot): %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	return nil
}

// PushRotateKey replaces the VAPID key pair and restarts chalkd. If yes is
// false, it returns an error, because no device gets a push again until it
// opens chalk. Rotate the key if a copy of the env file is lost. The private
// key lets its holder send notifications that look like they come from this
// server.
func PushRotateKey(o PushOptions, yes bool) error {
	o.defaults()
	if !yes {
		return fmt.Errorf("rotating the web push key stops pushes to EVERY device until it opens chalk again; re-run with --yes if that is what you want")
	}
	priv, pub, err := genVAPIDKey()
	if err != nil {
		return err
	}
	for _, kv := range [][2]string{{"CHALK_VAPID_PUBLIC_KEY", pub}, {"CHALK_VAPID_PRIVATE_KEY", priv}} {
		if _, err := setEnvValue(o.EnvPath, kv[0], kv[1]); err != nil {
			return fmt.Errorf("write %s: %w", o.EnvPath, err)
		}
	}
	fmt.Fprintf(o.Out, "  rotated CHALK_VAPID_* in %s\n", o.EnvPath)
	fmt.Fprintf(o.Out, "  new public key: %s\n", pub)
	if err := o.Restart(); err != nil {
		return fmt.Errorf("restart chalkd (the key loads on boot): %w", err)
	}
	fmt.Fprintln(o.Out, "  restarted chalkd")
	fmt.Fprintln(o.Out, "each device subscribes again with the new key the next time it opens chalk.")
	return nil
}

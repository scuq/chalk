package chalkctl

import (
	"crypto/ed25519"
	"fmt"
	"io"

	"github.com/scuq/chalk/internal/innerchan"
)

// 83-6: the operator surface for the server identity key.
//
// `chalkctl serverkey show` prints the fingerprint of CHALK_SERVER_ID_KEY --
// what every client compares against at connect. This is the whole re-pin
// flow: a rotation is `chalkctl serverkey rotate`, which writes a fresh key
// and prints the new fingerprint; every client then stops at its pin wall,
// which shows the fingerprint it sees, and the operator announces the new
// one out of band so users can compare and choose "trust the new key".
// Nothing re-pins silently -- a server that changes its key without the
// operator telling anyone is exactly what the pin exists to catch.

// ServerKeyOptions locates the env file.
type ServerKeyOptions struct {
	EnvPath string
	Out     io.Writer
}

// ServerKeyShow prints the fingerprint of the configured server identity.
func ServerKeyShow(o ServerKeyOptions) error {
	env, err := readEnvSecrets(o.EnvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", o.EnvPath, err)
	}
	b64 := env["CHALK_SERVER_ID_KEY"]
	if b64 == "" {
		fmt.Fprintf(o.Out, "no CHALK_SERVER_ID_KEY in %s -- run `chalkctl update` to provision one\n", o.EnvPath)
		return nil
	}
	priv, err := innerchan.ParseServerKey(b64)
	if err != nil {
		return fmt.Errorf("CHALK_SERVER_ID_KEY in %s: %w", o.EnvPath, err)
	}
	fmt.Fprintf(o.Out, "server identity fingerprint: %s\n", innerchan.Fingerprint(priv.Public().(ed25519.PublicKey)))
	fmt.Fprintf(o.Out, "(what users see on the pin screen; compare before they choose \"trust this key\")\n")
	return nil
}

// ServerKeyRotate replaces CHALK_SERVER_ID_KEY with a fresh key. This WALLS
// every client until its user re-pins, so it refuses without --yes and
// always prints the new fingerprint to announce. Restarting chalkd is the
// operator's next step (same as any env change).
func ServerKeyRotate(o ServerKeyOptions, yes bool) error {
	if !yes {
		return fmt.Errorf("rotating the server identity walls EVERY client until its user re-pins from the new fingerprint; re-run with --yes if that is what you want")
	}
	key, err := genServerIDKey()
	if err != nil {
		return err
	}
	changed, err := setEnvValue(o.EnvPath, "CHALK_SERVER_ID_KEY", key)
	if err != nil {
		return err
	}
	if !changed {
		if _, err := appendEnvVar(o.EnvPath, "CHALK_SERVER_ID_KEY", key, "phase 83 server identity (rotated)", o.Out); err != nil {
			return err
		}
	}
	priv, _ := innerchan.ParseServerKey(key)
	fmt.Fprintf(o.Out, "rotated CHALK_SERVER_ID_KEY in %s\n", o.EnvPath)
	fmt.Fprintf(o.Out, "new server identity fingerprint: %s\n", innerchan.Fingerprint(priv.Public().(ed25519.PublicKey)))
	fmt.Fprintf(o.Out, "announce it to users, then restart chalkd; each client re-pins from its wall screen after comparing\n")
	return nil
}

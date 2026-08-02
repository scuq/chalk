package chalkctl

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// MinBackupPasswordLen is the floor for a NEW backup password. Lower than the
// account password rule (20 chars, 4 classes) on purpose: this one is typed by
// the operator at a console, often twice, and the archive it protects is at
// rest on hosts they control. Restore imposes no floor -- an old archive must
// stay openable whatever it was sealed with.
const MinBackupPasswordLen = 12

// BackupPasswordEnv is the non-interactive way to supply the password (for the
// --password-file alternative see ResolveBackupPassword).
const BackupPasswordEnv = "CHALK_BACKUP_PASSWORD"

// ResolveBackupPassword finds the archive password, in order: the file at
// passwordFile, then $CHALK_BACKUP_PASSWORD, then an interactive prompt. When
// confirm is set (taking a backup, where a typo is only discovered on the day
// it matters) the prompt asks twice and enforces MinBackupPasswordLen.
func ResolveBackupPassword(passwordFile string, confirm bool) (string, error) {
	if passwordFile != "" {
		b, err := os.ReadFile(passwordFile)
		if err != nil {
			return "", fmt.Errorf("read password file: %w", err)
		}
		// Only the trailing newline is stripped: a password may legitimately
		// begin or end with a space.
		pw := strings.TrimRight(string(b), "\r\n")
		if pw == "" {
			return "", fmt.Errorf("password file %s is empty", passwordFile)
		}
		return pw, nil
	}
	if pw := os.Getenv(BackupPasswordEnv); pw != "" {
		return pw, nil
	}

	pw, err := promptPassword("backup password: ")
	if err != nil {
		return "", err
	}
	if !confirm {
		if pw == "" {
			return "", fmt.Errorf("no password given")
		}
		return pw, nil
	}
	if len(pw) < MinBackupPasswordLen {
		return "", fmt.Errorf("backup password must be at least %d characters", MinBackupPasswordLen)
	}
	again, err := promptPassword("repeat password: ")
	if err != nil {
		return "", err
	}
	if again != pw {
		return "", fmt.Errorf("passwords do not match")
	}
	return pw, nil
}

// promptPassword reads one line from stdin with terminal echo off. Echo is
// suppressed via stty rather than a terminal library: it is the one thing
// needed from one, and chalkctl is not worth a dependency for it. If stty
// fails (no tty, e.g. a piped stdin) the read still happens -- with a warning,
// because the operator must know the password will be visible.
func promptPassword(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	restore, err := disableEcho()
	if err != nil {
		fmt.Fprint(os.Stderr, "\n  (no terminal: the password will be echoed)\n"+prompt)
	}
	sc := bufio.NewScanner(os.Stdin)
	ok := sc.Scan()
	restore()
	fmt.Fprintln(os.Stderr)
	if !ok {
		if err := sc.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("no password given")
	}
	return sc.Text(), nil
}

func disableEcho() (func(), error) {
	off := exec.Command("stty", "-echo")
	off.Stdin = os.Stdin
	if err := off.Run(); err != nil {
		return func() {}, err
	}
	return func() {
		on := exec.Command("stty", "echo")
		on.Stdin = os.Stdin
		_ = on.Run()
	}, nil
}

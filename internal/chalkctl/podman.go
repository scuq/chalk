package chalkctl

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Podman wraps the rootful podman + systemctl calls init needs. Kept small
// and shell-based (podman/systemctl are the stable interface); a future k8s
// driver would implement the same conceptual steps differently.
type Podman struct {
	Bin string // "podman"
}

func NewPodman() *Podman { return &Podman{Bin: "podman"} }

func (p *Podman) bin() string {
	if p.Bin == "" {
		return "podman"
	}
	return p.Bin
}

// run executes a podman subcommand, returning trimmed stdout or an error with
// stderr attached.
func (p *Podman) run(args ...string) (string, error) {
	cmd := exec.Command(p.bin(), args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("podman %s: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// Pull fetches an image reference.
func (p *Podman) Pull(ref string) error {
	_, err := p.run("pull", ref)
	return err
}

// ResolveDigest returns the sha256:... manifest digest for a pulled image
// reference. Uses `podman image inspect` .Digest. Pull first.
func (p *Podman) ResolveDigest(ref string) (string, error) {
	out, err := p.run("image", "inspect", ref, "--format", "{{.Digest}}")
	if err != nil {
		return "", err
	}
	d := strings.TrimSpace(out)
	if !strings.HasPrefix(d, "sha256:") {
		// Fall back to parsing RepoDigests if .Digest was empty.
		alt, aerr := p.repoDigest(ref)
		if aerr == nil && alt != "" {
			return alt, nil
		}
		return "", fmt.Errorf("could not resolve a sha256 digest for %s (got %q)", ref, d)
	}
	return d, nil
}

// repoDigest pulls the digest out of RepoDigests as a fallback.
func (p *Podman) repoDigest(ref string) (string, error) {
	out, err := p.run("image", "inspect", ref, "--format", "{{json .RepoDigests}}")
	if err != nil {
		return "", err
	}
	var digests []string
	if err := json.Unmarshal([]byte(out), &digests); err != nil {
		return "", err
	}
	for _, d := range digests {
		if i := strings.Index(d, "@sha256:"); i >= 0 {
			return d[i+1:], nil
		}
	}
	return "", fmt.Errorf("no sha256 in RepoDigests for %s", ref)
}

// Systemctl runs a systemctl command (rootful: system scope).
func Systemctl(args ...string) (string, error) {
	cmd := exec.Command("systemctl", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("systemctl %s: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// RequireRoot fails unless running as uid 0 (rootful base).
func RequireRoot() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("must run as root (rootful podman base binds 80/443/3478)")
	}
	return nil
}

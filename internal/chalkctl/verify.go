package chalkctl

import (
	"fmt"
	"os/exec"
	"strings"
)

// Verifier checks that an image reference is a genuine, signed release. The
// seam keeps init/update agnostic to HOW verification happens.
type Verifier interface {
	// Verify confirms the image (by tag or digest) carries a valid cosign
	// signature from the expected workflow identity. Returns nil on success.
	Verify(imageRef string) error
	// Describe is a short human label for logs.
	Describe() string
}

// CosignVerifier shells out to the system `cosign` binary (Ubuntu packages it
// in universe). This is the permanent implementation -- the project chose
// shell-cosign over the heavy in-process sigstore dependency tree. The
// identity is pinned to the release-chalk workflow, any tag.
type CosignVerifier struct {
	// Repo is "owner/name" (e.g. "scuq/chalk"), used to build the identity
	// regexp that pins the signing workflow.
	Repo string
	// Bin is the cosign executable name/path ("cosign" by default).
	Bin string
}

// NewCosignVerifier builds a verifier for the given owner/name repo.
func NewCosignVerifier(repo string) *CosignVerifier {
	return &CosignVerifier{Repo: repo, Bin: "cosign"}
}

func (c *CosignVerifier) Describe() string { return "cosign (system binary)" }

// identityRegexp pins the cert subject to the release-chalk workflow file for
// this repo, across any tag: matches
//
//	https://github.com/<repo>/.github/workflows/release-chalk.yml@refs/tags/<anything>
func (c *CosignVerifier) identityRegexp() string {
	// Escape dots so the regexp is tight, not a wildcard match.
	repo := strings.ReplaceAll(c.Repo, ".", `\.`)
	return `^https://github\.com/` + repo + `/\.github/workflows/release-chalk\.yml@refs/tags/`
}

// Verify runs `cosign verify` with keyless GitHub-OIDC parameters.
func (c *CosignVerifier) Verify(imageRef string) error {
	bin := c.Bin
	if bin == "" {
		bin = "cosign"
	}
	if _, err := exec.LookPath(bin); err != nil {
		return fmt.Errorf("cosign not found on PATH: install it (apt install cosign) or pass --skip-verify: %w", err)
	}
	cmd := exec.Command(bin, "verify", imageRef,
		"--certificate-identity-regexp", c.identityRegexp(),
		"--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cosign verify failed for %s: %w\n%s", imageRef, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// NoopVerifier is selected by --skip-verify. It verifies nothing and says so;
// intended for air-gapped/offline installs where the operator accepts the
// risk. Every skip is loud.
type NoopVerifier struct{}

func (NoopVerifier) Describe() string { return "SKIPPED (--skip-verify)" }
func (NoopVerifier) Verify(string) error {
	return nil
}

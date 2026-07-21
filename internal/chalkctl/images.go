package chalkctl

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// ImagesOptions configures the images command.
type ImagesOptions struct {
	Cfg    Config
	Podman *Podman
	Out    io.Writer
}

// stackImage names an image in the running stack and the podman reference used
// to inspect it. The chalk app is pinned by the config's image; the sidecars
// are the tags init rendered into their units.
type stackImage struct {
	role string // "chalk", "postgres", "coturn"
	ref  string
}

// imageInfo is the provenance we surface per image.
type imageInfo struct {
	Role     string
	Ref      string
	Digest   string
	Created  string
	Version  string
	Revision string
	Err      string
}

// Images inspects every image in the stack (chalk app + postgres + coturn) and
// prints version / revision / created provenance for each. Read-only. The
// point is to answer "what exactly is deployed?" at a glance -- the gap that
// made a stale image indistinguishable from a fresh one.
func Images(o ImagesOptions) error {
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	imgs := []stackImage{
		{"chalk", o.Cfg.Image + ":" + firstNonEmpty(o.Cfg.Channel, "stable")},
		{"postgres", "docker.io/library/postgres:" + o.Cfg.PostgresTag},
		{"coturn", "docker.io/coturn/coturn:4"},
	}
	// Prefer the pinned chalk digest from state if present -- that's what's
	// actually running, not whatever :stable resolves to now.
	if st, ok, _ := LoadState(DefaultStatePath); ok && st.CurrentDigest != "" {
		imgs[0].ref = o.Cfg.Image + "@" + st.CurrentDigest
	}

	infos := make([]imageInfo, 0, len(imgs))
	for _, im := range imgs {
		infos = append(infos, o.inspect(im))
	}

	for _, in := range infos {
		fmt.Fprintf(o.Out, "%s\n", in.Role)
		if in.Err != "" {
			fmt.Fprintf(o.Out, "  (not available: %s)\n", in.Err)
			continue
		}
		fmt.Fprintf(o.Out, "  ref:      %s\n", in.Ref)
		fmt.Fprintf(o.Out, "  digest:   %s\n", in.Digest)
		if in.Version != "" {
			fmt.Fprintf(o.Out, "  version:  %s\n", in.Version)
		}
		if in.Revision != "" {
			fmt.Fprintf(o.Out, "  revision: %s\n", in.Revision)
		}
		if in.Created != "" {
			fmt.Fprintf(o.Out, "  created:  %s\n", in.Created)
		}
	}
	return nil
}

// inspect reads digest + creation + OCI provenance labels for one image.
func (o ImagesOptions) inspect(im stackImage) imageInfo {
	info := imageInfo{Role: im.role, Ref: im.ref}
	// One inspect call returns everything as JSON; parse the fields we want.
	out, err := o.Podman.run("image", "inspect", im.ref, "--format", "{{json .}}")
	if err != nil {
		info.Err = firstLine(err.Error())
		return info
	}
	var raw struct {
		Digest  string            `json:"Digest"`
		Created string            `json:"Created"`
		Labels  map[string]string `json:"Labels"`
		Config  struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if jerr := json.Unmarshal([]byte(out), &raw); jerr != nil {
		info.Err = "inspect parse: " + firstLine(jerr.Error())
		return info
	}
	info.Digest = raw.Digest
	info.Created = raw.Created
	labels := raw.Config.Labels
	if len(labels) == 0 {
		labels = raw.Labels
	}
	info.Version = labels["org.opencontainers.image.version"]
	info.Revision = labels["org.opencontainers.image.revision"]
	if c := labels["org.opencontainers.image.created"]; c != "" {
		info.Created = c // prefer the label (build time) over pull time
	}
	return info
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// Package chalkctl implements the chalk deployment manager's core: config,
// state, embedded deploy templates, image-signature verification, and the
// podman bring-up used by `chalkctl init`. Command wiring lives in
// cmd/chalkctl; this package holds the reusable machinery.
package chalkctl

import "embed"

// Templates holds the deploy files (Quadlet units, Caddyfile, env, timer)
// baked into the binary, so `init` writes a complete stack with no external
// files to fetch. Rendered via text/template against InitParams.
//
//go:embed templates/*.tmpl
var Templates embed.FS

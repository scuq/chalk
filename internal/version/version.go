// Package version exposes build-time identification.
package version

// These are populated via -ldflags at build time. See Makefile.
var (
	// Name of the project.
	Name = "chalk"
	// Binary name shipped to users.
	Binary = "chalkd"
	// Version is the semver release; "0.0.0-dev" for unreleased builds.
	Version = "0.0.0-dev"
	// Commit is the short git SHA, optionally with "-dirty" suffix.
	Commit = "unknown"
	// BuildDate is RFC3339 UTC timestamp of the build.
	BuildDate = "unknown"
)

// String returns a single-line version banner.
func String() string {
	return Binary + " " + Version + " (" + Commit + ", built " + BuildDate + ")"
}

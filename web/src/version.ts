// 39-1: how the running build is named in the UI, and where "what changed?"
// goes.
//
// The version reaches the client on the welcome frame (the server and this
// bundle ship in one image, so the server's build IS the app's build). Two
// shapes arrive:
//
//   * a release tag, verbatim from CI: "v0.3.27"
//   * an unreleased build: "0.0.0-dev" (the Makefile default)
//
// Releases link at their own tag rather than at main, so the changelog you
// open is the one describing the build you're actually running.

const REPO = "https://github.com/scuq/chalk";

/** True for a build cut from a release tag, false for dev/unknown builds. */
export function isReleaseBuild(version: string | null | undefined): boolean {
  return releaseTag(version) !== null;
}

/**
 * The git tag for a release build, or null if this isn't one.
 * Accepts the tag with or without its leading "v"; returns it with.
 */
function releaseTag(version: string | null | undefined): string | null {
  const v = (version ?? "").trim();
  if (!v) return null;
  const bare = v.startsWith("v") ? v.slice(1) : v;
  // Plain X.Y.Z only. Pre-release and dev suffixes ("0.0.0-dev") have no tag
  // to point at, so they fall back to main.
  return /^\d+\.\d+\.\d+$/.test(bare) ? `v${bare}` : null;
}

/** Short label for the badge: "v0.3.27", or "dev" for anything untagged. */
export function versionLabel(version: string | null | undefined): string {
  return releaseTag(version) ?? "dev";
}

/** The changelog for THIS build: pinned at its tag, or main when untagged. */
export function changelogURL(version: string | null | undefined): string {
  return `${REPO}/blob/${releaseTag(version) ?? "main"}/CHANGELOG.md`;
}

/**
 * 46-2: identity of a running build, for "did the server change under us?".
 *
 * The commit is part of the key because a dev build's version never moves
 * ("0.0.0-dev") while its commit does. Returns "" when the server reports
 * neither, which means "cannot tell" -- callers must read that as "no
 * change", never as an update.
 *
 * Two builds off the same dirty tree share a commit and so compare equal.
 * That is a real blind spot, and the honest one: there is nothing on the
 * wire that distinguishes them.
 */
export function buildKey(
  version: string | null | undefined,
  commit: string | null | undefined,
): string {
  const v = (version ?? "").trim();
  const c = (commit ?? "").trim();
  if (!v && !c) return "";
  return `${v}@${c}`;
}

/** Hover text: the full build stamp, commit included when we have one. */
export function versionTitle(
  version: string | null | undefined,
  commit: string | null | undefined,
): string {
  const v = (version ?? "").trim() || "unknown version";
  const c = (commit ?? "").trim();
  const build = c && c !== "unknown" ? `${v} (${c})` : v;
  return `chalk ${build} -- open the changelog`;
}

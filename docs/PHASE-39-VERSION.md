# Phase 39 — the version badge (and two themes)

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.28 / v0.3.29. Extended by 46 (reload pill) and 70-1
(version footer in settings, reachable on mobile).
**Tag:** `#version` → `tools/where.sh -g version`

## Why

Self-hosted software with no visible version number makes every bug report
start with three rounds of "which build are you on". chalk stamps its version
from the git tag through ldflags at build time — nothing in the repo carries a
version number — so the client needs the server to tell it, and it needs to be
able to link the running build to its own changelog entry.

## What landed

- **39-1** — version badge in the header and in the profile panel, linking the
  build's changelog section. Development builds read `dev` and link to the
  latest changelog instead.
- **39-2** — blade-runner theme (neon scarlet on smoke-black).
- **39-3** — warmwhite and azeroth themes.

## Where it lives

`internal/version/`, `internal/proto/proto.go` (version on the welcome frame),
`web/src/version.ts`, `web/src/components/VersionLink.tsx`,
`web/src/theme.css` for the themes.

## Notes

The version travels on the welcome payload, which is what 46 later builds on:
comparing the welcome's version against the one the tab booted with is how the
"new version · reload" pill knows the server changed underneath it.

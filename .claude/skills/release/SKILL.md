---
name: release
description: Cut a chalk release — rename the CHANGELOG `## Unreleased` block to a version heading, update the release pointer in docs/open-items.md, and print the git add / commit / push / tag commands for scuq to run. Use when asked to release, cut a version, or tag vX.Y.Z.
---

Cutting a release in chalk is a documentation change plus a tag. There is no
version number in the source: `Makefile` `VERSION` is stamped from the git tag
through ldflags in `.github/workflows/release.yml`, which builds the multi-arch
image and the `chalkctl` binaries on any `v*` tag. So the tag *is* the release,
and everything below it exists to make the tag mean something.

**Never run git yourself.** Per the working agreements, propose the commands;
scuq runs them. That applies to `git add`, `commit`, `tag` and both pushes.

## Steps

1. **Confirm there is something to release.** Read the `## Unreleased` block in
   `CHANGELOG.md`. If it is empty or missing, stop and say so — an empty
   release is a tag with no story.

2. **Pick the version.** Take it from what is in the block, unless scuq named
   one:
   - `### Fixed` only → patch bump (0.7.1 → 0.7.2)
   - any `### Added` or `### Changed` → minor bump (0.7.1 → 0.8.0)

   Check `git tag --list 'v*' | tail -5` for what is already taken; the topmost
   `## vX.Y.Z` heading in `CHANGELOG.md` is the source of truth for what came
   last.

3. **Rename the heading.** `## Unreleased` becomes
   `## vX.Y.Z — <D Month YYYY> — <theme>`, e.g.
   `## v0.7.1 — 4 August 2026 — Verification backup and server logs`. Day of
   the month is unpadded; theme is a short sentence fragment in sentence case
   naming what the release is about, drawn from the bullets — not a slice
   number, not a file name. Do not add a fresh empty `## Unreleased` block;
   the next change set creates one.

   Same-day releases are grouped by theme rather than listed one patch at a
   time (the changelog header says so) — if the topmost heading already carries
   today's date and covers the same ground, ask scuq whether to fold the new
   bullets into it instead of cutting another version.

4. **Move the pointer.** Update `Latest release: **vX.Y.Z**` at the top of
   `docs/open-items.md`, in the same change set. A stale pointer is worse than
   none, because it still reads as current.

5. **Run the verify chain** from CLAUDE.md — `go build ./... && go vet ./...`,
   `go test ./...`, `gofmt -l .`, and from `web/`: `npx tsc --noEmit`,
   `node test.mjs`, `node build.mjs`. A tag triggers a release build; do not
   propose one over a red tree.

6. **Print the commands** in one block, ready to paste:

   ```bash
   git add CHANGELOG.md docs/open-items.md
   git commit -m "release vX.Y.Z: <theme, lowercased>"
   git push
   git tag -a vX.Y.Z -m "vX.Y.Z — <theme>"
   git push origin vX.Y.Z
   ```

   Tags are annotated (`-a`), never lightweight — `git cat-file -t v0.7.1`
   confirms the existing ones are. The commit message is the one exception to
   the `phase <N>-<slice>: ...` convention: releases use
   `release vX.Y.Z: <theme>`. Add any other files the release touched to the
   `git add` list — nothing else normally changes, but a phase doc or
   `docs/tags.md` edit landing in the same set belongs there too.

7. **Say what happens next**: pushing the tag starts the GitHub Actions release
   workflow, which builds the cosign-signed multi-arch image and the `chalkctl`
   binaries. Deployed servers pick it up on their weekly update timer or a
   manual `chalkctl update`.

8. **If no run appears within a minute**, GitHub dropped the tag-push event —
   it did for v0.7.5, with the ref on the remote and the workflow active and
   unchanged. Check with `gh run list --workflow=release --limit 3`, then start
   it by hand **at the tag**:

   ```bash
   gh workflow run release.yml --ref vX.Y.Z
   ```

   Never `--ref main`. cosign's keyless certificate records the ref the run
   started from, and `chalkctl`'s verifier pins that to `@refs/tags/`
   (`internal/chalkctl/verify.go`), so a run started from a branch signs an
   image every deployed server refuses to install. The workflow fails such a
   run before it publishes anything, but the rule is worth knowing rather than
   discovering.

   Tags cut before this trigger existed (v0.7.5 and earlier) cannot be
   dispatched — GitHub reads the workflow file from the ref you run it at, and
   theirs has no `workflow_dispatch`. For those, delete and re-push the tag:
   `git push origin :refs/tags/vX.Y.Z && git push origin vX.Y.Z`.

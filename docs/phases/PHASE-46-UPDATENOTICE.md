# Phase 46 — telling open tabs the server was updated

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.47.
**Tag:** `#servernotice` → `tools/where.sh -g servernotice`

## Why

A tab left open across a deployment keeps running the bundle it booted with.
That is how one person ends up with a feature nobody else has, or with a client
speaking a wire protocol the server has moved past — and the symptom is a
mysterious bug report, not an error.

Two separate signals, deliberately kept apart:

- **Version changed** → an actionable "new version · reload" pill next to the
  connection status. Dismissible, because interrupting someone mid-sentence to
  demand a reload is worse than the staleness. It returns on the *next* version
  change, and stays away when the server restarts without changing version.
- **Server going down** → an advance notice on shutdown, so the disconnect that
  follows reads "server restarting" instead of a bare error code.

The version comparison uses the welcome frame's version (phase 39) against the
one the tab booted with, so it needs no polling endpoint.

## What landed

- **46-1 … 46-3** — shutdown notice frame, the reload pill with dismiss and
  re-arm semantics, and the restart-labelled disconnect state.

## Where it lives

`web/src/proto.ts`, `web/src/state/reducer.ts` (and `reducer-update.test.ts`),
`web/src/components/StatusBar.tsx`, `web/src/version.ts`.

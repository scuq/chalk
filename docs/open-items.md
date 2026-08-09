# Open items

What is **not** done. Shipped history lives in [phase-log.md](phase-log.md)
(engineering) and [../CHANGELOG.md](../CHANGELOG.md) (user-facing); this file
is the authority on what is still open, and `CLAUDE.md` points here rather than
carrying it.

Latest release: **v0.7.10** — keep this in step with the topmost `## vX.Y.Z`
heading in `CHANGELOG.md`. The `/release` skill updates it as part of cutting a
release. A stale pointer is worse than none, because it still reads as current.

Phase 94 is the newest work. The phase-doc index at the top of
[phase-log.md](phase-log.md) is the complete list of what exists and which
phases are *planned, not started*.

## Phase 82 — signed channel-key wraps: COMPLETE, but conditionally

82-1 … 82-10, record in [phases/PHASE-82-SIGNEDWRAP.md](phases/PHASE-82-SIGNEDWRAP.md).

It closes the phase-81 audit's C-01 **only where `CHALK_WRAP_SIG_REQUIRED` is
on**. Since 82-10 it defaults to true, so new deployments are covered — but
`chalkctl update` preserves an existing `false`, so a deployment predating phase
82 keeps its migration window until its operator runs `chalkctl wrapsig enable`
(after `chalkctl wrapsig status` says READY). Until then a server can still
substitute a key on a channel no current-build member has opened. **Never
describe C-01 as fixed unconditionally.**

Two follow-ups remain open:

- The **end-to-end run against a live stack** (checklist at the end of the phase
  doc) — the only exercise of the real Postgres upsert guard, and worth doing
  before a release carries this.
- The guest path: links minted before 82-7 stay unsigned until they expire.

## Phase 83 — the open security gap

Confirmed by the phase-81 audit and reconfirmed by its 2026-08-05 follow-up. The
design is **envelope fanout**, chosen 2026-08-08 after five review rounds; the
whole plan lives in [phases/PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md)
(**planned, not started**; the retired transcript design and option B are
recorded in its decision section and preserved in git history), and
[threat-model.md](threat-model.md) states both halves as unmet guarantees.

- **Messages carry no sender signature.** The AEAD associated data is only
  suite/channel/key-version, so sender, message ID and timestamp are
  unauthenticated server-supplied metadata, and any key holder can be
  impersonated. Fanout's answer: no group key at all — every message wraps its
  own key once per member over pairwise-derived secrets, with a per-recipient
  MAC binding sender, channel and body ("authenticated for you"; deliberately
  deniable), covering edits and reactions alike.
- **Membership is server-asserted**, so a server that adds a principal it
  controls gets the key handed to it by a member's auto-reshare. 82-8 makes that
  visible (the join notice) but cannot prevent it. Fanout's answer: a signed
  per-channel authority anchor, a small policy chain, and per-target membership
  certificate chains — enforced at both flap emission and message acceptance.

Both build on the identity anchor phase 82 already paid for; the certificate
layer should copy `web/src/voice/signal-crypto.ts`, which already does
canonical-encode → Ed25519 sign → fail-closed verify correctly. **Gate 0
is re-opened.** It passed at the sixth revision (the eighth review,
[audits/security-phase-83-eighth-review-2026-08-08.md](audits/security-phase-83-eighth-review-2026-08-08.md)),
but the external fifth independent review
([audits/security-phase-83-option-a-fifth-review-2026-08-09.md](audits/security-phase-83-option-a-fifth-review-2026-08-09.md),
2026-08-09) found five blockers at that state: the fork era door
under-specified and over-powered, the shed sender unable to form a valid
envelope, Gate F's expired-row premise contradicting the runtime's
reclaim behavior, the message canonical absent from the plan, and the
backup's scalar `rev` non-convergent across two devices. The seventh
revision answers all five — the era door is **removed** (recreation is
the sole fork exit; a successor-anchor protocol would be its own phase),
the canonical is frozen in the plan itself, `acked_era` became a
self-fencing lease, the shed sender pauses loudly, and the backup merge
is field-wise. A second external review of that seventh revision
([audits/security-phase-83-r11-review-2026-08-09.md](audits/security-phase-83-r11-review-2026-08-09.md))
confirmed the cryptographic core but found two more blockers in the
membership state machine — the acceptance predicate's manifest arm let a
*removed founding member* keep passing, and nothing bound an admission's
fingerprint to the runtime identity actually used — both frozen in the
eighth revision as one `member_state` predicate plus the
`authorized_fp`/`identity-mismatch` binding. The R12 delta review
([audits/security-phase-83-r12-review-2026-08-09.md](audits/security-phase-83-r12-review-2026-08-09.md))
verified those closed and caught two blockers in the eighth revision's
own replacement text — the fingerprint resolver ignored the
non-retroactive temporal model (historical certificates would fail after
an identity rotation) and owner replacement was impossible by
construction — both frozen in the ninth revision: a state-relative
`authorized_fp_current`/`authorized_fp_at` split with a
fingerprint-keyed historical identity fetch, and owner identity
replacement declared unsupported this phase (recreate the channel).
**No slice lands until an independent re-review of the accumulated
delta closes the gate again.**

## Phase 85 — operational logging

Shipped (85-1 … 85-4, record in [phases/PHASE-85-OPLOG.md](phases/PHASE-85-OPLOG.md)),
with two items left at the end of that record: the live-stack run of the
connection snapshot, and the missing off switch for Caddy's access log.

## Phase 93-3 — the resizable thread pane: designed, not started

The thread pane's edge as a drag handle, width stored per device in
`display-prefs.ts`, design at the end of the slice section in
[phases/PHASE-93-WIDTH.md](phases/PHASE-93-WIDTH.md). It copies 33-4's
interaction but deliberately not its storage, and the design records a live
hazard it must fix on the way in: a second `useDisplayPrefs` mount in one tab
clobbers the first instance's fields, because `update()` merges onto its own
`prev` and persists the whole object. Read the design before building it; three
questions in it are scuq's to answer.

## Next candidates, none started

Each is fully planned in its own doc; read it before designing anything in the
same space.

- **Web push notifications** (65, [phases/PHASE-65-PUSH.md](phases/PHASE-65-PUSH.md)):
  hand-rolled `internal/webpush`, DMs-only default, content-free payloads.
- **Ties** (86, [phases/PHASE-86-TIES.md](phases/PHASE-86-TIES.md)): say "this
  answers that" across an interleaved channel without quoting — a sealed
  per-user side record on the reactions pattern, drawn as a gutter mark plus a
  hover connector. Still open, but read its 9 August 2026 note first: phase 99
  shipped quoting, so the document's framing as *the alternative to* quoting is
  out of date. What a tie does that a quote cannot — point at a message too far
  back to reprint — is unchanged, and is the reason it is still on this list.
- **Message reminders** (87, [phases/PHASE-87-REMINDERS.md](phases/PHASE-87-REMINDERS.md)):
  bring one message back later — 1h/24h/weekend/custom from the row menu, a
  badged Reminders entry above the parking lot, the whole set in a sealed prefs
  blob so the server never learns a reminder exists, and no server code at all.
- **A local idle agent** (90, [phases/PHASE-90-IDLEEXT.md](phases/PHASE-90-IDLEEXT.md)).
- **Large rooms** (98, [phases/PHASE-98-BIGROOMS.md](phases/PHASE-98-BIGROOMS.md)):
  per-sender streams on 83's membership layer for rooms past the 64 cap —
  gated on phase 83 shipping and on its own review before any code.
  Non-deniable by design; fanout stays the ≤64 layer.
- **The SFU seam** (voice design Slice I) for rooms too large for a mesh.
- **Governance `set_config` proposals.**

Two deliberate exclusions:

- The hover card's **device line** (92-3) is designed and deliberately
  unbuilt: showing a friend which device you are online from crosses a privacy
  line `AggregateUserState` currently draws for us, so it needs an opt-in before
  it ships. Reasoning in
  [phases/PHASE-92-HOVERCARD.md](phases/PHASE-92-HOVERCARD.md).
- **Federation is not a candidate.** Phase 88
  ([phases/PHASE-88-FEDERATION.md](phases/PHASE-88-FEDERATION.md)) is a declined
  design, not a plan awaiting a builder, gated on 83 if it is ever reconsidered.
  Read it before re-proposing the idea — it also records what already works
  across deployments without any of it.

## Deferred cleanup, all verified still open

- `RegisterFromInviteScreen` still registers passkey-first
  (`navigator.credentials.create()`), out of step with the auth-v2 password +
  TOTP flow every other entry point uses.
- `auth_backup_code` is dormant: migration 0040 creates it and
  `store/auth_v2.go` has `ReplaceBackupCodes` / `ConsumeBackupCode` /
  `CountUnusedBackupCodes`, with no caller anywhere. Drop table + funcs.
- The threads dot's server total is only re-synced on a debounced refetch;
  threads whose inbox rows this client doesn't hold still lag until then
  (`threadsNeedingYouCount` corrects only held rows).
- The camera choice (`device-prefs.ts` cameraId) has the same stale-id weakness
  the mic had before 63-3 (Brave re-randomizes deviceIds per session;
  late-plugged devices unmatched). Fix the same way: persist the label, resolve
  via `voice/device-resolve.ts` at capture time.
- The client's windowed attachment backfill (App.tsx `listAttachments` effect,
  `GET /api/attachments`, `CHALK_ATTACH_FETCH_WINDOW_HOURS`) is redundant since
  fetch_history started carrying attachment refs on the page itself; drop the
  effect, the endpoint, the `ListAttachmentsForChannelWindow` query and the env
  knob together.
- **Zuckermode has no reachable "leave call" control.** The only leave button
  is the voice dock's (`voice-dock-leave`), the dock renders inside the
  sidebar, and Zuckermode hides the sidebar and its nav toggle outright
  (`.chalk-app--zucker .chalk-nav-toggle { display: none }`). So a phone in
  that mode can join a room and has nothing to press to get out — the mic and
  camera toggles are there, the exit is not. Found while probing 95-1, which
  did not cause it: the controls band never carried a leave button either.
  Verified in the running app, and the last check in the 95 probe records it.
- `docker/Dockerfile`'s frontend stage runs `npm run build` without
  `NODE_ENV=production`, so released images ship unminified bundles with inline
  sourcemaps. Costlier since 52-2 (the MediaPipe chunk is 153 KB minified vs
  737 KB as shipped).

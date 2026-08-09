# Eighth Review of Phase 83 — Envelope Fanout: Gate 0 Re-Review of the R6/R7 Delta

**Review date:** 2026-08-08

**Design reviewed:** the phase-83 plan (envelope fanout) in
[`../phases/PHASE-83-MSGSIG.md`](../phases/PHASE-83-MSGSIG.md) — the
**sixth revision**, commit `7a0da57`, which claims to incorporate the
three open blockers (P83-A-R6-01, P83-A-R6-02, P83-A-R7-01) and every
completion item from the sixth and seventh reviews.

**Previous review:**
[`security-phase-83-seventh-review-2026-08-08.md`](security-phase-83-seventh-review-2026-08-08.md)
(the independent cryptographic audit of the fifth revision, which also
carries the fifth and sixth reviews' record).

## Character of this review

This is the re-review Gate 0 was awaiting: verify that each of the
three blockers is actually closed in the normative text — from the
text, not the disposition table — re-derive the arithmetic the delta
changed, then sweep the new and reworked sections for defects the fix
wave introduced. The seventh review's cryptographic-core verdict
(sound; no primitive-, binding- or key-schedule-level break) covered
text this delta did not touch and is not re-litigated.

## The three blockers, verified closed

### P83-A-R6-01 — the false-alarm walls: closed

§A.5 now splits the flagged state on a frozen boundary
([lines 581–612](../phases/PHASE-83-MSGSIG.md#L581-L612)):

- **live delivery** from a sender whose chain does not currently end
  in admit → `unauthorized-sender`, the alarm, kept as evidence;
- **backfill** (history fetch, scrollback, thread, summary) from a
  once-admitted sender → `former-member`, rendered calmly with the
  "membership at the time of sending is not verifiable for you" label,
  never full assurance;
- a principal in no verified chain and not in the manifest →
  `unauthorized-sender` on **every** path — the case that matters most
  keeps the alarm everywhere;
- the path-choice residual is stated honestly in §A.8
  ([line 1042](../phases/PHASE-83-MSGSIG.md#L1042)): the server picks
  the delivery path, so an injection can present as `former-member`;
  what it can never obtain is member assurance.

The restored-device scenario that drove the finding now resolves
correctly: a device restore re-fetches history via backfill, so
departed-member and lapsed-guest walls render `former-member`, and the
alarm stays meaningful. The guest rule
([lines 683–691](../phases/PHASE-83-MSGSIG.md#L683-L691)) takes the
same split; §A.3's typed-result list
([lines 299–305](../phases/PHASE-83-MSGSIG.md#L299-L305)) and the A-4
vectors ([lines 617–624](../phases/PHASE-83-MSGSIG.md#L617-L624))
carry both states. One boundary case checked deliberately: a
reconnecting device receives missed messages by history fetch —
backfill — so a legitimate pre-removal message arriving after the
removal was observed takes the calm state, not the alarm; only a
genuine mid-session live push from a removed sender alarms, which is
the vector's exact shape. **Closed.**

### P83-A-R6-02 — the concurrent-mint overflow: closed

§A.5 freezes a deterministic resolution
([lines 535–553](../phases/PHASE-83-MSGSIG.md#L535-L553)): the
effective roster is a pure function of verified state — §A.4's latches
first, then, if the valid sum exceeds 64, a shed to exactly 64 in
frozen order (active guest admissions before member admissions, within
each class descending admit `cert_hash`). Shed state is target-local,
loud ("admitted — waiting for room"), reversible by any departure or
lapse, and gates **flap emission only** — acceptance of the shed
target's own messages is untouched, which correctly collapses the shed
into the withheld-flap shape of the stale-view residual rather than
inventing a new denial class. §A.7's over-limit rule is reconciled
explicitly ([lines 988–993](../phases/PHASE-83-MSGSIG.md#L988-L993)).
Every client computes the same output from the same verified state; no
server input, no new artifact, no wedged channel. **Closed** — two
note-level items on this rule below.

### P83-A-R7-01 — the Gate-F interregnum: closed

§A.9 couples the epoch raise to deployment
([lines 1077–1088](../phases/PHASE-83-MSGSIG.md#L1077-L1088)): a
build-F `chalkd` raises the durable era row itself at startup —
idempotent compare-and-set, never lowered — so no manual step stands
between the weekly automatic update and a sendable client; the
instance-ack barrier still gates *enforcement*, which keeps the
mixed-era guarantee intact. The residual window is frozen as bounded,
visible and self-resolving
([lines 1111–1122](../phases/PHASE-83-MSGSIG.md#L1111-L1122)): one
rolling deploy plus at most one heartbeat, a single banner, resumption
off the welcome's `era_enforced` with no user action. The
withheld-`era_enforced` denial is named in §A.8
([line 1044](../phases/PHASE-83-MSGSIG.md#L1044)), and the hostile
acceptance test now includes the unattended timer-driven update
([lines 1123–1127](../phases/PHASE-83-MSGSIG.md#L1123-L1127)).

Sequencing re-derived independently: on a single-instance deployment
the restart that ships build F disconnects every pre-F session, the
instance acks immediately, and enforcement follows in the same breath;
in a rolling deploy, pre-F instances cannot carry `acked_era ≥` the
epoch, so the barrier holds exactly until the last of them is
replaced — the deploy itself is the sequencer. A rollback to a pre-F
`chalkd` leaves the row raised but unread, and build-F clients fall to
the visible read-only state §A.7's rollback paragraph already
specifies. No new gap found. **Closed.**

## The completion items, verified closed

All ten are present where the disposition table says:

| Item | Verified at |
|---|---|
| First-seen replay rule re-frozen with the canonical | §A.3 ([lines 289–297](../phases/PHASE-83-MSGSIG.md#L289-L297)) — `(sender_user_id, writer_scope, client_msg_id)` → first-seen id, duplicates render once |
| `claimed_sender` = the sealed canonical's `sender_user_id`, never outer metadata | §A.5 ([lines 558–563](../phases/PHASE-83-MSGSIG.md#L558-L563)) + the relabel vector |
| §A.8 overhead arithmetic | `63 + N×108` with the 35/12/16 decomposition ([lines 1019–1022](../phases/PHASE-83-MSGSIG.md#L1019-L1022)) — re-derived, correct |
| Backup generation rollback | `repack_seq` u64 in the commit, floor-latched, refused below the floor; fresh-device residual scoped ([lines 884–900](../phases/PHASE-83-MSGSIG.md#L884-L900), §A.8 row) |
| Commit-record page bound | 27 fixed bytes + 32/page ⇒ ≤ 182 — re-derived: `1+16+8+1+1 = 27`, `(5876−27)/32 = 182.8` ✓ ([lines 897–900](../phases/PHASE-83-MSGSIG.md#L897-L900)) |
| Pin-blob capacity note | one full 64-member channel exceeds the ~60-pin budget; overflow reported, TOFU residual ([lines 958–963](../phases/PHASE-83-MSGSIG.md#L958-L963)) |
| SP 800-38D bound for `K_wrap`/`K_history` | §A.8 ([lines 1026–1030](../phases/PHASE-83-MSGSIG.md#L1026-L1030)) |
| Guest identity = link possession | §A.8 residual row ([line 1043](../phases/PHASE-83-MSGSIG.md#L1043)) |
| Backup KDF IKM hygiene | recorded as a note with the revisit guidance ([lines 945–950](../phases/PHASE-83-MSGSIG.md#L945-L950)) |
| Threat-model scale sentence | frozen verbatim in §A.9 ([lines 1131–1135](../phases/PHASE-83-MSGSIG.md#L1131-L1135)) |

## Fresh sweep of the reworked text — three notes, none blocking

### Note 1 — say that manifest members are never shed

The shed order names "member admissions … descending admit
`cert_hash`", and manifest members have no admission certificate —
their reference is a `manifest_admit_ref`. The intended reading is
derivable twice over: shed candidates are *admissions*, and the
arithmetic guarantees enough of them exist (the manifest holds ≤ 64,
so any overflow is composed of cert admissions and guests:
`certs + guests = sum − manifest ≥ sum − 64`). But a frozen
deterministic function should not leave its domain to derivation — one
sentence in §A.5 ("manifest members are never shed; the shed set is
drawn from certificate admissions and guest admissions only") closes
it. Ride slice A-6.

### Note 2 — the shed key is signature-grindable; say why it doesn't matter (or make it ungrindable)

`cert_hash = SHA-256(canonical || sig64)`, and Ed25519 signing may be
randomized, so a *minting actor* can grind `sig64` to steer their own
admission's hash — in particular, downward, so the racing admission
that triggered the overflow never sheds itself and the shed lands on
the existing highest-hash admission instead. Bounded on every axis:
it requires an actor already authorized to admit, the overflow state
is loud and self-healing, and the worst outcome is withheld flaps for
one surfaced target — power an authorized insider has by blunter
means. Either acknowledge the grind in the §A.5 text as accepted, or
key the shed order on `SHA-256(canonical)` alone (content-only, and
member-admit canonicals have no attacker-free field to grind). Ride
slice A-6.

### Note 3 — the concurrent-repack race self-heals; one sentence would say so

Two devices of one identity repacking concurrently both read
`repack_seq = N` and write `N + 1`; the commit key holds one value, so
one write wins wholesale. Checked: nothing is lost — the loser's
records live in its local state (the backup is never authority), its
next repack reads the winner (at or above its floor), merges by the
frozen `(channel, anchor_hash)`/`rev` rules and re-contributes them.
The floor refusal only ever rejects generations older than one the
device itself verified, so it cannot wedge an honest device. Worth one
sentence in §A.7 so an implementer doesn't "fix" the race with
something worse. Ride slice A-8.

## Checked and found sound (negative results)

- The live/backfill boundary composes with the first-seen replay rule:
  a verdict latches at first local acceptance, and a replayed envelope
  is a duplicate of that object — the server cannot re-push an object
  on the other path to change its rendering.
- The shed rule composes with the acceptance rule (a shed target's
  chain still ends in admit; its messages keep full assurance) and
  with §A.7's over-limit rule (migration overflow still refuses
  conversion; the shed exists only past Gate F for the mint race).
- The startup raise cannot enforce early (barrier unchanged), cannot
  be lowered, and degrades to the stated visible read-only state under
  rollback builds and under a withholding server.
- The `former-member` label never upgrades to member assurance on any
  path, for members or guests; `granted` history is unaffected by the
  split (a new member's pre-join scrollback still arrives attested,
  not flagged).
- All changed arithmetic re-derived: 27-byte commit header, the
  182-page bound, `63 + N×108`, and the unchanged 108/93/63 figures.

## Verdict

The sixth revision closes all three blockers as specified — each fix
is the narrow, text-local correction the reviews asked for, none
introduces a coordinator, a ceremony, or a new wire artifact, and the
completion items are all present and correct. The fresh sweep found
only the three notes above: two one-sentence clarifications and one
acknowledged-or-hardened ordering choice, all riding slices that
already exist, none touching a security boundary.

**Gate 0 passes at the sixth revision.** Envelope fanout is cleared
for implementation: slice A-1 may land, with the three notes folded
into the A-6 and A-8 slice text as they are built. Per the standing
rule, any *further* normative change to the design before or during
implementation re-opens the gate for the changed text only.

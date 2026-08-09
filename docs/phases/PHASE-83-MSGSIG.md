# Phase 83 — MSGSIG: envelope fanout

**Status: the phase-83 plan — planned, not started; twelfth revision.
**Gate 0 re-opened** and held open by six external reviews: the
fifth independent review (2026-08-09, five blockers → seventh
revision), the R11 review (two membership-state-machine blockers →
eighth), the R12 delta review (two blockers in the replacement text →
ninth, R11's verified closed), the R13 delta review (the owner's
unresolvable zero ref + the missing admission references in messages
and grants → tenth, R12's verified closed), and the **sixth
independent review** (2026-08-09, of the ninth revision at `7dbdcb31`
— four blockers `P83-A-F6-01 … 04`, two of which — F6-02's core and
the owner-zero resolver — the then-uncommitted tenth revision had
independently already fixed via R13; the rest, above all the
cross-target ordering hole, answered in this revision). **No slice
lands until an independent re-review of the accumulated delta closes
the gate again**. The sixth is the R14 delta review (of `3d9aa45`,
the tenth+eleventh) — it verified R13-01/02 and the F6 fixes closed,
and found one Critical blocker in the new control chain itself: the
CAS trusted the server as sequencer, which the threat model forbids;
answered in this revision by the in-band gossip witness (decided
2026-08-09) plus the honestly-stated zero-state residual. Decided
2026-08-08: envelope fanout
(formerly "option A" of `PHASE-83-MSGSIG-ALTERNATIVE.md`, this file's
previous name) supersedes the original transcript design that lived at
this path. The rejected designs are recorded in "The decision" at the end
and preserved in git history.**

No group key exists at all: every message wraps its own key once per
member over pairwise-derived secrets, and authenticity is a per-recipient
MAC — deniable, rotation-free, freeze-free. Born from the usability audit
that found the transcript design's user-felt costs — the departure freeze
above all.

**Reviewed 2026-08-08 five times** (findings numbered `P83-A-*`; the
section letters below match): first (commit `177d14c`) — "viable,
revise", P83-A-01 … 06; second (commit `e774247`) — A-04/A-05 resolved,
seven blocking R2-01 … 07; third (commit `8a0931a`) — R2-03/06/07
resolved, *"close to reviewable completion"*, five narrow blocking
findings P83-A-R3-01 … 05; fourth (commit `eb1ee873`) — all R3 findings
answered in structure, **five blocking state-machine/commit-protocol
findings P83-A-R4-01 … 05**; fifth (same commit, independent re-review)
— all five R4 findings confirmed against source, plus **P83-A-R5-01**
(receive-side sender membership) and new completion items. **The fifth
revision incorporated all of them.** The reviewer's principle stands: *a
design that protects a conversation only by repeatedly preventing people
from using it is not a successful secure-messaging design.*

A **sixth review** (2026-08-08, of the fifth revision) — security,
usability at scale, performance — confirmed the six prior blockers
closed and added two blocking findings: P83-A-R6-01 (the
directional-assurance latch falsely flagged departed-member and
lapsed-guest history on restored/dormant devices) and P83-A-R6-02
(concurrent mints could exceed `MAX_FLAPS` with no frozen resolution).
It also settled scale: performance at the 64 cap is a non-issue, and
≥ 65-member rooms (the 512-user question) are out of scope by
construction — a different message layer, not a larger cap.

A **seventh review** (2026-08-08, an independent cryptographic audit —
`docs/audits/security-phase-83-seventh-review-2026-08-08.md`, which
also carries the fifth and sixth reviews' record; earlier rounds live
in the disposition tables below and in git history) found the
cryptographic core sound, re-verified both R6 findings still open at
the fifth revision, and added **P83-A-R7-01** (blocking — the Gate-F
interregnum: between the build-F bundle deploying and a deliberate
epoch flip, a build-F client could emit neither suite, so every
channel went read-only) plus completion items (`claimed_sender`
provenance, replay identity, the §A.8 overhead arithmetic, backup
generation rollback, guest identity = link possession, the static-key
GCM bound, and the sixth review's leftovers: the commit-record page
bound, the pin-blob capacity note, the threat-model scale sentence).
**This sixth revision incorporates all three blockers and every
completion item** — dispositions below.

An **eighth review** (2026-08-08,
`docs/audits/security-phase-83-eighth-review-2026-08-08.md`) — the
Gate 0 re-review of exactly that delta — verifies all three blockers
and every completion item closed in the text, re-derives the changed
arithmetic, and finds only three non-blocking notes: state that
manifest members are never shed (A-6); acknowledge or remove the
signature-grindability of the shed order's `cert_hash` key (A-6); one
sentence that the concurrent-repack race self-heals (A-8). **All three
are folded into this text** (dispositions below) rather than deferred
to the slice text.

**Gate 0 passed** at that revision (eighth review), clearing slice A-1
at the time — superseded below by the fifth independent review's
re-opening. Of the folded notes, only the Note-2 choice is normative — the
shed order now keys on the admit's **content hash**,
`SHA-256(canonical)`, not `cert_hash` (the hardening the review
offered, taken over the accepted-residual wording) — and per the
standing rule that one sentence re-opens the gate for the changed text
only; Notes 1 and 3 state what the review already verified. Any
further normative change to the design re-opens the gate for the
changed text only.

A **ninth read** (2026-08-09) found the core sound and added two
corrections, neither re-opening Gate 0's security conclusions. First,
a residual §A.8 had never stated: **no per-message roster
commitment** — recipients verify only their own flap, so a malicious
sender (not just the server) can partition the room's view of a
message; the row is now in §A.8's table. Second, Note 2's "no
attacker-free field to grind" was overstated: a `guest_admit`'s
owner-chosen `expiry_ms` and a democratic cert's attested
`proposal_id` remain grindable, so the §A.5 claim is scoped to the
common member-admit path (the effect stays availability-only,
target-local, loud — the hardening stands). The second is a
correction to gate-covered text, so per the standing rule the gate
re-opens for that sentence only.

A **tenth read** (2026-08-09, adversarial — transplant, reflection,
mix-and-match, encapsulation grinding, backup atomicity) found the
core sound, confirmed the ninth read's re-scoped §A.5 sentence
(closing the gate on it), and left six low/informational findings,
none re-opening Gate 0's security conclusions. Two are normative
freezes, each re-opening the gate for its sentence only per the
standing rule: the self-flap's degenerate MAC derivation (§A.2 —
`K_mac(A→A)`, min = max, plus an A-1 vector) and the grant ceiling's
no-expired-chunk case (§A.6 — refuse the new grant, never evict a
live chunk). Three state already-true properties: a failed tag
accuses no one (§A.5), key-compromise impersonation joins §A.8's
residual table, and sender-only editing's load-bearing check is the
client's (§A.5). The sixth is discharged, not deferred: the canonical
envelope's leading `uuid16(channel_id)` — confirmed against the
retired plan's frozen bytes in git history — already binds the
channel inside the MAC independently of both AADs, and §A.3 now says
A-3's re-freeze must retain it.

A **fifth independent review** (2026-08-09, external —
`docs/audits/security-phase-83-option-a-fifth-review-2026-08-09.md`;
its round numbering is its own repository-level Option A series, not
the reads above, so its findings are `P83-A-F5-*`) examined the
tenth-read revision at `2732a94` and found **Gate 0 does not pass
there**: five blocking findings — the fork era door under-specified
and over-powered (F5-01), a shed sender unable to form a valid
envelope at all (F5-02), Gate F's expired-row premise contradicted by
the runtime's deliberate reclaim-and-keep-alive behavior (F5-03), the
authenticated message canonical living in git history instead of this
document (F5-04), and the scalar backup `rev` turning ordinary
two-device sync races into permanent security warnings (F5-05) — plus
three completion items (the too-thin create-retry record, the
dangling audit links, the stale "passed" status). **This seventh
revision incorporates all of them** — dispositions below. The era
door is *removed* rather than frozen (the review's smaller option,
decided 2026-08-09): recreation is the sole fork exit this phase.
**Gate 0 stands re-opened for the changed text and passes again only
on independent re-review of this delta; no slice lands before that.**

An **R11 review** (2026-08-09, external, of the seventh revision —
`docs/audits/security-phase-83-r11-review-2026-08-09.md`; findings
`P83-A-R11-*`, its own numbering chosen clear of the reads above)
confirmed the cryptographic core ("I would not redesign the
envelope-fanout crypto based on this review") and the seventh
revision's Gate-F lease, then found **two blockers in the membership
state machine**: the sender-acceptance predicate's manifest arm lacked
the send side's "with no chain yet" qualifier, so a *removed manifest
member* passed acceptance forever — a one-word gap that restored
post-removal authenticated injection for founding members exactly
(P83-A-R11-01) — and the binding between the fingerprint an admission
authorizes and the runtime identity actually used for DH/MAC/signature
work was never frozen, leaving a compliant implementation free to use
a server-fetched "current identity" (P83-A-R11-02). Plus one Low
(duplicate membership predicates invite drift, R11-03) and two
informationals (FS/PCS consequence and roster equivocation — both
already stated, with an operational note and a wording caveat worth
adopting). **This eighth revision incorporates all five** —
dispositions below: §A.4 now freezes one `member_state` predicate
consumed everywhere, the `authorized_fp` binding with the
`identity-mismatch` typed result, and the identity-replacement
transition. **The gate stays open pending independent re-review.**

An **R12 delta review** (2026-08-09, external, of the eighth
revision — `docs/audits/security-phase-83-r12-review-2026-08-09.md`)
**verified R11-01/02/03 closed** and found two High blockers in the
eighth revision's own new text. P83-A-R12-01: the single "latest
effective admission" fingerprint resolver contradicted the frozen
non-retroactivity of actor authority — after an identity rotation
(A1 removed, re-admitted as A2), a fresh device would verify Alice's
*legitimate historical* certificates against A2 and manufacture
`identity-mismatch` for the downstream authority chain; the resolver
is now state-relative (`authorized_fp_current` for live traffic,
`authorized_fp_at(actor_admit_ref)` for authority artifacts), with a
frozen fingerprint-keyed historical identity lookup (the store already
retains retired generations; the fetch wire did not serve them).
P83-A-R12-02: "the only repair is identity replacement" was impossible
for the owner — the anchor bakes in the owner's fingerprint, the owner
cannot be removed, and F5-01 removed successor anchors — so owner
identity replacement is now explicitly **unsupported in this phase:
recreate the channel**, keeping the security-root transition in its
own future phase. **This ninth revision incorporates both** —
dispositions below; the gate stays open pending the reviewer's
proposed focused §A.4/§A.5 re-read.

An **R13 delta review** (2026-08-09, external, of the ninth revision —
`docs/audits/security-phase-83-r13-review-2026-08-09.md`) **verified
R12-01/02 closed** and found the fix's own two blockers, both temporal
bindings again, neither cryptographic. P83-A-R13-01: certificates
encode `actor_admit_ref = zeros` for the anchor owner, and
`authorized_fp_at` had no zeros arm — a literal implementation could
not validate any owner-signed certificate; the resolver now takes
`(actor, ref)`, maps the zero ref to `anchor.owner_ed25519_fp` **iff**
the actor is the anchor owner, and rejects a zero ref from anyone
else. P83-A-R13-02, the important one: certificates learned to name
their historical signer but *messages and grants did not* — no
`actor_admit_ref` in the message canonical, no `grantor_admit_ref` in
the grant canonicals — so a sender's legitimate rotation made their
entire history unverifiable (and grants undecryptable) on first fetch
by a fresh device, with no server-safe repair (asking the server which
retired identity to use hands it the choice). Every suite-2 object now
seals `actor_admit_ref` (fanout adaptation 4) and both grant
canonicals seal `grantor_admit_ref`; the reference is key selection
inside the MAC'd canonical — verification, never authorization, so
deniability and the R11 removal semantics are untouched, and the
four-step order (resolve identity → verify MAC → evaluate
`member_state` → classify) is frozen in §A.5. **This tenth revision
incorporates both**; the gate stays open, the next review scoped to
the added references and their interaction with removal/re-admission.

A **sixth independent review** (2026-08-09, external —
`docs/audits/security-phase-83-option-a-sixth-review-2026-08-09.md`,
of the ninth revision at `7dbdcb31`; it had not seen the tenth) found
four blockers, `P83-A-F6-01 … 04`. Two converged exactly with R13,
already fixed in the tenth revision — F6-02's admission references in
messages and grants, and the owner-zero resolver arm — independent
confirmation those fixes were the right shape; F6-02's remainder (the
distinct `former-identity` verdict; backup rekey on rotation) lands
here. The genuinely new findings: **F6-01** (Critical) — per-target
chains gave no authenticated order *between* targets, so a removed
actor plus the server could serve a fresh device a
post-removal-minted admission before the removal and have it stick;
answered with the **membership-control chain** (decided 2026-08-09
over backup-heads-only and checkpoints): every control artifact seals
`prev_control_head`, one CAS-serialized total order per channel,
authority evaluated at control position — fetch-order-independent on
every device, messages never behind it. **F6-03** — edits and
reactions lacked the replay fields the frozen replay rule demanded
(adaptation 5: uniform `(actor, writer_scope, client_msg_id)` triple
in all three types). **F6-04** — the backup commit rode a
last-write-wins prefs key, so a concurrent acked repack could be
silently discarded; the eighth review's Note 3 ("do not add locking")
is **retracted**, the a/b double buffer replaced by immutable
per-generation namespaces with a conditional (CAS) commit head.
Completion items: the policy-fork record key frozen as
`(channel, anchor_hash, policy_head)`; the assisted owner-recreation
flow recorded as an explicit Gate-F release dependency. **This
eleventh revision incorporates all of it**; the gate stays open
pending independent re-review of the accumulated delta.

An **R14 delta review** (2026-08-09, external, of the tenth+eleventh
revisions at `3d9aa45` —
`docs/audits/security-phase-83-r14-review-2026-08-09.md`) **verified
R13-01/02, F6-02, F6-03 and F6-04 closed** and found one Critical
blocker in the eleventh revision's own control chain: **the CAS
trusted the server as sequencer** (P83-A-R14-01). A hash chain gives
tamper evidence within a branch, not branch uniqueness — a malicious
server keeps advertising a stale head to removed-Alice, banks her
Mallory-admit on a hidden sibling branch, and serves a fresh Carol
only that branch as a perfectly linear chain; fork surfacing never
fires because no client sees both branches. The "minting requires
holding the head" claim is retired (a client only ever holds a head
the server *presented*). The answer, decided 2026-08-09 over
residual-only and quorum co-signing: **the in-band witness** — every
suite-2 object and grant seals its sender's
`(control position, control head)` inside the MAC'd canonical
(adaptation 6), receivers cross-check against their own chain, and
divergence is surfaced fork evidence the server cannot strip. The
hidden universe then survives only a permanent, total partition from
honest traffic — denial-class, loud — and the zero-state window
before first honest contact is stated as an §A.8 residual, because
no mechanism can close it (the server is a fresh device's only
window). **This twelfth revision incorporates it**; the gate stays
open pending independent re-review of the accumulated delta.

**Tag:** `#msgsig`.

---

## Review dispositions

First review (2026-08-08, commit `177d14c`): A-01 → §A.4 (superseded by
R2-01/02 below); A-02 → §A.6; A-03 → §A.7; A-04 **resolved** (dark
development, Gate F); A-05 **resolved** (encapsulation wording); A-06 → §A.3
+ §A.7 inventory.

Second review (2026-08-08, commit `e774247`), all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R2-01 (Critical) | Per-target chains cannot authenticate channel-wide authority: owner, mode, initial root, actor authorization all unbound | §A.4 (signed channel/conversion **authority anchors**, the policy chain, `policy_head` + `actor_admit_ref` on every cert, non-retroactivity rules, anchored bootstrap) |
| P83-A-R2-02 (High) | Independent per-target conversion rows converge on a set no one signed | §A.4/§A.7 (**one atomic signed conversion manifest**, channel-level compare-and-set, whole-manifest forks) |
| P83-A-R2-03 (Critical) | "Born-fanout channels are immune … unless the server claims pre-F" — self-contradiction; fresh clients led back to suite 1 | §A.7 (**a build-F client never originates suite 1, ever**; restore → verify anchor → auto-convert → else read-only) |
| P83-A-R2-04 (Critical) | Guest fragments cannot express "fanout required"; guest certs unspecified | §A.5 (the `0x04` fanout fragment form; frozen `guest_admit`/`guest_revoke` encodings; fragment-anchored verification, no server fallback) |
| P83-A-R2-05 (High) | Adoption state does not fit the phase-84 pin blob's contract or budget | §A.7 (**`channel_security_enc`**: a separate, domain-separated compact backup — anchors + adoption only, chains refetched and re-verified; frozen merge/capacity/reporting) |
| P83-A-R2-06 (High) | History grants lacked nonce layout, grant identity, paging and their own key | §A.6 (`K_history` domain; `grant_id`; absolute ranges; exact blob bytes; idempotency, quotas, expiry) |
| P83-A-R2-07 (High) | Gate F undefined for mixed pre-F/cached clients | §A.9 (protocol-era capability in hello/welcome; `client_upgrade_required`; draft-preserving reload; conversion deferred until sessions capable; mixed-version test) |

Non-blocking corrections, also adopted: WebCrypto disposal wording (§A.2),
the over-limit-channel conversion outcome (§A.7), parser minimums (§A.3).

Third review (2026-08-08, commit `8a0931a`), all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R3-01 (Critical) | The conversion anchor put the converter in the owner slot — any-member conversion silently changed governance or produced an invalid manifest | §A.4 (converter and owner get **distinct anchor fields**; the manifest's one-owner rule matches the *owner* slot; the converter attests, never inherits) |
| P83-A-R3-02 (High) | Manifest members had no valid `actor_admit_ref`; policy certs lacked hash, signature validation, idempotency and fork behavior | §A.4 (`manifest_admit_ref` derivation; the complete policy artifact + the no-freeze policy-fork rule) |
| P83-A-R3-03 (High) | The backup's merge needed `policy_p` the record didn't carry; the size math and page framing were wrong/missing | §A.7 (record carries `policy_p`; corrected budget; frozen page envelope, ordering, conflicts, tombstones) |
| P83-A-R3-04 (High) | Guest certs typed the raw lookup as a UUID and left revoke/expiry bytes open | §A.5 (`lookup16` type; separate frozen admit/revoke field lists; expiry + clock-skew rules) |
| P83-A-R3-05 (High) | Born-fanout creation needed a client-known channel ID and atomic anchor commit — unspecified wire/idempotency | §A.7 (client-minted `channel_id`, one-transaction insert, idempotent retry, pending-op record, the DM rule) |
| Claim correction | "No-suite-1 bounds the damage" read as availability-only; a poisoned conversion manifest is content disclosure | §A.7/§A.8 (scoped four-line claim) |
| Completion items | History quota/subtype; display-only timestamps; multi-instance Gate F | §A.6, §A.9 |

Fourth review (2026-08-08, commit `eb1ee873`) and fifth review (2026-08-08,
same commit — an independent re-review that confirmed every fourth-review
finding against plan text and source, then added one of its own), all
answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R4-01 (Critical) | The backup merge ordered competing trust roots by `policy_p` — a sequence meaningful only inside one anchor's chain (and, worse, one that advances only on mode changes) | §A.7 (merge keyed by `(channel, anchor_hash)`; a per-record `rev` orders within one root; different anchors are always a surfaced conflict; `policy_p` demoted to latch restoration) |
| P83-A-R4-02 (High) | "Page 0 last" over in-place page keys is not atomic — an authenticated mixture of generations can drop authority anchors | §A.7 (double-buffered page namespaces; a generation id in every page; one authenticated commit record written last as the atomic switch) |
| P83-A-R4-03 (High) | The owner could not sign the effective guest expiry: the mint flow clamps server-side and reveals `expires_at` only in the ack | §A.5 (client-chosen absolute `expiry_ms` inside advertised caps, signed before mint; one-transaction invite + admit storage; idempotent retry; atomic revoke; directional skew and the accepted-before-expiry rule) |
| P83-A-R4-04 (High) | Falling back to the last common policy after a fork could un-verify an observed removal and restore the target's flap | §A.4 (the monotonic omit latch: intersection for admissions, union for removals, across fork discovery) |
| P83-A-R4-05 (High) | Multi-instance Gate F asserted "never mixed-era delivery" over per-device, era-less presence rows that cannot represent it | §A.9 (the durable required-era epoch + per-instance ack barrier; hello, send and delivery gate on it; presence demoted to UI) |
| P83-A-R5-01 (High) | The receive pipeline never consulted the sender's chain, and pairwise MAC keys outlive removal — an ex-member plus the malicious server injects `authenticated-for-you` messages forever | §A.5 (the sender-acceptance rule; the `unauthorized-sender` typed result; directional historical assurance) |
| Completion items | `lp()`/`gov_record` bytes; history quota keying; tombstone retention vs dormant devices; guest flaps vs the flap cap; forks had no exit; one shared grant AAD shape | §A.3–§A.7 (canonical conventions, per-grantee quota, tombstones-as-UI rule, cap accounting, the era door — since removed by P83-A-F5-01, recreation is the exit — the grant subtype byte) |

Sixth review (2026-08-08, of the fifth revision) and seventh review
(2026-08-08, the independent cryptographic audit —
`docs/audits/security-phase-83-seventh-review-2026-08-08.md`), all
answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R6-01 (blocking) | One alarm for two verdicts: no grant exists for one's own post-join scrollback, so a restored or long-dormant device re-fetched all departed-member and lapsed-guest history as first-fetched-after-removal and rendered it `unauthorized-sender` — training users to ignore the alarm | §A.5 (the `former-member` / `unauthorized-sender` split on the frozen live-delivery/backfill boundary; the path-choice residual stated in §A.8) |
| P83-A-R6-02 (blocking) | Two authorized actors each seeing 63 could mint concurrently to 65 valid certificates — state every client verifies and no client can send under | §A.5 (the effective roster as a pure function of verified state: deterministic shed to 64 — guests before members, descending admit content hash (hardened from `cert_hash` per the eighth review's Note 2) — target-local, loud, self-healing; gates flap emission only, acceptance untouched) |
| P83-A-R7-01 (blocking) | The Gate-F interregnum: the weekly automatic update could ship the build-F bundle overnight while the epoch flip stayed a manual `chalkctl` step — every channel read-only, window unbounded, no operator present | §A.9 (the raise is coupled to deployment: a build-F `chalkd` raises the epoch itself at startup, compare-and-set, never lowered; the instance-ack barrier still gates enforcement; the bounded window frozen with its banner; the withheld-`era_enforced` denial named in §A.8) |
| R6/R7 completion items | Commit-record page bound; pin-blob capacity; threat-model scale sentence; `claimed_sender` provenance; replay identity; §A.8 overhead arithmetic; backup generation rollback; guest identity = link possession; the SP 800-38D bound; backup KDF IKM hygiene | §A.3 (the first-seen replay rule), §A.5 (canonical-only sender provenance + vectors), §A.7 (`repack_seq`, the ≤ 182-page bound, the pin-blob note, the KDF note), §A.8 (`63 + N×108`, the GCM bound, new residual rows), §A.9 (the frozen scale sentence) |

Eighth review (2026-08-08, the Gate 0 re-review —
`docs/audits/security-phase-83-eighth-review-2026-08-08.md`): **Gate 0
passes**; three non-blocking notes, all folded here:

| Note | Was | Resolved in |
|---|---|---|
| Note 1 | The shed order named "admit `cert_hash`" while manifest members have no admission certificate — the never-shed reading was derivable, not stated | §A.5 (manifest members are never shed; the shed set is certificate and guest admissions only, and the arithmetic guarantees they suffice) |
| Note 2 | `cert_hash = SHA-256(canonical ‖ sig64)` and Ed25519 signing may be randomized — a minting actor could grind `sig64` to steer their own admission below the shed line | §A.5 (**hardened**: the shed order keys on `SHA-256(canonical)` alone — no grindable field on the common path; guest `expiry_ms` and democratic `proposal_id` remain steerable, availability-only, stated there; the one normative delta since the gate, re-opening it for that sentence only) |
| Note 3 | Two devices of one identity repacking concurrently race the single commit key; an implementer might "fix" it with locking | §A.7 (the race self-heals: the backup is never authority, the loser's records re-merge at its next repack via `(channel, anchor_hash)`/`rev`; the floor cannot wedge an honest device; do not add locking) |

Fifth independent review (2026-08-09, external —
`docs/audits/security-phase-83-option-a-fifth-review-2026-08-09.md`),
all answered in this seventh revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-F5-01 (Critical) | The era door was sketch-level and over-powered: competing conversion anchors can assert *different owners* (so "the owner slot" names no one signer), and a fresh-manifest successor lets the owner replace a democratic roster exactly when governance evidence is ambiguous | §A.4 (**the era door is removed** — recreation is the sole fork exit this phase; the anchor's `era` byte frozen at `1`, reserved; a successor-anchor protocol is a future phase with its own review, never an A-2 detail) |
| P83-A-F5-02 (High) | A shed sender cannot form a valid envelope: exactly-one-self-flap plus the frozen 64-recipient effective roster is 65 flaps, and swapping itself in silently omits a required recipient | §A.5 (a shed participant cannot originate while shed: composer paused at *"admitted — waiting for room"*, draft kept, automatic reactivation on recomputation; incoming acceptance untouched; the shed order's direction stated — the list names what is **shed**) |
| P83-A-F5-03 (High) | The barrier read an expired heartbeat row as a dead process; the runtime deliberately survives a reaping — `HeartbeatLoop` re-registers and `reassertLocalPresence` keeps the sockets' presence alive — so delivery can outlive the row | §A.9 (`acked_era` is a renewable lease with **local self-fencing**: renewal confirmed before a deadline shorter than the stale-row threshold, or the process closes its three gates and its sockets itself, before the barrier may move without it; the partitioned-lease acceptance case added) |
| P83-A-F5-04 (High) | The bytes every per-recipient MAC authenticates — the substance of H-01 — lived in git history and a deferred A-3 "re-freeze", not in the selected plan | §A.3 (the complete canonical envelope frozen in this document: conventions, identity-field definitions, the `0x01/0x02/0x03` field lists, absence encoding, caps, the three named fanout adaptations, the vector list; A-3 implements, it no longer decides) |
| P83-A-F5-05 (High) | Scalar `rev` cannot converge two devices' concurrent same-anchor writes: benign sync races surface as permanent "write race" warnings, or a wholesale pick loses a monotonic latch | §A.7 (a field-wise same-anchor join: monotonic flag OR, ancestry-ordered policy latch, the tombstone derived from verified chains, verified floors by max; one merged record at `max(rev) + 1`; duplicate records survive only for a chain-confirmed genuine policy fork) |
| Completion items | The pending-op record too thin to replay a create; the seventh/eighth-review files deleted while still linked; the header still said "passed" | §A.7 (the pending-op record persists the complete canonical create request); `docs/audits/` (both files restored, the fifth review committed); the status header (Gate 0 re-opened, re-review required) |

R11 review (2026-08-09, external, of the seventh revision —
`docs/audits/security-phase-83-r11-review-2026-08-09.md`), all
answered in this eighth revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R11-01 (High) | The acceptance predicate read "manifest member OR chain ends in admit" while flap emission read "manifest member *with no chain yet*" — literally implemented, a removed manifest member passes acceptance forever, restoring the P83-A-R5-01 injection for founding members | §A.4 (one frozen `currently_admitted` predicate — the manifest entry is the implied root of a chain that does not exist yet, and any verified chain supersedes it entirely; both call sites now cite it; the six required vectors) |
| P83-A-R11-02 (High) | Admissions authorize a fingerprint, but no rule bound it to the runtime identity used for DH/MAC/signature work — a compliant client could use a server-fetched "current identity", letting a malicious identity service substitute keys for unpinned members | §A.4 (`authorized_fp` — manifest fp until a chain supersedes it, else the latest admit's fp — checked with `verifyIdentitySelfSig` before every cryptographic use; the `identity-mismatch` typed result, never silent TOFU; the remove + re-admit identity-replacement transition) |
| P83-A-R11-03 (Low) | The same membership question expressed independently at send and receive — the exact drift that produced R11-01 | §A.4 (`member_state` is one pure state-machine module with reference-model vectors in A-2; flap emission, acceptance, voice, guests, grants and actor authorization all consume it; nothing else computes membership) |
| P83-A-R11-04 (Info) | No FS/PCS means X25519 compromise = full impersonation toward the victim; accurately disclosed, but recovery deserved prominence | §A.8 (the key-compromise row now states the only repair: identity replacement via §A.4's transition — passwords and sessions repair nothing) |
| P83-A-R11-05 (Info) | `K_history` grants could read as grantor-signed; roster equivocation already accepted | §A.6 (grant authenticity stated as pairwise-deniable — a grantee could mint a grant to itself; no wording may imply a transferable grantor signature); §A.8 roster row unchanged |

R12 delta review (2026-08-09, external, of the eighth revision —
`docs/audits/security-phase-83-r12-review-2026-08-09.md`; it verified
R11-01/02/03 closed), both findings answered in this ninth revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R12-01 (High) | `authorized_fp` resolved only the *latest* effective admission, while actor authority is frozen non-retroactive — after a rotation, historical certificates signed under A1 would verify against A2 and fail `identity-mismatch`, retroactively destroying legitimate authority chains on fresh devices | §A.4 (the resolver is state-relative: `authorized_fp_current` for live traffic, `authorized_fp_at(actor_admit_ref)` for authority artifacts — one temporal model with the authority rule; a frozen `(user_id, ed25519_fp)` historical identity lookup in A-2, the store's retired generations already existing; the rotation-history vector) |
| P83-A-R12-02 (High) | The replacement transition (remove + re-admit) is impossible for the owner: the anchor bakes in `owner_ed25519_fp`, removal is prohibited (`ErrCannotRemoveOwner`, governance too), and F5-01 removed successor anchors — a contradiction, not a path | §A.4 (owner identity replacement is explicitly **unsupported this phase — recreate the channel**, surfaced as such; no owner-rotation artifact is invented, the security-root transition stays a future phase); §A.8 (the key-compromise row reworded per the review) |

R13 delta review (2026-08-09, external, of the ninth revision —
`docs/audits/security-phase-83-r13-review-2026-08-09.md`; it verified
R12-01/02 closed), both findings answered in this tenth revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R13-01 (High) | `actor_admit_ref = zeros` is the frozen encoding for the anchor owner, but `authorized_fp_at` defined no zeros arm — owner-signed policy/member/guest certificates were unverifiable under the new resolver | §A.4 (`authorized_fp_at(actor, ref)` — the actor joins the signature because zeros alone identifies nothing; the zero arm returns `anchor.owner_ed25519_fp` iff actor == anchor owner, `malformed` for anyone else; admit refs must name the actor as target; the four owner-arm vectors) |
| P83-A-R13-02 (High) | Certificates sealed their historical signer, but messages and grants did not — after a legitimate rotation, every earlier message MAC-failed on first fetch (`K_mac` derived from the rotated identity) and every stored grant became undecryptable, with no server-safe repair | §A.3 (fanout adaptation 4: `h32(actor_admit_ref)` in all three object types, one field, one rule); §A.6 (`grantor_admit_ref` in both grant canonicals, matching the grantee ref that always existed); §A.5 (the frozen four-step order — resolve identity via the ref, verify MAC, evaluate `member_state`, classify — verification never authorization, full current assurance requires ref == current admission, deniability and the R11 semantics untouched) |

Sixth independent review (2026-08-09, external, of the ninth revision
at `7dbdcb31` —
`docs/audits/security-phase-83-option-a-sixth-review-2026-08-09.md`;
its F6-02 core and owner-zero item had already been fixed by the
then-uncommitted tenth revision via R13 — independent convergence),
all remaining findings answered in this eleventh revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-F6-01 (Critical) | Per-target chains had no authenticated order between targets: a removed Alice, keeping her key, could sign a Mallory-admit referencing her old valid admission, and a fresh/restored device served it before her removal accepts it durably — restore outcome hung on server-selected fetch order | §A.4 (**the membership-control chain**: every control artifact seals `h32(prev_control_head)`, one server-CAS'd total order per channel; authority evaluated at control position, so a post-removal mint cannot chain before the removal on any device in any order; control forks = the policy-fork rules; the control floor in the §A.7 record; truncation stays the stated prefix-only residual; messages never serialize behind it) |
| P83-A-F6-02 (High) | Core already fixed (R13-02, tenth revision). Remainder: no distinct verdict for a valid retired-identity object (`former-member` misdescribes a still-current, rotated sender), and identity replacement orphaned the scalar-derived backup | §A.3/§A.5 (**`former-identity`** — the frozen joint classification table: the most any retired-key object can obtain, never current, never an attributed forgery); §A.4/§A.7 (rotation repacks `channel_security_enc` under the new scalar's key inside the same "update identity" action; a crash reads as absent, never corrupt) |
| P83-A-F6-03 (High) | `0x02`/`0x03` carried no `writer_scope`/`client_msg_id` while the frozen replay rule keyed every object by them — unimplementable as written, and reactions' `actor_user_id` didn't even match the triple's field name | §A.3 (adaptation 5: both fields in edits and reactions; the uniform `(actor, writer_scope, client_msg_id)` triple; identical first-seen/duplicate/retry semantics for all three types; replay-under-new-server-id vectors for all three) |
| P83-A-F6-04 (High) | The commit key rode the LWW prefs store — two acked concurrent repacks, one silently discarded; the field-wise join never sees a record the storage dropped, and the "self-heals, do not add locking" note assumed the loser survives | §A.7 (**Note 3 retracted**; immutable per-generation page namespaces + a conditional commit head — a dedicated row CAS'd on the one plaintext `repack_seq`; losers fetch, join, retry under a fresh generation; GC keeps new + previous; the five sixth-review tests) |
| Completion items | Owner-zero resolver (already fixed, R13-01); the policy-fork record key stated but absent from key/sort; bare "recreate the channel" not a usable owner recovery | §A.7 (fork-record key frozen `(channel, anchor_hash, policy_head)`, in the writer's sort); §A.4 + `docs/open-items.md` (the assisted one-action recreation flow is an explicit Gate-F release dependency — without it the owner-replacement UI stays hidden) |

R14 delta review (2026-08-09, external, of the tenth+eleventh
revisions at `3d9aa45` —
`docs/audits/security-phase-83-r14-review-2026-08-09.md`; it verified
R13-01/02 and F6-02/03/04 closed), answered in this twelfth revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R14-01 (Critical) | The control chain's CAS trusted the server as sequencer — but a malicious server enforces nothing: it advertises a stale head to a removed insider, banks her post-removal admit on a hidden sibling branch, and serves a fresh device only that branch as a linear chain; fork surfacing needs both branches seen, and "minting requires holding the head" confused a *presented* head with a unique one | §A.4 (the CAS demoted to race arbitration + honest-server ordering, explicitly never the security boundary; the attack recorded; the "holding the head" claim retired); §A.3/§A.6 (**adaptation 6 — the in-band witness**: every object and grant seals the sender's `(control_p, control_head)` inside the MAC'd canonical; the receive cross-check in §A.5's five-step order — divergence is surfaced fork evidence, never a delivery block); §A.8 (the zero-state residual stated: detection at first honest contact, prevention before it impossible; sustaining the false universe = permanent total partition, denial-class); the R14 litmus vector + cross-check vectors in A-2/A-4 |

---

# The design — envelope fanout, in full

*Every message is its own sealed envelope, one flap per member.* No group
key exists, ever. chalk's per-user X25519/Ed25519 identities make the
pairwise layer free: a standing secret between any two users is computable
offline from keys both already hold.

## A.0 Alice, Bob and Carol — the plain-language version

*(Explanatory only — nothing in this section is normative; the frozen
rules live in §A.2–§A.9.)*

Alice, Bob and Carol share a channel. When Alice sends "lunch?":

1. Her client makes a fresh random key — the **message key** — and
   locks the message with it. One locked box.
2. It attaches one **flap** per person in the room: Bob, Carol, and
   Alice herself. Bob's flap holds the message key wrapped so only Bob
   can open it, plus a tag computed from the standing Alice↔Bob secret
   — a secret both of them can derive offline from long-term keys they
   already hold, and nobody else can. Carol's flap is the same under
   the Alice↔Carol secret. The self-flap lets Alice reread her own
   message on another day or device.
3. Bob's client finds its flap, unwraps the message key, opens the box,
   and checks the tag. A good tag proves *Alice or Bob* made it — and
   Bob knows it wasn't him, so it was Alice: **authenticated for you**.
   Carol cannot forge Alice-to-Bob mail; she can't compute their
   secret. (Bob *could* forge it — to himself only. That is deliberate:
   nothing Bob holds proves to anyone else what Alice said.
   Deniability is a feature, not a gap.)

**So what exactly is a "flap"?** Picture the message as one strongbox
with a single key. The sender doesn't hand that key around — she makes
one copy per person in the room and seals each copy into a small
personal pouch: Bob's pouch only Bob can open, Carol's only Carol, and
inside each is the strongbox key plus a slip proving who packed it.
The strongbox and the whole row of pouches travel together as one
package; each member opens just their own pouch, takes the key, opens
the box, and ignores the other pouches. One of those pouches *is* a
flap. On the wire it is just three fields — the recipient's id, the
wrapped message key, and the authenticity tag (§A.3) — about a hundred
bytes per person.

There is **no group key** — nothing the whole room shares that could be
stolen once to open everything, and therefore nothing to rotate when
membership changes.

**When Carol is removed**, two things happen, neither a ceremony:

- **The flap stops.** Alice and Bob simply stop adding a flap for
  Carol. New messages carry nothing she can open. No re-keying, no
  freeze — the channel keeps working through every membership change.
- **The door is checked.** Carol still knows her old pairwise secrets
  forever (they derive from long-term keys), so if she — with a
  malicious server's help — mails Bob a validly-tagged message anyway,
  Bob's client asks a second question after "who wrote this?": *were
  they still in the room?* It checks Carol's signed membership chain,
  sees it ends in "removed", and renders the message as
  `unauthorized-sender` evidence instead of a member's words (§A.5).

Who is "in the room" is never the server's word. Each channel has one
signed **anchor** (creator, owner, starting roster), a small signed
**policy chain** (mode changes), and a signed **certificate chain per
member** (admitted → removed → re-admitted …). Clients fetch and verify
all of it themselves; the server stores and relays boxes it cannot open
and chains it cannot forge.

When Dave joins later, history does not reappear by magic: whoever
admitted him seals the old message keys to him as a labelled **grant** —
"history from before you joined was shared by Alice; original
authorship is not independently verified for you" (§A.6). Live messages
from the moment he joined carry normal assurance.

## A.1 Design principles (from the reviews, adopted)

- Common sends are one action and never wait for a coordinator.
- Removals never freeze the channel; ambiguity is scoped to one target.
- Security state advances automatically and never silently rolls back on
  the same device.
- **A build-F client never originates suite 1, under any circumstance**
  (§A.7) — read-only is the worst case, silent fallback never happens.
- History is immediate, explained once at channel level.
- Picture-word verification stays optional; malicious-first-fetch
  protection is scoped to manually verified identities, and the UI says so.
- Assurance language is **"authenticated for you"** — a tag proves *the
  sender or the recipient* produced it; the recipient trusts their own
  uncompromised client. Deniability is the product choice.

## A.2 Key derivation

```
ss            = X25519(my_x25519_priv, peer_x25519_pub)    // static-static DH
K_pair        = HKDF-SHA256(ss,  salt = utf8("chalk-pair-salt-v1"),
                            info = utf8("chalk-pair-root-v1:") ||
                                   uuid16(min(A,B)) || uuid16(max(A,B)))
K_mac(A→B)    = HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-mac-v1:")     || uuid16(A) || uuid16(B))
K_wrap(A→B)   = HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-wrap-v1:")    || uuid16(A) || uuid16(B))
K_history(A→B)= HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-history-v1:") || uuid16(A) || uuid16(B))
flap_key(m)   = HKDF-SHA256(X25519(eph_priv_m, member_pub),
                            salt = utf8("chalk-fan-flap-salt-v1"),
                            info = utf8("chalk-fan-flap-v1:") || uuid16(member))
```

All outputs 32 bytes; all hashes SHA-256; `uuid16` = raw 16-byte UUID,
strict parse. The sorted-UUID root is symmetric; directional infos split
the purposes — **`K_history` is its own derivation** so voice sealing and
history grants never share an AES-GCM nonce domain (P83-A-R2-06).

- **The self-flap derives degenerately, by the same formulas** (the
  tenth read): for the sender's own flap A = B, so
  `ss = X25519(my_x25519_priv, my_x25519_pub)`, min = max = A, and the
  tag key is `K_mac(A→A)` — no special case and no skipped MAC (the
  wrap already uses the uniform per-message `flap_key`). An A-1 vector
  pins the derivation.
- Trust anchoring unchanged: `trust.ts` pins Ed25519 (TOFU, picture-word
  upgrade); `verifyIdentitySelfSig` binds X25519 to it.
- Each message mints one ephemeral X25519 pair — **fresh per-message
  encapsulation, not forward secrecy** (§A.8; the self-flap makes old
  message keys recoverable from a later static-key compromise).
- **Shared-secret validation:** reject an all-zero X25519 output before
  any HKDF; reject non-32-byte public keys.
- **Key disposal, corrected for WebCrypto:** ephemeral private keys are
  generated non-extractable, live for the duration of one send, and every
  reference is dropped immediately after the last flap derivation —
  WebCrypto has no destroy operation and no erasure guarantee, so
  explicit zeroization applies only to application-owned byte buffers
  (`msg_key`, chain scratch), which are `fill(0)`ed in a `finally`.

## A.3 Wire format — message suite 2, fanout (frozen)

```
body = u8(suite = 2)
    || eph_pub(32)
    || u16be(flap_count)                    // 1 ≤ count ≤ MAX_FLAPS = 64
    || flap[flap_count]                     // sorted by uuid16(recipient);
                                            // duplicates malformed; exactly one
                                            // self-flap required
    || nonce(12) || body_ct                 // AES-256-GCM under msg_key;
                                            // body_ct = ct || tag(16)

flap = uuid16(recipient_user)
    || nonce(12) || wrapped_msg_key(48)     // AES-256-GCM(flap_key, msg_key)
    || mac_tag(32)                          // HMAC-SHA256(K_mac(sender→recipient),
                                            //   utf8("chalk-fan-mac-v1")
                                            //   || canonical || sha256(body_ct))

body AAD = utf8("chalk-fan-s2:") || uuid16(channel)
flap AAD = utf8("chalk-fan-flap-s2:") || uuid16(channel)
           || uuid16(recipient) || sha256(body_ct)
```

**Parsing (total, never throws):** every read length-checked;
`flap_count` bounded before allocation; total length must equal
`1 + 32 + 2 + count×108 + 12 + len(body_ct)` exactly, **with
`len(body_ct) ≥ 16`** (the GCM tag is the floor); body capped at 256 KiB;
**decrypted canonical capped at 128 KiB**; violations → typed `malformed`.
Nonces: 96-bit CSPRNG, fresh per AEAD call.

### The canonical envelope (frozen here — P83-A-F5-04)

The body plaintext is the canonical envelope inherited from the retired
transcript plan, **frozen in this document** rather than by reference
to git history: these bytes are what every per-recipient MAC
authenticates — the substance of H-01 — so the selected plan must
contain them, and A-3 now *implements* this section instead of making
a protocol decision after the gate. The definitions are the reviewed
transcript bytes **minus the signature**, with exactly three fanout
adaptations, each named below.

Conventions (the `sig64`/`gov_record` rules stay in §A.4):

```
lp(x)     = u32be(len(x)) || x
uuid16(x) = the UUID's raw 16 bytes; strict parse — text case can
            never alias
h32(x)    = exactly 32 raw bytes; fixed width, no length prefix; any
            other length is malformed

canonical      = utf8("chalk-msg-sig.v1") || u8(objType) || fields
object_hash(O) = SHA-256(canonical(O))   // suite 2 carries NO signature:
                                         // authenticity is the per-flap
                                         // MAC above, so the hash covers
                                         // the canonical alone — unlike
                                         // the transcript's
                                         // canonical || lp(sig)
```

The domain string keeps the transcript plan's name: nothing ever
shipped under it (that design retired dark), the reviewed mutation
vectors carry over byte-for-byte, and renaming would be a normative
change with no security content.

- `objType`: `0x01` message, `0x02` edit, `0x03` reaction set.
- Every UUID-valued field is `uuid16`; every digest, fingerprint or
  commitment is `h32`; remaining variable fields are `lp()`-prefixed
  with the per-field caps below; lists are `u32be(count) || element*`.
  An absent optional `uuid16`/`h32` encodes as all-zero bytes of its
  fixed width; an absent `lp` field as `lp("")`. Trailing bytes after
  the last field are `malformed`.
- Encoders reuse the `spacekey.ts` helpers (`writeU32BE`,
  `lengthPrefixed`, `concat`, `bytesEqual`, `utf8`), exported by A-1,
  plus a new `uuid16` — every canonical encoder in the repo uses them.

**Identity fields, defined:** `client_msg_id` — a fresh UUID, minted
first in the send flow, never reused. `writer_scope` — an opaque UUID
namespacing one device's counter store; never shared across devices; a
lost store mints a fresh scope and never restarts an old one. `wseq` —
strictly increasing per `(channel, writer_scope)`, persisted
sender-side, **an ordering claim only**: no security warning derives
from it. `sender_ts` — the sender's clock, display only (§A.8). The
durable object identity is `(sender_user_id, writer_scope,
client_msg_id)` — the replay triple above, sealed in the canonical.

**The six fanout adaptations** (each frozen; violating any is
`malformed`):

1. **`key_version` is `0`.** Suite 2 has no space-key context — the
   message key rides the flap — so every `u32be(key_version)` and
   `u32be(att_key_version)` below is zero; nonzero is `malformed`. The
   fields stay for byte-layout continuity with the reviewed vectors.
2. **The chain checkpoint is `(0, zeros)`.** `u64be(chain_index) ||
   h32(chain_hash)` bound the transcript; no transcript exists under
   fanout, so both are permanently zero; nonzero is `malformed`.
3. **`att_binding` gains the attachment key.** §A.5's per-attachment
   random keys ride the envelope, so each binding appends
   `att_key(32)`.
4. **Every object seals its actor's admission reference
   (P83-A-R13-02).** `h32(actor_admit_ref)` follows the actor identity
   field in all three types — `sender_user_id` for messages and edits,
   `actor_user_id` for reactions; one name, one semantic rule. It is
   the sender's **own effective admission at send time**: their
   `manifest_admit_ref` while no chain supersedes it, else their
   current admit `cert_hash` (zeros never valid here — every sender,
   the anchor owner included, has a manifest entry or a chain; §A.4's
   zero arm is for certificate actors only). It exists because the
   pairwise MAC key is a function of *which identity generation* sent:
   without it, a sender's later legitimate rotation makes every
   earlier message unverifiable on first fetch (the recipient would
   derive `K_mac` from the rotated identity), and asking the server
   which retired identity to use would hand it the choice. The
   reference selects the verifying identity via
   `authorized_fp_at(sender, ref)` — the referenced admission must
   name the sender, else `malformed` — and it is **verification, not
   authorization**: current authority stays `member_state`'s separate
   question (§A.5). This preserves deniability — it is a key-selection
   binding inside the MAC'd canonical, not a signature.
5. **Edits and reactions carry the replay fields (P83-A-F6-03).** The
   transcript bytes gave only the `0x01` message `writer_scope` and
   `client_msg_id`, while the frozen replay rule keys *every* suite-2
   object by them — a contradiction no implementation could satisfy.
   Both fields now follow `actor_admit_ref` in `0x02` and `0x03`:
   `client_msg_id` is minted fresh per object (edits and reactions
   included), `writer_scope` is the device's one scope, and the
   replay triple is uniform — `(actor, writer_scope, client_msg_id)`,
   the actor being the canonical's `sender_user_id` (messages, edits)
   or `actor_user_id` (reactions). First-seen, duplicate and
   optimistic-retry behavior is identical for all three types: a
   byte-identical resend dedups by triple and re-renders nothing; a
   duplicate triple under a different server id is a replay, rendered
   once.
6. **Every object gossips its sender's control head
   (P83-A-R14-01).** `u64be(control_p) || h32(control_head)` — the
   sender's verified §A.4 control-chain position and head at send
   time — immediately follows `actor_admit_ref` in all three types.
   It is the in-band anti-equivocation witness: the server relays it
   inside the MAC'd canonical and can neither strip nor alter it, so
   a concealed control branch survives only total partition from
   honest traffic (§A.4's witness rule; §A.8's residual). The
   receive-side cross-check classifies and never blocks: an older
   head must lie on the receiver's chain, a newer one must extend it,
   and any mismatch is surfaced control-fork evidence.

`0x01` — message:

```
uuid16(channel_id) || u32be(key_version = 0) || uuid16(sender_user_id)
|| h32(actor_admit_ref)                 // fanout adaptation 4
|| u64be(control_p) || h32(control_head)   // adaptation 6 (R14-01)
|| uuid16(writer_scope) || uuid16(client_msg_id) || u64be(sender_ts)
|| u64be(wseq)
|| uuid16(par_sender) || uuid16(par_scope) || uuid16(par_client_msg_id)
|| h32(par_env_hash)                    // reply target: content identity
                                        //  + parent object_hash; all zero
                                        //  when not a reply or the parent
                                        //  is legacy (rendered with the
                                        //  unauthenticated-target mark)
|| u64be(chain_index = 0) || h32(chain_hash = zeros)
|| lp(utf8(body_text))                  // ≤ 65,536 bytes
|| u32be(att_count) || att_binding*     // ≤ 10 (the server cap)

att_binding = uuid16(attachment_id) || u32be(att_key_version = 0)
|| u64be(byte_len) || h32(sha256(full_ciphertext)) || h32(sha256(enc_meta))
|| h32(sha256(enc_preview))             // zeros when no preview
|| att_key(32)                          // fanout adaptation 3
```

`0x02` — edit:

```
uuid16(channel_id) || u32be(key_version = 0) || uuid16(sender_user_id)
|| h32(actor_admit_ref)                 // fanout adaptation 4
|| u64be(control_p) || h32(control_head)   // adaptation 6 (R14-01)
|| uuid16(writer_scope) || uuid16(client_msg_id)   // adaptation 5 (F6-03)
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(prev_rev_hash)
|| u64be(sender_ts) || u64be(chain_index = 0) || h32(chain_hash = zeros)
|| lp(utf8(body_text)) || u32be(att_count) || att_binding*
```

`sender_user_id` must equal `tgt_sender` — sender-only editing, and
the client-side check is the boundary (§A.5). `prev_rev_hash` root
rule: a first edit names the `object_hash` of the original message; a
later edit names the previous edit — there is no empty-parent edit.
Under fanout this chain backs the **observed-ancestry recency claim
only** (§A.5): 0044's overwrite stands, there is no server revision
store and no ancestry fetch — the transcript plan's append-only
reversal retired with it, and unresolvable ancestry renders
unverified-recency, never false trust. Attachment bindings are
re-stated in full so the current revision is self-sufficient.

`0x03` — reaction set:

```
uuid16(channel_id) || u32be(key_version = 0) || uuid16(actor_user_id)
|| h32(actor_admit_ref)                 // fanout adaptation 4
|| u64be(control_p) || h32(control_head)   // adaptation 6 (R14-01)
|| uuid16(writer_scope) || uuid16(client_msg_id)   // adaptation 5 (F6-03)
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(tgt_env_hash)
|| h32(prev_set_hash)                   // zeros for the actor's first set
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*     // ≤ 64 per set, ≤ 32 bytes each;
                                        // zero count = cleared
```

A clear is a normal sealed fanout envelope — the bare unencrypted-clear
special case is deleted per the §A.7 inventory. Edit, reaction and
reply targets bind by content identity plus object hash, never by
server row locators; wire-frame `(channel_id, message_id, ts)` stays
receipt metadata.

The canonical's leading `uuid16(channel_id)` is load-bearing beyond
replay identity: it binds the channel inside the MAC independently of
both AADs (the tenth read) — retained above, in first position, for
all three types.

**Vectors (A-3):** per-field mutation across all three types;
cross-object type confusion (an edit's bytes presented as a message);
trailing bytes; absent-vs-zero optional fields; the six adaptations
violated (nonzero `key_version`, nonzero checkpoint, missing or short
`att_key`, a zero or foreign `actor_admit_ref` — one referencing an
admission whose target is not the object's actor — missing replay
fields in an edit or reaction, and a truncated or absent gossip
head);
replay-under-a-new-server-id for **all three** object types (F6-03);
oversize `body_text`/`att_count`/`emoji_count`/emoji;
a reply naming a legacy parent (all-zero binding); an edit whose
`sender_user_id ≠ tgt_sender`; the replay triple under a second server
id; a cross-channel canonical under a mismatched AAD.

**Replay identity, re-frozen with the canonical** (the seventh review's
confirmation item): the retired plan's first-seen rule carries over
unchanged — a client keys every suite-2 object by
`(actor, writer_scope, client_msg_id)` — the actor being the
canonical's `sender_user_id` for messages and edits, `actor_user_id`
for reactions; every type carries all three fields (adaptation 5,
P83-A-F6-03) — and binds that triple
to the first-seen server message id; a later envelope carrying the same
triple is a duplicate of that object, rendered once, never a fresh
message. A server-replayed envelope therefore changes nothing a user
sees; ordering and receipt timing stay server-controlled, as already
accepted with receipt-time timestamps.

### Typed results and the envelope vectors

Verification results: `authenticated-for-you` / `mismatch` / `forged` /
`unpinned` / `granted` / `legacy` / `identity-mismatch` (the runtime
identity fails §A.4's authorized-fingerprint binding — the fetched key
is not the one the membership state admitted, or its self-sig fails) /
`former-identity` (a valid object whose sealed `actor_admit_ref`
resolves to a **superseded** admission — produced by an earlier
identity of the principal; rendered as history from that earlier
identity, labelled, never current assurance and never an attributed
forgery — P83-A-F6-02) /
`unauthorized-sender` (a valid tag
from a never-admitted principal, or live delivery from one whose chain
does not currently end in admit) / `former-member` (a valid tag from a
once-admitted principal, first obtained by backfill — both per §A.5's
acceptance rule and its live/backfill boundary). Attribution fails
closed; availability does not.

**Vectors (A-1):** per-field mutation; truncation at every boundary
including a 15-byte `body_ct`; cross-channel; cross-recipient flap swap;
duplicate flap; missing/wrong self-flap; the self-flap's degenerate
`K_mac(A→A)` tag; reversed-direction tag; all-zero DH; oversize counts;
length mismatch; oversize canonical.

## A.4 Membership: an authority root, a policy chain, per-target cert chains

The second review's central point: per-target chains authenticate a
*sequence* but not the **channel-wide facts** that authorize it — who the
owner is, which mode is active, what the initial roster root was, and
whether the actor was a member when it signed. Those become authenticated
by two additions that stay invisible on the normal UI path: **one signed
anchor per channel** and **a small signed policy chain**. No global key
epoch, no composer freeze, no serialization of messages.

**Canonical conventions (frozen):** `sig64` = the signer's raw Ed25519
signature, exactly 64 bytes, appended with **no length prefix**; any other
length is `malformed` before hashing, and every `*_hash` below is
`SHA-256(canonical || sig64)`. `gov_record` carries over the retired
transcript plan's frozen canonical, kept normative here:
`uuid16(proposal_id) || u8(proposal_type) || uuid16(target) ||
u8(mode_payload) || u32be(eligible) || u32be(yes) || u32be(no) ||
u32be(quorum_percent) || u32be(threshold_percent)`, with
`yes + no ≤ eligible`, every count `< 2^31`, percents `≤ 100`. It is
present **iff** `auth_arm ≠ 0x00` — presence is a function of
`auth_arm` alone, a mismatch in either direction is `malformed`, and
trailing bytes after the last field are `malformed`. Mutation vectors
cover missing, duplicate and trailing optional fields (A-2).

### The anchors (the authority root)

```
channel_anchor    (born-fanout, signed by the creator; creator = owner):
  utf8("chalk-chan-anchor.v1") || u8(kind = 0x01)
  || uuid16(channel) || u8(era = 1)
  || uuid16(owner) || h32(owner_ed25519_fp)      // = the creator, locally known
  || u8(mode) || u8(chan_kind)
  || h32(member_manifest_hash)
anchor_hash = SHA-256(canonical || sig64)        // conventions above

conversion_anchor (converted channels, signed by one converter — P83-A-R3-01:
                   the converter ATTESTS; it never inherits ownership):
  utf8("chalk-chan-anchor.v1") || u8(kind = 0x02)
  || uuid16(channel) || u8(era = 1)
  || uuid16(converter) || h32(converter_ed25519_fp)   // the signer/attester
  || uuid16(owner)     || h32(owner_ed25519_fp)       // asserted by the legacy roster
  || u8(mode) || u8(chan_kind)
  || h32(member_manifest_hash)
  || u64be(converted_at_ms)   // the converter's clock; DISPLAY ONLY — never
                              // ordering, expiry or conflict resolution
```

`member_manifest` (hashed into the anchor, stored alongside it):

```
utf8("chalk-chan-manifest.v1") || uuid16(channel)
|| u32be(n) || entry*            // entry = uuid16(user) || h32(ed25519_fp) || u8(role)
                                 // sorted by uuid16; duplicates invalid; n ≤ 64;
                                 // exactly one owner entry, and it must equal the
                                 // anchor's OWNER slot (never the converter);
                                 // the converter must appear as an admitted member
```

**The manifest admission reference** (P83-A-R3-02): manifest members have
no admission certificate, so their authority to act is named by a
deterministic derived artifact:

```
manifest_admit_ref(user) = SHA-256(
  utf8("chalk-manifest-member.v1") || anchor_hash
  || uuid16(user) || h32(ed25519_fp) || u8(role) )
```

`actor_admit_ref` (below) may name either a `manifest_admit_ref` or a
later admission `cert_hash`; a removal supersedes **the exact referenced
membership state**, whichever form it took. Cross-type vectors (manifest
actor admits, cert actor admits, removal superseding each) are A-2 test
material.

- The server stores **one anchor per channel** — compare-and-set, first
  writer wins, identical re-append idempotent. Racing converters produce
  competing *whole manifests*; a client shown two valid anchors for one
  channel reports a **channel-conversion fork** (evidence, surfaced like
  the identity-changed wall) — other channels unaffected (P83-A-R2-02).
- The anchor is the **root of all authority**: the owner's membership
  needs no admitter (the bootstrap problem dies here), and every manifest
  member's authority is its `manifest_admit_ref`. Owner-only validations
  (removals, guest admission, policy changes) check the anchor's **owner**
  slot — under a conversion anchor that is the attested legacy owner,
  which stays inside the stated conversion-TOFU residual; the converter's
  signature upgrades nothing about it.
- Signing a server-presented legacy roster remains the deliberately
  accepted TOFU conversion residual, displayed as *"membership as
  recorded by <converter> on <date>"* — now a claim one signature
  actually binds.
- **A fork has no door in this phase (P83-A-F5-01 — the era door is
  removed).** The sixth revision sketched an owner-signed successor
  anchor at `era + 1`; the fifth independent review found it both
  under-specified and over-powered, and it does not survive. Two
  authority defects, recorded so the door is not quietly re-invented:
  competing conversion anchors can assert **different owners**, so
  "the anchor's owner slot" names no single signer acceptable to
  clients holding both roots — accepting either branch's owner lets
  that branch resolve its own conflict; and a successor carrying a
  fresh manifest would let the owner unilaterally replace a
  **democratic** roster precisely when governance evidence is
  ambiguous (membership changes there require proposals — the door
  would have bypassed the governance arm entirely). A security-root
  transition earns its own phase, canonical and review, or it does not
  exist. **"Recreate the channel" is the sole documented fork exit**,
  offered alongside the surfaced fork evidence; forks are exceptional,
  already loud, and never block other channels. The anchor's `era`
  byte is frozen at `1` — any other value is `malformed` — and remains
  in the canonical purely so a future successor-anchor phase can exist
  without reshaping the anchor.

### The policy chain (mode and ownership facts)

Mode changes are channel-wide authority facts, so they get their own tiny
chain rather than freezing the mode forever:

```
policy_cert: utf8("chalk-policy-cert.v1")
  || uuid16(channel) || u64be(p)          // p starts 1; the anchor is p = 0
  || h32(prev_policy_hash)                // anchor_hash for p = 1
  || h32(prev_control_head)               // the channel-wide control chain
                                          // (P83-A-F6-01, below)
  || u8(old_mode) || u8(new_mode)
  || uuid16(actor) || h32(actor_admit_ref)   // zeros ONLY for the anchor owner
  || u8(auth_arm) || gov_record?
policy_hash = SHA-256(canonical || sig64)    // sig validated against the
                                             // authorized_fp_at(actor,
                                             // actor_admit_ref) identity
                                             // (§A.4: fingerprint +
                                             // self-sig; zeros = the
                                             // anchor owner only) before
                                             // hashing
```

**The policy artifact is complete** (P83-A-R3-02): authorization mirrors
the product rules (owner unilateral → democratic; governance arm at
supermajority → dictator), the actor's membership is named by
`actor_admit_ref` (manifest-derived or cert), the server enforces unique
`(channel, p)` with identical-cert idempotency (race serialization, not
security), and clients persist the highest verified `(p, policy_hash)`
per channel as a rollback latch. Owner identity is fixed at the anchor
(chalk never transfers ownership today; if that changes it extends this
chain, not the cert format).

**Policy forks, without a freeze:** two valid policy certs at one
`(channel, p)` are kept as evidence and surfaced once at channel level.
The client then **retains the last common policy** for validating
existing memberships and for ordinary messaging — flaps to
already-authorized recipients continue — and refuses only *new
transitions* (membership or policy) that depend on either forked head.
Applying a server-chosen branch would recreate server-selected authority;
freezing the channel would betray the design principle. Neither happens.

**The removal latch is monotonic across fork discovery (P83-A-R4-04).**
Falling back to the last common policy must never *un-verify* a removal:
under fork fallback the effective roster is computed as **intersection
for admissions, union for removals** —

- a removal, once fully verified under a policy state that was valid when
  observed, keeps its target-local **omit latch** even if that policy
  head is later found forked; the flap never comes back on ambiguity;
- no recipient admitted only on either forked branch is included;
- recipients whose admitted state predates and is common to the fork
  continue receiving flaps normally; and
- the latch clears only the legitimate way — a *new* admit at the
  target's next `n`, chained past the removal, valid under the retained
  common policy (fork resolution being recreation, no post-resolution
  state exists in this phase — P83-A-F5-01).

A policy ambiguity is surfaced per affected target/transition; it never
re-discloses content to a departed member, and ordinary messages to the
common safe roster continue.

### Membership certificates (revised)

```
canonical = utf8("chalk-member-cert.v1") || u8(kind)
         || uuid16(channel) || uuid16(target)
         || u64be(n) || h32(prev_cert_hash)     // n = 0 root: prev = anchor_hash
         || h32(prev_control_head)              // the channel-wide control
                                                //   chain (P83-A-F6-01, below)
         || uuid16(actor)
         || h32(policy_head)                    // the policy state this cert
                                                //   was authorized under
         || h32(actor_admit_ref)                // the cert head that makes the
                                                //   actor a member; zeros when
                                                //   actor is the anchor owner
         || h32(target_ed25519_fp)              // admit kinds only
         || u8(auth_arm) || gov_record?
cert_hash = SHA-256(canonical || sig64)
```

Kinds: `0x01` admit, `0x02` remove, `0x03` leave, `0x05` guest_admit,
`0x06` guest_revoke (§A.5). (`0x04` convert-admit is retired — the
conversion manifest replaced it.)

**Validation, frozen:**

- Chain shape: `n` increments by 1; polarity alternates
  (admit → remove/leave → admit …); the `n = 0` root's `prev` is the
  channel's `anchor_hash`, and manifest members' roots are *implied by
  the anchor* (their chains begin at `n = 1`).
- **Authority is evaluated at the referenced heads, not retroactively**:
  the actor must be a member per its `actor_admit_ref` chain and the
  `auth_arm` must be valid under the referenced `policy_head`. Alice
  leaving *later* never invalidates admissions she made while a member.
- **The observed-removal rule**: once this device has verified Alice's
  removal, it rejects *new, previously unseen* certs whose
  `actor_admit_ref` is the admission that removal superseded. Target-local
  delivery consequence only — never a channel freeze.
- **Rollback latch**: highest verified `(n, cert_hash)` per
  `(channel, target)` persisted; chains ending below it are refused; two
  valid certs at one `(target, n)` = target-local fork → omit that flap,
  surface a per-target status, keep sending to everyone else.
- A flap is added only for targets that are `currently_admitted` per
  the one frozen predicate below (P83-A-R11-01) — a verified chain
  currently ending in admit, or a manifest member whose chain does not
  exist yet — and not shed (§A.5).
- Server storage: unique `(channel, target, n)`, idempotent identical
  re-append — race serialization, explicitly *not* a security mechanism.

**Stated residuals** (unchanged in substance): a withheld newer cert
keeps a sender's view stale for an unbounded time, online or not —
view-local, one sender's flaps; TOFU first-fetch scopes to the admitter's
pin; democratic certs record *authorized-member attestation to a
server-reported outcome* — C-01 closure stated separately for
dictator-authorized (cryptographic) and democratic (attested) transitions.

### The membership-control chain (P83-A-F6-01)

Per-target chains authenticate each target's *sequence*, but nothing
ordered one target's chain against another's — and the sixth
independent review showed that gap is content disclosure, not
inconvenience: authority is non-retroactive (correctly), so a removed
Alice, keeping her signing key, could mint an admit for a
server-controlled Mallory that references her old valid
`actor_admit_ref`, and a fresh or restored Carol — served Mallory's
admit *before* Alice's removal — accepts it; the observed-removal rule
only guards devices that saw the honest order, and the server chooses
the order. Restore outcome depended on server-selected fetch order,
which no pure state machine can tolerate.

So membership control gets what messages deliberately do not: **one
authenticated total order per channel.**

- **Every control artifact** — membership certificates of every kind,
  guest admits and revokes, policy certificates — carries
  `h32(prev_control_head)`: the artifact hash (`cert_hash` /
  `policy_hash`) of the immediately preceding control artifact,
  channel-wide; the first control artifact after creation names the
  `anchor_hash`. One linear hash chain interleaves every target's
  certs and the policy chain. Per-target `(n, prev_cert_hash)` links
  and `(p, prev_policy_hash)` links remain — an artifact is doubly
  linked: within its target's chain and within the channel's control
  chain.
- **The server holds one `control_head` per channel** and accepts a
  control artifact iff its `prev_control_head` equals the current
  head — compare-and-set, identical re-append idempotent. A lost race
  is rejected *with the current head*; the minting client fetches the
  delta, re-validates (the §A.4 rules, against the now-longer chain),
  re-signs, and retries — the same transparent re-sign-and-retry shape
  the guest mint already froze (P83-A-R4-03). **Only the rare
  control plane serializes; messages never wait on it, never
  freeze behind it.** And the CAS is **race arbitration and
  honest-server ordering, never the security boundary**
  (P83-A-R14-01 — a malicious server enforces nothing, here as
  everywhere): nothing stops a malicious server from advertising a
  stale head to a chosen signer and banking a hidden sibling branch.
  What defends against that is the witness rule below, not the CAS.
- **Validation is in control order.** Clients verify the control chain
  linearly from the anchor (or from their persisted control floor),
  and actor authority is evaluated **at the artifact's control
  position**: the actor's own chain state, as of everything preceding
  this artifact in the control chain, must be admitted. Within any
  one presented branch, order is authenticated and retro-insertion is
  impossible: against an honest sequencer, a cert minted after its
  actor's removal must chain *past* the removal, which already
  occupies an earlier position, so it is invalid on every device in
  every fetch order. **A client never holds "the" head — it holds a
  head the server presented** (the R14 correction; the earlier
  "minting requires holding the head" claim is retired): branch
  *uniqueness* is not a hash chain's to give, and comes only from the
  witness rule below. The first-seen observed-removal rule remains as
  defense in depth.
- **Equivocation, and the in-band witness (P83-A-R14-01, decided
  2026-08-09).** The R14 attack, recorded so its shape is never
  rediscovered: honest members advance `H → R` (remove Alice); the
  malicious server keeps advertising `H` to Alice, who signs
  `M = admit Mallory` at `prev = H` with her old valid
  `actor_admit_ref`; the server serves a fresh Carol only `H → M` —
  a perfectly linear chain on which Alice was never removed — and
  never reveals `R`. Fork surfacing is useless when no client sees
  both branches. **No mechanism makes a zero-state fresh device
  immune** — the server is its only window — so the design buys
  detection and containment through the witness network chalk already
  has, the members' own sealed envelopes: **every suite-2 object and
  every grant seals its sender's verified
  `(control position, control head)` inside the MAC'd canonical**
  (§A.3 adaptation 6; §A.6) — relayed by the server, strippable and
  alterable by no one. On receive, after the MAC verifies: a sealed
  position at or below the local chain's length must equal the local
  artifact hash at that position; a sealed position beyond it makes
  the client fetch the extension and verify it chains from its head;
  **any failure is control-fork evidence**, surfaced channel-level
  under the fork rules above (last common control state retained,
  transitions on either branch refused, recreation the exit). A stale
  sender's older head passes the prefix check; the cross-check
  classifies, it never blocks delivery. Consequence for the R14
  attack: Carol's false universe survives only while she receives
  **no authenticated object sealed past the concealed removal** — no
  message, edit, reaction, backfill page or grant from any honest
  member, ever. Sustaining it is a permanent, total partition of
  honest traffic — a loud silence in a live channel, denial-class —
  and the first honest contact converts the universe into surfaced
  fork evidence (§A.8 states the residual).
- **Forks:** two valid control artifacts naming one
  `prev_control_head` are a **control fork** — the policy fork is now
  simply its policy-cert case, and the handling is the frozen policy
  rule, unchanged: both kept as evidence, surfaced once, the last
  common control state retained for existing memberships and ordinary
  messaging, new transitions on either forked head refused, recreation
  the exit.
- **The control floor:** each client persists its highest verified
  `(control position, control head)` per channel — a rollback latch
  like the per-target ones, restored from the §A.7 backup. What
  truncation can still do is frozen as the residual: a server may
  serve a *prefix* of the chain (withholding the tail hides a recent
  removal from a fresh device — exactly the stale-view residual,
  unchanged in scope); what it can never do again is **reorder or
  retro-insert** — any chain it serves is one the honest mints
  actually produced, in the order they produced it.
- **Vectors (A-2):** Bob-admit then Alice-removal, both fetch orders
  (same result); a Mallory-admit minted after Alice's removal, served
  before and after that removal (invalid in both); a restore with a
  backed-up control floor refusing a truncated chain; a fresh device
  with no backup on a truncated chain (accepts the prefix — the stated
  residual — but can never accept a reordering); a control fork; a
  lost mint race retried; **the R14 litmus vector**: `H`, honest
  `R = remove-Alice` at `H`, Alice's `M = admit-Mallory` at `H` on the
  concealed branch, fresh Carol served only `H → M` — Mallory renders
  `CURRENT` **until** the first honest object whose sealed head lies
  past `R` arrives, at which point the fork surfaces and Mallory's
  admission is refused under the fork rules — evidence, never silent;
  plus the cross-check cases: a stale sender's older sealed head
  (passes), a sealed head not on the receiver's chain (fork), a
  sealed position beyond the local head with a valid extension
  (extends, then passes).

### One membership predicate, one identity binding (P83-A-R11-01/02/03)

**The predicate (R11-01, R11-03).** "Is this principal currently
admitted?" was written twice — at flap emission ("chain ends in admit,
or manifest member *with no chain yet*") and at sender acceptance
("manifest member, or chain ends in admit") — and the one-word
difference was a High blocker: read literally, the acceptance arm let
a **removed manifest member** pass forever, because the manifest entry
survives its own supersession. That re-opened exactly the post-removal
injection P83-A-R5-01 exists to close, for the founding members
specifically. The rule is therefore frozen **once**, as one pure
function every consumer calls — never re-derived in prose or UI code:

```
member_state(channel, principal, verified_state) ∈
  { CURRENT, CURRENT_SHED, FORMER, NEVER, FORKED, LAPSED_GUEST }

currently_admitted(principal) =
  a verified cert chain exists → that chain currently ends in admit,
                                 evaluated under this section's
                                 rollback, observed-removal and fork
                                 latches
  no chain exists              → principal is a manifest member
  // the manifest entry is the IMPLIED ROOT of a chain that does not
  // exist yet. The moment ANY verified chain exists for the
  // principal, it supersedes the manifest entry entirely — the
  // manifest is never a fallback past its own chain, and a removed
  // manifest member is as removed as anyone.
```

Consumers — all of them, and only through this function: **flap
emission** (`CURRENT` only — `CURRENT_SHED` withholds flaps per §A.5),
**sender acceptance** (`CURRENT` or `CURRENT_SHED` — shed is never
removal), **voice signal acceptance**, **guest handling**
(`LAPSED_GUEST` per §A.5's expiry rules), **history-grant acceptance**,
and **actor authorization** — the same function, evaluated over the
state the caller must use: current verified state for send/accept, the
referenced heads (`actor_admit_ref`, `policy_head`) for actor
authority, which stays non-retroactive as frozen above. The §A.5
live/backfill boundary maps onto its outputs: `NEVER` is
`unauthorized-sender` on every path; `FORMER` is the alarm on live
delivery and `former-member` on backfill. A-2 implements it as **one
pure state-machine module with reference-model vectors**; nothing else
in the client computes membership.

**The identity binding (R11-02).** Certificates and the manifest
authorize a *fingerprint*, not a UUID — `target_ed25519_fp` /
`ed25519_fp` exist precisely because "user X is admitted" is
meaningless without "as this key". What was never frozen is the check
that the runtime identity actually *used* — for the flap DH, the MAC
key, an actor's certificate signature, a grant seal, a voice signal —
is the one the membership state authorized. Without it, a compliant
implementation could fetch "the current identity for X" from the
server and use it, letting a malicious identity service substitute a
different first-seen key for an unpinned member even though the
admission authenticated another fingerprint. Frozen:

```
authorized_fp_current(principal) =
  the fingerprint of the latest effective admission state:
    the manifest entry's ed25519_fp while no chain supersedes it,
    else the latest valid admit's target_ed25519_fp

authorized_fp_at(actor, membership_ref) =
  the fingerprint the REFERENCED admission state committed to
  (the actor is part of the signature — zeros alone identifies
  nothing, P83-A-R13-01):
    membership_ref == zeros → valid IFF actor == the anchor's owner;
                              returns anchor.owner_ed25519_fp — the
                              owner's authority is the anchor itself.
                              A zero ref from ANY other actor is
                              malformed, on every artifact kind
    a manifest_admit_ref    → that manifest entry's ed25519_fp
    an admit cert_hash      → that certificate's target_ed25519_fp
                              (the referenced admission must name the
                              actor as its target, else malformed)
    anything else           → invalid

before ANY cryptographic use of a principal's identity:
  SHA-256(identity.ed25519_public) == the applicable authorized_fp
  AND verifyIdentitySelfSig(x25519_pub, ed25519_pub, self_sig)

which resolver applies (P83-A-R12-01/R13-02 — one temporal model,
the same one authority already uses):
  authorized_fp_current(principal) — resolving a principal NOW:
      flap emission (each target's wrap identity), voice signal
      acceptance (live-only traffic)
  authorized_fp_at(actor, ref) — verifying/decrypting an artifact
  that SEALS its own reference:
      a certificate's or policy cert's actor_admit_ref (signature
      validation), a suite-2 object's actor_admit_ref (K_mac
      selection, §A.3/§A.5), a grant's grantor_admit_ref
      (K_history selection, §A.6)
```

The split exists because §A.4's authority rule is **non-retroactive**
— an actor's certificates stay valid per the state referenced when
signed — and the fingerprint resolver must share that temporal model
or contradict it: with a single "latest" resolver, an identity
rotation (A1 → removed → re-admitted as A2) would make a fresh device
verify Alice's *old*, legitimate certificates against A2 and
manufacture `identity-mismatch` for the whole downstream authority
chain. A historical artifact verifies against the identity its
referenced admission committed to — A1 — and the vector below pins it.

**Historical identity retrieval, frozen (A-2):** resolving
`authorized_fp_at` requires retired identity generations to stay
fetchable. The store already keeps them (`identity_keys` marks old
generations `retired_at`, never deletes), but today's `fetch_identity`
returns only the active generation (`GetActiveIdentityKeyAny`), so A-2
adds a lookup keyed by **`(user_id, ed25519_fp)`** — the fingerprint,
because that is what the authenticated membership artifact commits to,
not a generation number the artifact never carries. A retired
generation returned this way passes the same self-sig check; the
server can serve only generations that existed, and a withheld one is
the familiar denial shape (verification fails closed, availability
loss only, never a substitution).

A failure is the typed result **`identity-mismatch`** — surfaced like
the identity-changed wall, **never silently absorbed as a fresh TOFU
pin** — and it fails attribution closed without freezing anything
else. The `trust.ts` pin remains what it is (continuity protection for
unverified identities over time); the authorized fingerprint is the
stronger, membership-anchored bound, and it wins wherever they
disagree.

**Identity replacement, defined (R11-02's transition item).** A member
who regenerates their identity changes their fingerprint, and no
silent path may rebind it. The transition is the existing machinery,
not a new kind of artifact: an authorized actor issues **removal +
re-admission** at the target's next two `n` (one "update identity"
action in the UI), and the re-admit's `target_ed25519_fp` binds the
new key. Until it lands, the member's new traffic is
`identity-mismatch` — target-local, loud, freeze-free like any
removal. Objects this device accepted under the old identity keep
their assurance (directional, as everywhere). One cost stated plainly:
the new identity cannot decrypt flaps sealed to the old key — old
history returns through §A.6 grants, not through the old self-flaps.
**And the backup moves with the identity (P83-A-F6-02's rekey item):**
`channel_security_enc`'s key derives from the identity X25519 scalar
(§A.7), so remove + re-admit alone would orphan the encrypted security
state — the rotation flow therefore **repacks the backup under the new
scalar's key as part of the same "update identity" action** (the
rotating client holds all the state locally; the old-key generation is
dead weight, garbage-collected by the next repack). A crash between
the rotation and the new-key commit leaves the backup reading as
*absent* to the new identity — the stated fresh-device residual until
the next repack, never silent corruption. Guests never rotate: the
guest identity is a pure function of the link secret (§A.8).

**Except the owner (P83-A-R12-02).** The transition above cannot apply
to the channel owner, and pretending otherwise would be a
specification contradiction on three frozen facts at once: the owner's
fingerprint is baked into the immutable anchor, the owner cannot be
removed (today's `ErrCannotRemoveOwner`, and governance refuses it
too), and this phase deliberately has no successor anchors (F5-01).
So it is stated plainly rather than papered over: **owner identity
replacement is not supported in phase 83 — recreate the channel.**
An owner whose new identity fails `authorized_fp_current` against the
anchor is surfaced with exactly that instruction. Inventing an
owner-key-rotation artifact here would re-open the security-root
transition F5-01 closed; if it is ever wanted, it is the same future
phase as the successor anchor, with its own review. One product
dependency is recorded rather than left as a surprise (the sixth
review's break-glass item): **before the identity-replacement UI
ships at Gate F, "recreate the channel" must be an assisted one-action
flow** — create the replacement, carry forward the locally verified
roster and settings, mark the old channel unsafe and read-only, and
state plainly which history cannot carry current assurance across —
or the owner-replacement surface stays hidden. Tracked in
`docs/open-items.md`.

**Vectors (A-2/A-4):** manifest member → removed → live injection
(`unauthorized-sender`); the same object via backfill
(`former-member`); manifest member → removed → re-admitted → accepted;
manifest member with no chain → accepted; later admit → removed →
rejected; a fetched identity whose fingerprint ≠ the applicable
resolver's `authorized_fp` (`identity-mismatch`, no TOFU adoption); a correct Ed25519 fingerprint
with a wrong X25519 or self-sig (`identity-mismatch`); an identity
change under an active membership (mismatch until the re-admit lands,
accepted after); **the rotation-history vector (R12-01)**: A1 admitted
→ A1 signs Bob's admit → A1 removed → A2 re-admitted → a fresh device
verifies Bob's admit and it **succeeds via `authorized_fp_at` = A1**,
while A1's *new live traffic* stays `identity-mismatch` under
`authorized_fp_current` = A2; **the owner-arm vectors (R13-01)**:
owner + zero `actor_admit_ref` + the anchor's owner key → valid;
a non-owner actor with a zero ref → `malformed`; owner + zero ref +
a substituted identity → `identity-mismatch`; a historical
owner-signed cert on a fresh device → verifies against the anchor's
`owner_ed25519_fp`.

## A.5 Send, receive, objects, guests

**Send:** mint `client_msg_id` → upload attachments → build canonical →
mint `msg_key` + ephemeral → one DH + AES wrap + HMAC per authorized
target (§A.4) + self → send. **Cap accounting (the fifth review's
guest-flap item):** `MAX_FLAPS = 64` bounds *flaps*, so it is enforced
over **members plus active guest admissions** (unexpired, unrevoked) —
an admit or guest mint that would take the sum past 64 is refused
**client-side**, where the certificates are minted; the parser's flap
bound and the manifest's `n ≤ 64` already refuse the result; the
server's member-add check is convenience, never the boundary (a
malicious server enforces nothing). A full 64-member channel therefore
has no guest slot until someone leaves or a guest lapses — stated in the
invite UI, not discovered at send time.

**The concurrent-mint overflow has a frozen resolution (P83-A-R6-02).**
Client-side refusal cannot serialize two authorized actors who each see
63 and mint concurrently to 65 valid certificates — verified state no
one could send under, since the parser refuses > 64 flaps and no valid
member may be silently omitted. So the **effective roster** is a pure
function of verified state, computed identically by every client with
no server input and no new signed artifact: apply §A.4's latches
(admissions intersected, removals unioned under forks), and if the
valid sum still exceeds 64, **shed to exactly 64 in a frozen order —
active guest admissions before member admissions, and within each
class descending `SHA-256(canonical)` of the admit**. The order names
what is **shed**, not what is retained (P83-A-F5-02's wording item):
every guest admission is shed before any member admission is touched,
and within each class the admission with the numerically highest
content hash is shed first, until exactly 64 remain. The key is the
content hash, deliberately not `cert_hash` (the eighth review's Note 2):
`cert_hash` covers `canonical || sig64` and Ed25519 signing may be
randomized, so a minting actor could grind `sig64` to steer their own
admission below the shed line; the content hash has no grindable
field **on the common path**. Two admission forms do retain
attacker-influenced bytes inside the canonical itself: a
`guest_admit` carries the owner-chosen absolute `expiry_ms`
(millisecond granularity — thousands of plausible candidates within
any sensible expiry), and a democratic cert's `gov_record` carries
the 16-byte `proposal_id`, pure attestation with nothing
cryptographic to check it against — so a minting actor can still
steer *those* admissions' positions in the shed order. The effect is
exactly the one already accepted for the shed itself: target-local,
loud (*"waiting for room"*), availability-only; the hardening stands
because it closes the common member-admit path, not because grinding
is impossible everywhere. **Manifest members are never shed** (Note 1): the shed
set is drawn from certificate admissions and guest admissions only,
and the arithmetic guarantees they suffice — the manifest holds ≤ 64,
so any overflow is composed of later admissions. A shed admission is target-local
and loud: the target is surfaced as *"admitted — waiting for room"*,
receives no flaps while shed, and re-activates automatically the moment
a departure, revocation or lapse brings the sum back within the cap —
the function's output simply changes; no ceremony, no new certificate.
Shedding gates **flap emission only**: a shed target's own messages
still pass the acceptance rule below (their chain validly ends in
admit), so the shed state is exactly the withheld-flap shape of the
stale-view residual — never a freeze, never silent.

**A shed participant cannot originate while shed (P83-A-F5-02).** The
frozen format admits no honest alternative: an envelope must carry
exactly one self-flap, the effective roster already fills all 64
slots with others, and silently swapping itself in for an effective
recipient would omit a participant the frozen roster says must
receive the message. So the honest-client behavior is itself frozen:

- while its own admission is shed, a client **does not send** suite-2
  objects — the composer is paused with the same *"admitted — waiting
  for room"* state, and the draft is kept;
- it reactivates and sends normally, automatically, the moment the
  deterministic recomputation gives it a slot (a departure, a
  revocation, a lapse) — no ceremony, no new certificate, no reload;
- its **incoming** artifacts are untouched: acceptance (below) keys on
  a verified chain currently ending in admit, which a shed target's
  does, so shed status hands a malicious server nothing that resembles
  a removal; and
- A-6's vectors cover the shed sender's refusal to originate and its
  automatic reactivation alongside the shed itself.

This is the honest cost of a hard 64-flap wire format, and it is
scoped exactly as the review scoped it: one participant, in a rare
concurrent-mint race, paused loudly until a slot opens — never a
channel-wide freeze.

**Receive:** own flap → DH → unwrap → decrypt → parse → resolve the
producing identity from the canonical's sealed `actor_admit_ref` via
`authorized_fp_at(sender, ref)` (§A.4: the referenced admission must
name the canonical's sender, else `malformed`; fingerprint match +
self-sig, else `identity-mismatch` — never the server's "current
identity for X", and never a bare TOFU pin where an admission
authorized a different key; P83-A-R13-02) → derive
`K_mac(that identity → me)` → recompute tag →
**sender acceptance (below)** → typed result; inner wins on mismatch.
**The claimed sender is the canonical's sealed `sender_user_id`,
nothing else** (the seventh review's provenance item): outer server
metadata is display-only and never selects the MAC key — keying off a
server-supplied sender label would let a relabel manufacture false
`forged` evidence against an innocent third member. A-4 carries the
relabel vector. **A failed tag accuses no one** (the tenth read):
anyone — the server included — can mint an envelope that decrypts for
a recipient (the flap is public-key encapsulation) and names any
`sender_user_id` in the canonical, so `forged` / `mismatch` verdicts
are evidence that *someone attempted a forgery*, never evidence
against the claimed sender — no UI surface may attribute or aggregate
them per claimed sender.

**The sender-acceptance rule (P83-A-R5-01) — a valid tag is necessary,
never sufficient.** The pairwise secrets are static-static: removal
revokes *nothing an ex-member holds*, so an ex-member can compute valid
flaps and MACs for every current member forever. Membership must
therefore be checked where messages are **accepted**, not only where
flaps are emitted:

- a suite-2 object renders as current with full assurance only when the
  claimed sender is **`currently_admitted` per §A.4's one frozen
  predicate** (P83-A-R11-01) — a verified chain currently ending in
  admit, or a manifest member whose chain does not exist yet; **never**
  a manifest entry surviving its own superseding chain, so a removed
  manifest member is as removed as anyone — evaluated under §A.4's
  rollback, observed-removal and fork latches, at the moment of first
  local acceptance (a shed sender's chain still ends in admit —
  `CURRENT_SHED` accepts);
- anything else takes a flagged typed result — **`unauthorized-sender`**
  or **`former-member`**, split by the boundary below: attribution
  fails closed — surfaced, never silently rendered as a member's words
  and never silently dropped;
- **assurance is directional, and the flagged state is split
  (P83-A-R6-01)**: an object this device locally accepted *before* the
  removal was observed keeps its assurance permanently. One first
  obtained *after* cannot prove it predates the removal (`sender_ts` is
  display only) — but *cannot-prove-timing* and *injected* are
  different verdicts, and one alarm for both trains users to ignore it:
  a restored device of an existing member re-fetches its entire
  post-join scrollback with no grant (there is no grantor for one's own
  membership), so every since-departed member's and every lapsed
  guest's history would otherwise re-arrive as the alarm. The boundary
  is the delivery path, frozen:
  - **live delivery** — an object pushed as new on a connected
    session — from a sender whose chain does not currently end in
    admit is **`unauthorized-sender`**: the alarm, kept as evidence;
  - **backfill** — history fetch, scrollback, thread or summary — from
    a sender whose verified chain (or the manifest) contains at least
    one admit, member or guest, but does not currently end in one, is
    **`former-member`**: rendered as history from a former member (for
    guests, a former guest), labelled *"from a former member —
    membership at the time of sending is not verifiable for you"* —
    distinct from the alarm, and never full assurance;
  - a principal that appears in **no** verified chain and not in the
    manifest is `unauthorized-sender` on every path; and
  - the residual is stated (§A.8): the server chooses the delivery
    path, so it can downgrade an injection from the alarm to
    `former-member` by serving it as backfill — what it can never
    obtain for that message is member assurance, which is the property
    that holds; the same class as `sender_ts` being display-only.

  Fresh devices of *new* members still lose nothing real: their
  pre-join scrollback arrives grantor-attested as `granted` (§A.6)
  rather than through this path;
- a recipient whose view is stale (the removal cert withheld) accepts —
  that is the already-stated withheld-cert residual, unchanged in scope;
- voice: a pairwise-sealed signal from a principal failing the same
  check is refused identically; and
- vectors (A-4): post-removal injection on the live path
  (`unauthorized-sender`); a pre-removal message re-fetched after the
  removal is observed; a restored device backfilling departed-member
  and lapsed-guest history (`former-member`, never the alarm); a
  never-admitted principal via backfill (`unauthorized-sender`);
  removal observed mid-session; a revoked guest re-using its admitted
  key; a server-relabeled outer sender (the MAC key follows the
  canonical's `sender_user_id` only); and §A.4's predicate/binding
  family (the manifest-removal injections and the `identity-mismatch`
  cases, listed there).

**Verification and authorization are two different questions
(P83-A-R13-02), asked in a frozen order.** The sealed
`actor_admit_ref` answers *"which identity produced this object?"* —
it selects the pairwise key and nothing more. `member_state` answers
*"may this person speak as a current member now?"*. The pipeline asks
both, independently: (1) resolve the producing identity via
`authorized_fp_at(sender, ref)`; (2) verify the MAC under it; (3)
**cross-check the sealed gossip head against the local control chain**
(§A.4's witness rule — divergence is surfaced control-fork evidence,
never a delivery block; P83-A-R14-01); (4) evaluate current
`member_state(sender)`; (5) classify by the live/backfill boundary. A removed member's old-identity message,
served as new by a malicious server, therefore *verifies* under step 2
and is still **`unauthorized-sender`** at step 4 — an admission
reference is never a ticket back in, and the R11 predicate fix is
untouched. The joint classification is frozen (P83-A-F6-02):

- `member_state` = `NEVER` → `unauthorized-sender`, every path;
- `member_state` = `FORMER` / `LAPSED_GUEST` → the live/backfill split
  above (`unauthorized-sender` / `former-member`), regardless of which
  of the principal's admissions the ref names;
- `member_state` = `CURRENT` (or `CURRENT_SHED`) and the sealed ref
  **is** the principal's current effective admission →
  `authenticated-for-you`; and
- `member_state` = `CURRENT` but the sealed ref resolves to a
  **superseded** admission of the same principal — a pre-rotation
  identity — → **`former-identity`**: rendered as history from that
  earlier identity (*"from an earlier identity of <user> — produced
  before their key changed; not verifiable as current for you"*),
  loud, lower assurance, **the most any object made with a retired
  key can ever obtain** — never current assurance, and never an
  attributed forgery (a compromised retired key gains no current
  authority, and its holder frames no one). An honest client always
  seals its current ref, so a live `former-identity` arises only
  under manipulation or a mid-rotation race, and it fails toward
  less assurance.

Vectors (A-4): the rotated sender's pre-rotation message first
fetched on a fresh device (verifies via A1 → `former-identity`,
never `mismatch`); a *new* injection made with the retired A1 key
after A2 is current (at most `former-identity`, never current); an
ex-member's old ref on live delivery (verifies, then
`unauthorized-sender`); a current member with a stale own ref
(`former-identity`); a ref naming another user's admission
(`malformed`).

This is a client-local check against chains the client already fetches
and verifies — no round trip, no coordinator, no freeze; the stale-view
residual bounds it exactly as it bounds send-side flap emission.

**Attachments:** per-attachment random keys inside the envelope's
attachment binding, digests verified before decryption. **Edits /
reactions:** same typed objects fanned out; sender-only editing;
observed-ancestry recency (narrow claim); 0044 overwrite stands. The
load-bearing edit check is client-side (the
tenth read): the pairwise keys authenticate who wrote the edit, and
the client renders it only when that equals the original's
authenticated sender — the server's sender check is convenience, never
the boundary. **Voice:** signals seal pairwise under `K_wrap`;
`chalk-voice-fp.v1` untouched.

**Guests (P83-A-R2-04), the fanout era made explicit:**

- **A fourth fragment form**, length/tag-distinct:

  ```
  secret(32)                              32 bytes → suite-1 legacy wrap
  secret(32) || owner_pub(32)             64 bytes → suite-2 signed wrap
  0x04 || secret(32) || owner_pub(32)     65 bytes → fanout only
  ```

  `parseJoinFragment` accepts exactly these; a 65-byte fragment with any
  other leading byte is rejected. Existing links keep their semantics
  byte-identically; links minted on fanout channels emit the `0x04`
  form. (The retired transcript design's `0x03` era byte died with it;
  the tags were kept distinct regardless, so no ambiguity survives.)
- **Guest certificates, actually frozen** (P83-A-R3-04). A new byte type:
  `lookup16(x)` = the link's raw 16-byte truncated-SHA-256 lookup value —
  it is *not* a UUID and is never parsed as one (it travels as base64 on
  the existing wire). Two separate canonical field lists, both signed by
  the owner only:

  ```
  guest_admit  (kind 0x05):
    utf8("chalk-member-cert.v1") || u8(0x05)
    || uuid16(channel) || uuid16(guest)
    || u64be(n) || h32(prev_cert_hash)       // chain rules as §A.4
    || h32(prev_control_head)                // §A.4's control chain
    || uuid16(actor) || h32(policy_head) || h32(actor_admit_ref)
    || h32(guest_ed25519_fp)                 // derivable by the owner at mint —
                                             // the guest identity is a pure
                                             // function of the link secret
    || h32(owner_ed25519_fp)
    || u64be(expiry_ms) || lookup16(invite)

  guest_revoke (kind 0x06):
    utf8("chalk-member-cert.v1") || u8(0x06)
    || uuid16(channel) || uuid16(guest)
    || u64be(n) || h32(prev_cert_hash)       // MUST be the guest_admit's cert_hash
    || h32(prev_control_head)                // §A.4's control chain
    || uuid16(actor) || h32(policy_head) || h32(actor_admit_ref)
    || lookup16(invite)                      // cross-checked against the admit
  ```

  **Rules:** `guest_admit`/`guest_revoke` occupy the admit/remove
  polarities of the §A.4 alternation rule. **Expiry is a lapse, not a
  cert**, and the skew rule is **directional** (P83-A-R4-03): an admit
  validates *new* traffic only while
  `local_now ≤ expiry_ms + 5 minutes` — there is no grace in the other
  direction, and **"historical assurance" means an object this device
  already locally accepted** before the lapse. A guest object first
  fetched after expiry cannot prove it predates it (`sender_ts` is
  display only) and takes §A.5's split verdict — `former-member` on
  backfill (the guest was admitted once), `unauthorized-sender` on
  live delivery. Vectors: admit→revoke
  transition, replay of a revoked admit, cross-invite substitution
  (lookup mismatch), cross-era substitution, expiry boundary at the skew
  edge in both directions, first-fetch-after-expiry.
- **The mint is atomic, or it does not happen (P83-A-R4-03).** Today's
  flow cannot produce the signed expiry — the client sends `ttl_secs`,
  the server clamps to its ceiling and the channel's remaining life, and
  only the ack reveals `expires_at` — so the fanout mint wire changes:

  - the server **advertises** its invite ceiling and the channel's
    remaining life (welcome/summary), the client computes
    `expiry_ms = min(user choice, ceiling, channel expiry)` as an
    **absolute** time, signs the `guest_admit` over exactly that value,
    and sends invite material + `expiry_ms` + the certificate in one
    request;
  - the server **never clamps**: it accepts iff the submitted
    `expiry_ms` is within both caps *at commit time*, and stores invite
    and admit certificate in **one transaction** — an invite without its
    certificate never exists, in no interval;
  - a race that moved a cap rejects with the current cap; the client
    re-signs and retries transparently — an internal round trip, still
    one "create link" action;
  - retry is idempotent by `(lookup16, cert_hash)`: byte-identical
    resubmission acks success (a lost ack never costs the user a second
    link); the same lookup with a different certificate is an error; and
  - **revoke is the same shape**: one transaction stores the signed
    `guest_revoke` and marks the lookup unusable — a revoked lookup
    without its revoke certificate never exists either.
- **The guest verifies the owner's signed `guest_admit` against the
  fragment key before sending or accepting anything** — never a
  server-state fallback. Members verify guest flaps against the admitted
  fingerprint. History for guests: grantor-attested (§A.6), grantor =
  the owner.

## A.6 Grantor-attested history (frozen wire)

The product decision stands: immediate scrollback, attested by the
granting member, labelled once at channel level. The wire is now exact:

```
grant canonical = utf8("chalk-history-grant.v1")
  || uuid16(channel) || uuid16(grantor) || uuid16(grantee)
  || uuid16(grant_id)                          // fresh random per grant
  || h32(grantor_admit_ref)                    // the grantor's effective
                                               // admission at mint time
                                               // (P83-A-R13-02) — selects
                                               // the K_history identity
                                               // via authorized_fp_at
  || u64be(control_p) || h32(control_head)     // the §A.3 adaptation-6
                                               // gossip head (R14-01)
  || u64be(grantee_admit_n) || h32(grantee_admit_cert_hash)
  || u64be(range_from_ms) || u64be(range_to_ms)   // absolute, half-open
  || u32be(chunk_index) || u32be(chunk_count)     // fixed per grant_id
  || u32be(entry_count) || entry*                 // ≤ 256 entries
entry = uuid16(message_id) || u64be(message_ts_ms)
     || h32(canonical_object_hash) || h32(sha256(body_ct)) || msg_key(32)

sealed chunk = nonce(12) || AES-256-GCM(K_history(grantor→grantee),
                                        grant canonical) || tag(16)
       AAD   = utf8("chalk-grant-s1:") || uuid16(channel)
            || uuid16(grantee) || uuid16(grant_id) || u32be(chunk_index)
            || u8(subtype = 0x01)          // 0x01 history, 0x02 legacy key
                                           // — the subtypes never share an
                                           // AAD, not only a type string
```

- **One grant = one `grant_id` + one absolute range, complete in itself**
  (`chunk_count` fixed at creation). Scrolling into older history creates
  a **new, independently complete grant** with its own id and range —
  paging never mutates a prior grant.
- Server storage/forwarding keyed by `(grantee, grant_id, chunk_index)`,
  idempotent; **quota keyed per grantee** (the fourth review's collision
  item): **32 stored chunks per `(grantor, channel, grantee)`**, so
  normal automatic grants to different new members never exhaust one
  another, under an overall abuse ceiling of **256 chunks per
  `(grantor, channel)`** with oldest-expired eviction; a ceiling reached
  with **no expired chunk refuses the new grant** (surfaced at the
  grantor), never evicts a live one — eviction could silently gut
  another grantee's incomplete batch, which renders nothing (the tenth
  read) — constants, not knobs; **expiry**: blobs deleted after
  fetch-ack or 30 days, whichever first.
  Retry = re-send same id/chunk; replacement = new grant_id; an
  incomplete batch renders nothing until its chunks are present.
- Grantee rules: resolve the grantor identity from the sealed
  `grantor_admit_ref` via `authorized_fp_at(grantor, ref)` (§A.4 —
  the referenced admission must name the grantor, else the grant is
  refused; P83-A-R13-02: a grant minted under A1 stays decryptable
  after the grantor rotates to A2, and the server never picks among
  retired identities), derive `K_history(that identity → me)`, verify
  the seal, check the grantee admit reference against its own verified
  admission, adopt keys, then verify both hashes per message after
  decrypting; mismatched entries are discarded individually. The
  grantee-side reference always existed; the grantor side now matches
  it.
- UI: the `granted` assurance state plus one persistent channel-level
  line — *"History from before you joined was shared by <grantor>;
  original authorship is not independently verified for you."* Live
  post-admission messages carry normal assurance.
- **Grant authenticity is pairwise-deniable like everything else**
  (the R11 review's wording item): `K_history` is a secret both ends
  hold, so a grantee could mint a valid grant addressed to itself —
  "shared by <grantor>" asserts provenance *for the grantee*, exactly
  the "authenticated for you" shape, and no UI or documentation
  wording may imply a third-party-verifiable grantor signature.
- Default: the admitting member auto-grants the recent fetch-history
  window; older ranges on demand; per-channel knob to disable.
- **Legacy space keys are all-or-nothing**, and the subtype is frozen:

  ```
  legacy_key_grant canonical = utf8("chalk-legacy-grant.v1")
    || uuid16(channel) || uuid16(grantor) || uuid16(grantee)
    || uuid16(grant_id)
    || h32(grantor_admit_ref)                  // as the history grant's
    || u64be(control_p) || h32(control_head)   // as the history grant's
    || u64be(grantee_admit_n) || h32(grantee_admit_cert_hash)
    || u32be(key_version_era) || space_key(32)
  ```

  sealed under `K_history` with AAD
  `utf8("chalk-grant-s1:") || uuid16(channel) || uuid16(grantee) ||
  uuid16(grant_id) || u32be(0) || u8(subtype = 0x02)`. A granted era
  opens everything that era retained; no narrower window is claimed.

## A.7 Migration — the full scenario

**The rule above all rules (P83-A-R2-03): a build-F client never
originates suite 1.** Not for a channel the server calls legacy, not on
rollback, not anywhere. With that rule, "the server relabels a
born-fanout channel as pre-F" stops being a downgrade: it is at most a
denial of convenience, and the contradiction the review caught is gone —
born-fanout and converted channels obey one state machine:

```
On open of / first send attempt in any channel without local adoption:
  1. restore  — a valid adoption/authority record from the encrypted
                backup (below)?  → adopted; proceed fanout-only.
  2. verify   — an existing channel/conversion anchor served for this
                channel verifies?  → write the adoption record; proceed.
  3. convert  — no anchor exists: the client CREATES the conversion
                anchor + manifest from the roster it can see, commits it
                (channel-level compare-and-set; loser adopts the winner
                after verifying it), writes adoption, proceeds.
  4. read-only — conversion cannot complete (offline, CAS unresolvable,
                fork evidence): the channel is readable, marked, and not
                sendable. Never suite 1.
```

Step 3 is automatic and uses the same roster the client would have used
anyway — no ceremony; the poisoned-roster TOFU residual is accepted and
stated. Legacy content stays readable in its marked read-only section.

### Stages

**Stage 0 — today.** Space keys, suite 1, `CHALK_WRAP_SIG_REQUIRED`
governing legacy wraps.

**Stage 1 — build F (Gate F, §A.9).** New channels are fanout-only from
birth, and the creation wire is frozen (P83-A-R3-05 — today
`CreateChannelPayload` carries no ID and Postgres assigns it via
`INSERT … RETURNING`, so the anchor could not name the channel; the same
client-minted-UUID move the retired transcript plan adopted for genesis
applies here):

- `create_channel` gains `channel_id` (client-minted UUID), `anchor`
  (the signed `channel_anchor` bytes) and `manifest` (the full member
  manifest). The client durably persists a **pending-op record**
  *before* sending, and it holds the **complete canonical request**
  (the fifth independent review's retry item): `channel_id`, the
  signed anchor bytes, the full manifest, the member list and roles,
  `chan_kind`/mode, plus the adoption intent — enough immutable bytes
  to replay the byte-identical request after a crash or reload, so a
  lost ack never costs the user a channel or produces a
  different-anchor error against their own retry.
- The server validates agreement before touching the database: caller =
  anchor owner; payload `channel_id` = the anchor's; manifest hash =
  the anchor's; manifest members/roles = the payload member list +
  creator-as-owner; `chan_kind`/mode consistent with the payload — then
  **one transaction** inserts channel row, member rows and anchor.
- **Idempotent retry**: re-creating the same client-minted `channel_id`
  with a byte-identical anchor acks success (returns the existing
  channel) — a lost ack is retried safely; the same ID with a
  *different* anchor is an error (the client re-mints everything). The
  pending-op record clears on ack.
- **The DM rule**: if a DM between the pair already exists, the server
  returns *it* (today's reuse path) and the submitted ID, anchor,
  manifest and key material are discarded — the client then runs the
  §A.7 adoption state machine on the returned channel (verify its
  anchor, or convert it) rather than silently attaching a new-channel
  anchor to a different ID.
Existing channels: converted by the state machine above, typically by the
first member to send on build F. After adoption, suite 1 renders only in
the read-only legacy section; a new suite-1 arrival is flagged, never
shown as current. Adoption is a one-way latch per device.

**Stage 2 — the security-state backup (P83-A-R2-05).** Adoption does
**not** ride the pin blob — wrong contract, wrong budget (the pin blob
holds `{v, pins}` in ~7,900 bytes, ~60 pins; one 64-member channel of
cert heads would swamp it, and pin merge semantics don't fit monotonic
heads). Instead, a second prefs key with its own domain:

```
keys    "channel_security_enc.<gen>.<i>" — immutable per-generation
        page namespaces, <gen> = lowercase hex of gen16 — plus one
        conditional commit head (P83-A-F6-04, below)
KDF     HKDF over the identity X25519 scalar,
        salt "chalk-chansec-salt-v1", info "chalk-chansec-v1"
        (re-derived on identity replacement — §A.4's rotation flow
        repacks under the new scalar's key before the rotation is
        complete)

record  uuid16(channel) || u8(flags) || h32(anchor_hash)
        || h32(policy_head) || u64be(policy_p)
        || h32(control_head) || u64be(control_p)   // the §A.4 control
                                                   // floor (P83-A-F6-01)
        || u32be(rev)
        = 133 bytes exactly. flags bit0 = era-adopted; bit1 = conflict
        record (a second anchor for the same channel — both records
        survive, surfaced as fork evidence); bit2 = tombstone (channel
        left/deleted; dropped at the next repack after 30 days).
        rev (P83-A-R4-01) = a per-(channel, anchor_hash), identity-local
        revision counter, bumped by every state change the record
        encodes (adoption, latch advance, conflict flag, leave, rejoin).
        It exists because policy_p CANNOT order the merge even inside
        one anchor: p advances only on mode changes, while adoption,
        leaves and latch updates never touch it. policy_p and control_p
        stay in the record purely to restore the rollback-latch floors.
        The fork-record key is (channel, anchor_hash, policy_head) —
        the sixth review's consistency item: two records for one
        (channel, anchor_hash) exist ONLY for a chain-confirmed policy
        fork, keyed and sorted by policy_head, collapsing when
        ancestry resolves.

pages   immutable generations plus a conditional head (P83-A-F6-04 —
        this supersedes the a/b double buffer; R4-02's goal, no
        authenticated mixture of generations, is preserved by the
        commit's page hashes):
        page plaintext = u8(v = 1) || gen16 || u8(page_index)
                      || u8(page_count) || u16be(record_count) || record*
        sealed        = nonce(12) || AES-256-GCM(K, plaintext) || tag(16)
        page AAD      = utf8("chalk-chansec-s1:") || u8(page_index)
        commit plaintext = u8(v = 1) || gen16 || u64be(repack_seq)
                      || u8(page_count) || h32(sha256(sealed_page))*
        commit AAD    = utf8("chalk-chansec-commit-s1:")
        gen16 = 16 CSPRNG bytes minted per repack; every page of one
        repack lands under its own gen-keyed namespace, so concurrent
        writers can never interleave into each other's pages.
        repack_seq (the seventh review's rollback item) = a u64 bumped
        on every repack, floor-latched like rev: each device persists
        the highest repack_seq it has verified and refuses a commit
        below its floor — a complete-but-older generation is then
        detected rollback, not current, on any device with prior
        state. A fresh device has no floor: the stated fresh-device
        residual, unchanged in scope.
        **The commit is conditional — the eighth review's Note 3
        ("the race self-heals; do not add locking") is retracted as
        the sixth independent review showed** (P83-A-F6-04): the
        self-heal assumed the losing device survives to re-merge, but
        the prefs store is last-write-wins per key, so with a plain
        overwrite two devices can both be *acked* while one write is
        silently discarded — and if that loser dies, its conflict
        observation or newer anchor is never durably merged. So the
        commit head moves out of the LWW prefs blob into a dedicated
        row carrying ONE server-visible plaintext field, the u64
        repack_seq (deliberately: it is concurrency metadata — a
        repack counter — not channel data; everything else stays
        sealed): publish = UPDATE … WHERE seq = expected_seq, taking
        the sealed commit blob and new seq together. The CAS is
        concurrency control, never cryptographic authority — pages
        and commits stay authenticated, floors stay local, and a
        malicious server can still deny (refuse every CAS) but an
        honest server can no longer lose one of two acknowledged
        updates.
        Writer: repack wholesale (records sorted by uuid16(channel),
        then anchor_hash, then policy_head), write EVERY page under a
        fresh gen16 namespace, then CAS the commit with
        expected_seq = the seq this repack was built from. On CAS
        failure: fetch the winner, decrypt, run the field-wise join
        below against local state, and retry under a NEW gen16 —
        bounded retries, no lock, and the join now actually executes
        for concurrent writers instead of relying on the loser's
        survival. After a successful commit the writer deletes page
        namespaces other than the new and immediately previous
        generation (the GC bound).
        Reader: fetch the commit → refuse it if its repack_seq is
        below the local floor → fetch the named generation's pages →
        accept only when every page's gen16 and sealed-bytes hash
        match the commit; anything else (rollback, torn write,
        crashed writer, withheld page) keeps the previous local
        state — and a fresh device treats the backup as absent and
        retries, because a crash before commit leaves the previous
        generation's namespace fully intact and still named by the
        head. Orphaned namespaces from crashed writers are garbage,
        GC'd by the next successful repack.
        Bounds: usable plaintext ≈ (7900 × 3/4) − 28 − 21 ≈ 5.7 KiB ⇒
        **≤ 43 records per page** (133 B each); the commit record is
        the real page bound — 26 fixed plaintext bytes + 32 per page
        hash ⇒ page_count ≤ 181 (~7,700 records — no practical limit,
        stated so the u8's 255 is never read as the bound).
        Tests (A-8, per the sixth review): two writers with disjoint
        records; two writers changing the same record; the loser
        crashing immediately after its ack; a third device restoring
        mid-race; a crashed writer's orphan generation.

merge   keyed by (channel, anchor_hash) — NEVER by channel alone, and
        policy sequence never orders competing roots (P83-A-R4-01):
        - same (channel, anchor_hash): rev orders only records from ONE
          device's linear history. Two devices of one identity routinely
          both advance rev N to different N+1 states — one adopts while
          the other observes a leave — which is an ordinary sync race,
          not an authority fork, and must converge silently
          (P83-A-F5-05). The join is FIELD-WISE, deterministic on both
          devices, and emits one merged record at max(rev) + 1:
            flags   bit0 (era-adopted) and bit1 (conflict observed)
                    join by OR — monotonic observations, never undone
                    by a merge;
            bit2    (tombstone) is derived state, never last-writer:
                    at repack it is recomputed from the refetched,
                    verified chain (a leave/removal newer than any
                    admit sets it; a verified re-admit clears it).
                    Before chains verify, a disagreement at equal rev
                    keeps the tombstone — hiding is reversible,
                    re-disclosure is not;
            policy  the latch (policy_head, policy_p) joins by chain
                    ancestry, never by p alone: both candidates are
                    validated under the record's own anchor from the
                    refetched chain, and the verified descendant wins.
                    Two verified heads at one p, neither descending
                    from the other, is a GENUINE policy fork — only
                    then do two records survive, keyed by policy_head,
                    surfaced as §A.4 fork evidence (never as a device
                    sync warning), with validation on the last common
                    policy per §A.4;
            floor   the rollback floor restored from policy_p joins by
                    max, and only after its chain verifies (unchanged
                    below);
          no device identifier ever decides a security field — at most
          it serializes byte-identical writes;
        - one channel, live records under different anchor_hashes: BOTH
          are retained with bit1 set and surfaced as a channel-conversion
          fork — regardless of either record's policy_p or rev. A device
          with a locally trusted anchor keeps using it and refuses
          transitions rooted in the competitor; a fresh device with no
          prior local basis makes only that channel read-only until the
          conflict resolves (recreation — §A.4). Other
          channels are untouched;
        - policy_p is consulted only after the refetched policy chain
          validates under the record's own anchor, as the restored
          latch floor — never as merge order; and
        - tombstones order by rev like any record. Dropping one after
          30 days is safe because the backup is never authority: chains
          are refetched and re-verified, so a dormant device's
          resurrected live record renders the channel in its true
          post-leave state (the verified leave cert suppresses it
          again) — the tombstone only hides UI.
```

A hygiene note, recorded (the seventh review): the KDF's IKM is the
identity X25519 scalar. HKDF is one-way, so the backup key leaks
nothing about the scalar, and whoever holds the scalar can decrypt
everything the backup protects anyway — acceptable as frozen; deriving
from the identity seed entropy instead would be stricter key-separation
hygiene if this KDF is ever revisited.

Per-target cert-chain heads are deliberately **not** backed up: chains
are refetched from the server and re-verified against the anchor — the
anchor is what makes them verifiable, and it is 32 bytes. This became
safe to say only with the §A.4 control chain (P83-A-F6-01 — before it,
"re-verified" was fetch-order-dependent): the record's **control
floor** is what a restore needs, since refusing a truncated control
chain recovers every per-target head *in authenticated order*. What a
fresh restore loses without per-target head backup is then only the
rollback high-water marks, which collapses into the already-accepted
stale-view (prefix-truncation) residual.
`PinSyncStatus` grows the second blob's counters; overflow reported, not
silent; **sending never waits on backup**. One capacity fact, stated so
nobody mistakes the *pin* blob for full-roster coverage: a single full
64-member channel needs more identity pins than the pin blob's ~60-pin
budget holds on its own. Pin overflow is already reported-not-silent,
and members beyond it are simply unpinned on a fresh device — the
stated TOFU-first-fetch residual, not a new one.

**What no-suite-1 does and does not buy, scoped exactly** (the third
review's claim correction — the earlier "bounds the damage" wording read
as availability-only, and for C-01 it is not):

- no-suite-1 **eliminates legacy shared-key substitution** for build-F
  traffic — the server can never again recover a server-known space key
  for new messages;
- a backed-up or manually verified authority anchor **prevents silent
  anchor replacement** on that device;
- **without either, conversion is TOFU**: a malicious server can present
  a poisoned manifest whose converter or members include a
  server-controlled identity, and the fresh client will mint valid flaps
  for it — **content disclosure on that fresh view**, not merely an
  availability loss; and
- later anchor conflicts and membership rollback on the same device are
  detected and refused (the latches).

The channel/security settings surface states the protection level
plainly; mandatory verification remains deliberately off the table.

**Stage 3 — enforcement and retirement.** `CHALK_FAN_REQUIRED`
(`chalkctl fanout status/enable/disable`) rejects new suite-1 writes by
leading byte — operational hygiene, explicitly not the boundary.
**Over-limit channels** (> 64 members): `chalkctl fanout status` lists
them **before** Gate F; on build F they are read-only-legacy for sending
until deliberately split or recreated — a client never silently omits
valid members to fit the flap cap (the §A.5 overflow shed is not an
exception: it exists only for the concurrent-mint race past the cap,
and it is loud, deterministic and self-healing). `CHALK_WRAP_SIG_REQUIRED` flips to a
secure default once telemetry is READY; legacy reshares are cert-gated
from Stage 1 and retire with the last pre-F build.

**Rollback.** Before Gate F: nothing exists. After: an emergency build
may disable fanout **emission UI** (channels become read-only where not
yet converted) but never re-enables suite-1 origination — the
no-suite-1 rule is not conditional. A rollback that needs suite 1 back
is a decision to un-ship the phase, taken loudly with a user-visible
notice per channel, never silently.

### The `key_version = 0` cross-layer inventory (unchanged)

| Site | Today | Under fanout |
|---|---|---|
| `handleSend` (`ws.go:740`) | rejects `< 1` | suite-2 exempt (leading byte); suite 1 keeps the check |
| version ceiling (`ws.go:803`) | `≤ current` | skipped for suite 2 |
| `handleEditMessage` (`ws.go:3762`) | `≥ 1` | exempt |
| `handleSetReactions` (`ws.go:3924`) | `≥ 1` unless clearing | exempt; unencrypted-clear branch deleted |
| guest send (`guest_ws.go`) | mirrors send | exempt |
| attachments (`attachments_http.go`; store CHECK `≥ 1`) | per-blob version | 0-allowed via migration; key rides the envelope |
| history/thread/summary paths | pass version through | pass 0; clients dispatch on the suite byte |
| wire fields | required | retained for legacy; receipt-metadata-only for suite 2 |

## A.8 Costs and accepted residuals

Per-message fixed overhead `63 + N×108` bytes beyond the message
ciphertext — the 35-byte header (`1 + 32 + 2`), the 12-byte body
nonce, the 16-byte GCM tag, plus 108 per flap (~6.8 KiB at N = 64);
N DHs at send, one DH + one HMAC at receive; hard cap N = 64
communicated once. "Authenticated for you" — no transferable proof.
**No forward secrecy, no PCS** — static-key compromise plus recorded
ciphertexts recovers old message keys via any flap, self-flap
included. The two static-key AEAD domains — `K_wrap` (voice signals)
and `K_history` (grant chunks) — use random 96-bit nonces under
long-lived keys, which NIST SP 800-38D bounds at 2³² invocations per
key; unreachable at chalk scale, and stated here so the bound is a
frozen fact rather than folklore.

| Residual | Treatment |
|---|---|
| TOFU first fetch | automatic default; optional picture-word upgrade; loud only on key change |
| Withheld cert / stale view | no freeze; per-sender scope; unbounded staleness stated |
| Conversion TOFU | one signed manifest binds the claim; poisoned-roster residual stated |
| Democratic tallies | authorized-member attestation to a server-reported outcome |
| Deniability | "authenticated for you"; no moderator-verifiable evidence |
| No FS / PCS | stated, accepted |
| Key-compromise impersonation | the MACs are static-static, so compromise of a recipient's X25519 key lets its holder impersonate **every** sender to that recipient until the identity is replaced — the authenticity face of "the sender or the recipient produced it", distinct from the no-FS/PCS row's confidentiality loss; stated, accepted. **Compromise recovery requires identity replacement** — rotating passwords or sessions repairs nothing here (the R11 review's operational note). For non-owner members that is §A.4's remove + re-admit transition binding the new fingerprint; **because the owner's fingerprint is part of the immutable anchor, owner identity replacement requires channel recreation in this phase** (P83-A-R12-02) |
| Fresh device, no backup | no legacy-key substitution ever (no-suite-1); but conversion is TOFU — a poisoned manifest can include a decrypting principal on that fresh view; backup restores protection; recreation for high assurance |
| Room size | hard cap 64 at member-add; over-limit channels resolved at migration; the concurrent-mint race past the cap resolves by §A.5's deterministic shed |
| Flagged-history path choice | the server picks live vs backfill, so an injection can present as `former-member` instead of the alarm; it can never reach member assurance (§A.5) |
| Guest identity = link possession | the guest keypair is a pure function of the fragment secret — every link holder, the minting owner included, is the same cryptographic principal; consistent with "authenticated for you" plus the guest label |
| `era_enforced` withheld | a server advertising `era_enforced = false` forever holds build-F clients read-only — denial only (no-suite-1 means no downgrade), visible in the §A.9 banner |
| Backup generation rollback | closed by `repack_seq` for devices with prior state; a fresh device cannot distinguish a complete older generation — inside the fresh-device residual |
| Control-plane equivocation | a malicious server can serve a **zero-state fresh device** a concealed control branch — a removed insider's post-removal mint on a hidden fork (the R14 attack). §A.4's in-band witness bounds it: the false universe survives only while the victim receives *no* authenticated object sealed past the concealed artifact — every post-removal message, edit, reaction, backfill page and grant from any honest member exposes it as surfaced fork evidence — so sustaining it is a permanent total partition from honest traffic, denial-class and loud in any live channel. Prevention *before* first honest contact is impossible for a zero-state device (the server is its only window); stated, accepted |
| No per-message roster commitment | a recipient can verify only its **own** flap (the other flaps' recipient ids are visible, their contents unverifiable), so a malicious **sender** — not just the server — can hand Bob and Carol disjoint flap sets for the "same" message, or exclude one member. With the server choosing delivery it is undetectable; against an honest broadcast the excluded view gets at most an unattributable `mismatch` artifact. Detection would take cross-recipient comparison — a transcript, the design this phase retired — and a sender-signed roster commitment would be transferable proof, un-doing deniability; accepted. Do not over-read "authenticated for you" as "everyone saw this" |

**Audit coverage:** C-01 — no server-substitutable group key for fanout
traffic; membership validated against a signed authority root **at both
flap emission and message acceptance** (§A.5 — removal is two-sided:
the omit latch stops disclosure *to* a departed member, the
sender-acceptance rule stops authenticated speech *from* one); closure
conditional by mode (dictator cryptographic / democratic attested) and
identity assurance; the stale-view, conversion-TOFU and
no-backup-fresh-device residuals stated. H-01 — live suite-2 objects
after admission, against a pinned sender whose membership is re-checked
at acceptance; granted and legacy history carry their own labelled
scopes. L-01 — out of scope, separate work.

## A.9 Dark development, Gate F, and mixed clients (P83-A-R2-07)

Slices A-1 … A-8 land dark (build-time flag; servers may accept early).
**Gate F is one atomic client release** activating certs + gating +
anchors + history + adoption + assurance UI together.

**The mixed-client boundary, defined:** the hello frame gains the
client's protocol era; the welcome advertises the server's required era.
At Gate F: a pre-F session receives a controlled
`client_upgrade_required` before any fanout delivery or send attempt;
the SPA preserves the composer draft, reloads once, reconnects, and
resumes.

**The cutover is a durable epoch with an instance-ack barrier
(P83-A-R4-05)** — presence rows are per-device, era-less and overwritten
on reconnect, so they cannot represent an old and a new tab on one
device; presence stays UI-only and is **never load-bearing here**:

- **one durable row** holds the required era — a database row, not a
  `CHALK_*` env var, precisely because it must be one value for the
  whole cluster and survive every restart. **The raise is coupled to
  deployment (P83-A-R7-01)**: a build-F `chalkd` raises the row to its
  own era at startup — idempotent compare-and-set, never lowered — so
  no manual step stands between the weekly automatic update and a
  sendable client. The seventh review's interregnum was exactly that
  step: with a deliberate `chalkctl fanout gate-f` flip, the update
  timer could ship build F overnight and hold every channel read-only
  until an operator woke up, since a build-F client may emit neither
  suite until enforcement. `chalkctl fanout status` reports epoch,
  acks and barrier; there is no flip left to forget;
- every `chalkd` instance records each connection's era at hello **in
  its own connection table** and enforces the epoch at all three gates —
  hello admission, send accept, fanout delivery — per frame, from its
  own memory: no cross-instance query is on any hot path;
- instances learn a flip by pubsub *and* re-read the epoch on their
  existing instance-heartbeat interval, so a dropped notification delays
  enforcement by at most one heartbeat, never indefinitely;
- the instance row (already heartbeat-maintained, already reaped when
  stale) gains an `acked_era` column, set when the instance has
  observed the epoch and upgraded or disconnected every pre-F session it
  owns. **The barrier: the epoch is *enforced* only when every live
  instance row carries `acked_era ≥` the epoch** — computed in one
  transaction over rows with fresh heartbeats;
- **the ack is a renewable lease with local self-fencing
  (P83-A-F5-03).** An expired row is *not* proof of a dead process —
  the sixth revision's premise ("its sockets die with their reaped
  row") contradicted the runtime it ships in: today's heartbeat loop
  deliberately survives a reaping — it logs, re-registers and
  re-asserts presence for every connection it still holds
  (`HeartbeatLoop` / `reassertLocalPresence`) — so a process whose
  database path fails can keep sockets and pubsub delivery alive long
  after its row is gone, and deleting a row kills no sockets.
  Therefore the safety comes from the process fencing itself, not
  from the row expiring:
  - an instance renews `acked_era` with its heartbeat and tracks the
    last renewal it has **confirmed** (the write returned);
  - its fencing deadline is frozen **shorter than the janitor's
    stale-row threshold**: when the last confirmed renewal is older
    than the deadline, the instance must assume its row may already
    be excluded, and **self-fences locally, before the barrier can
    advance without it** — it closes the three gates from its own
    memory (hello admission, send acceptance, fanout delivery), then
    disconnects or upgrades the sessions it holds;
  - fencing clears only forward: re-read the durable epoch, re-check
    every remaining connection's era, re-register, confirm a renewal —
    then the gates reopen. The reap-and-re-register reclaim path
    re-enters through this same sequence;
  - users on a fenced instance see this section's banner and the
    draft-preserving path, never an error; and a healthy control
    plane never fences — it takes a lease that cannot confirm writes
    for a full deadline, exactly the state in which the old premise
    was unsound;
- **conversion and fanout emission begin only behind the barrier**: the
  welcome advertises `era` plus `era_enforced`, and a build-F client
  neither converts nor emits suite 2 until the latter is true — staleness
  can therefore only *delay* the cutover, never admit a mixed-era
  delivery, because the instance that would deliver to a pre-F tab has,
  by acking, already upgraded or disconnected that tab;
- **the interregnum is frozen: bounded, visible, self-resolving.**
  Between the build-F bundle reaching a device and `era_enforced`
  turning true, the client can emit neither suite — by design, and
  briefly: with the startup raise the window is one rolling deploy
  plus at most one heartbeat (on the single-instance deployments chalk
  targets, one restart). During it the client shows one banner —
  *"Server update in progress — you can read; sending resumes
  automatically"* — and resumes off the welcome's `era_enforced`
  alone: no user action, no reload beyond this section's own upgrade
  path. A server that advertises `era_enforced = false` forever is the
  stated §A.8 denial residual — read-only, visibly, never a
  downgrade; and
- the acceptance test is explicitly hostile: two instances, an old and a
  new tab on one device (drafts surviving), a **dropped pubsub
  notification**, an **instance crash and reclaim** mid-cutover, a
  **partitioned lease** — the heartbeat/database path down while the
  process, its sockets and pubsub delivery all stay live, expected
  result: local self-fencing *before* the cluster barrier advances
  (P83-A-F5-03) — and an
  **unattended timer-driven update** — the deploy completes with no
  operator present and sending resumes on its own.

A brief software-update boundary, not an ongoing roadblock.

The Gate-F threat-model move (slice A-9) includes one scale sentence,
frozen here so it cannot drift: *"Group messaging is designed for at
most 64 participants per channel (members plus active guests); larger
rooms are out of scope by construction — a different message layer,
not a larger cap."*

## A.10 Slices

| Slice | Content (dark until Gate F) |
|---|---|
| A-1 | Pairwise HKDF tree (incl. `K_history`); flaps; HMAC tags; frozen parser + full vectors; WebCrypto disposal rules |
| A-2 | Anchors (converter/owner split) + manifest + `manifest_admit_ref` + complete policy artifacts + membership/guest certificates (`lookup16`, expiry rules): canonicals (`sig64`/`gov_record` conventions + mutation vectors), pure state machine, server tables (per-channel anchor CAS; `(channel,target,n)` and `(channel,p)` idempotency), rollback latches, policy-fork behavior + the monotonic removal latch (the `era` byte frozen at 1 — no door this phase, P83-A-F5-01); **the membership-control chain** (`prev_control_head`, the per-channel CAS head, control-order validation, the control floor — P83-A-F6-01); the one `member_state` module with the split `authorized_fp_current`/`authorized_fp_at` resolvers and its reference-model vectors (P83-A-R11-01/02/03, P83-A-R12-01/02); the `(user_id, ed25519_fp)` historical identity fetch |
| A-3 | The §A.3 canonical envelope, exactly as frozen in this plan (P83-A-F5-04 — encoders, total parser, the six adaptations incl. `actor_admit_ref`, the uniform replay fields and the gossiped control head, full vectors); verify policy; typed results incl. `granted` and `former-identity` |
| A-4 | Suite-2 send/receive; self-flap; the sender-acceptance rule (`unauthorized-sender`/`former-member`/`former-identity`, the live/backfill boundary, canonical-only sender provenance, directional assurance) consuming §A.4's one predicate and identity binding (`identity-mismatch` — P83-A-R11-01/02); the gossip-head cross-check (P83-A-R14-01) + its vectors incl. the litmus vector; the first-seen replay rule; `key_version` exemptions per inventory |
| A-5 | Edits, reactions (sealed clear), attachments-in-envelope, voice pairwise sealing |
| A-6 | Guests: `0x04` fragment form, guest certs, fragment-anchored verification; the atomic mint/revoke wire (advertised caps, absolute signed expiry, one-transaction storage, idempotent retry); cap accounting at mint + the deterministic overflow shed |
| A-7 | Grantor-attested history: grant wire (incl. `grantor_admit_ref` — P83-A-R13-02 — and the gossip head — R14-01), storage/quota/expiry, auto-grant + paging + knob, `granted` UI |
| A-8 | Adoption state machine (restore/verify/convert/read-only); the client-minted-ID creation wire (anchor + manifest in `create_channel`, one-transaction insert, idempotent retry, pending-op records, the DM rule); `channel_security_enc` backup (133-byte records incl. the control floor, immutable per-generation pages + the conditional commit head — P83-A-F6-04 — the `repack_seq` floor, anchor-keyed field-wise merge, rotation rekey, the five concurrency tests); read-only legacy rendering; era capability + `client_upgrade_required` |
| A-9 | **Gate F**: the required-era epoch raised at build-F startup + instance-ack barrier (`acked_era` as a renewable lease with local self-fencing — P83-A-F5-03 — the interregnum banner, the hostile two-instance + partitioned-lease test); emission on; conversion rollout; over-limit handling; `CHALK_FAN_REQUIRED` + `chalkctl fanout status`; threat-model staging move (incl. the frozen 64-participant sentence) |
| A-10 | Legacy retirement: wrapsig secure default; cert-gated legacy reshares; pre-F sunset |

---

# The decision (2026-08-08)

Envelope fanout is the phase-83 plan. Three designs were rejected, all
preserved in git history — the transcript plan is this path's content
before this date; the other two lived in `PHASE-83-MSGSIG-ALTERNATIVE.md`
(this file's previous name) until the decision:

- **The transcript design** (six revisions, Gate 0 never passed): a
  signed message envelope plus an authenticated channel-state transcript
  with a creator-anchored key epoch. Rejected for its user-felt costs —
  the departure freeze above all — which five hardening reviews reduced
  but could not remove while the creator's crypto role stayed
  load-bearing.
- **Option B — first-responder rotation** (never reviewed): a nine-point
  surgical delta to the transcript design letting any current member
  rotate after a departure — "five reviews of hardening, one row
  changed". Its premise retired with that plan.
- **Per-sender streams** (commit `fd9d0b6`, superseded draft): one
  hash-ratcheted, identity-signed outbound stream per (member, device,
  channel). More moving parts than fanout, non-deniable; in git history
  if reconsidered.

The comparison that decided it:

| | Transcript (retired) | B: first-responder (rejected) | Envelope fanout (this plan) |
|---|---|---|---|
| Departure freeze | until creator acts | seconds | none |
| Creator crypto role | load-bearing | none | anchor signer only (once) |
| Review state | 6 revisions, Gate 0 never passed | unreviewed delta | 10 reads + six external reviews; passed at the sixth revision, **re-opened — re-review of the seventh–twelfth delta pending** |
| Membership | transcript (fork proofs) | transcript (fork proofs) | anchors + policy chain + per-target chains, rollback latch |
| Deniability | no | no | **yes** ("authenticated for you") |
| New-member history | as today | as today | grantor-attested (explicit, labelled) |
| Per-message cost | 1 sign / 1 verify | 1 sign / 1 verify | N DH+HMAC / 1 DH+1 HMAC, N ≤ 64 |
| Timestamps / edit history | sender clock / retained | sender clock / retained | receipt time / not retained |
| Fresh-device downgrade | per-device adoption | per-device adoption | **no-suite-1 rule** + backup; residuals stated |

The costs in the last three rows are accepted deliberately (§A.8): they
buy the only deniable, freeze-free, coordinator-free design on the
table. Gate 0 passed at the sixth revision after eight review rounds;
five external reviews re-opened and held it open (2026-08-09) — the
fifth independent review's five blockers (→ seventh revision), the R11
review's two, the acceptance predicate's manifest arm and the unfrozen
identity binding (→ eighth), the R12 delta review's two in that
revision's own replacement text, the temporally ambiguous resolver and
the impossible owner replacement (→ ninth), the R13 delta review's
two, the owner's unresolvable zero ref and the missing historical
identity references in messages and grants (→ tenth), and the sixth
independent review's four — above all the cross-target ordering hole
answered by the membership-control chain, plus the replay-field gap
and the backup's non-convergent commit (→ eleventh; its other two
findings had already converged with R13's fixes), and the R14 delta
review's one Critical — the control chain's CAS trusted the server as
sequencer, answered by the in-band gossip witness and the stated
zero-state residual (→ twelfth). The accumulated delta awaits
independent re-review before any slice lands.

## Prior-art sources

- WhatsApp Encryption Overview: <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay: <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec: <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Nebuchadnezzar: <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420: <https://datatracker.ietf.org/doc/html/rfc9420>
- Signal Private Group System: <https://eprint.iacr.org/2019/1416.pdf>
- iMessage security overview: <https://support.apple.com/guide/security/imessage-security-overview-secd9764312f/web>
- Signal Double Ratchet (why no FS is claimed): <https://signal.org/docs/specifications/doubleratchet/>
- W3C WebCrypto (key-disposal limits): <https://www.w3.org/TR/WebCryptoAPI/#security-developers>

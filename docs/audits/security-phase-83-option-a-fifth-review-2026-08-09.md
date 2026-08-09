# Fifth Independent Security and Usability Review of Phase 83 Option A

**Review date:** 2026-08-09

**Selected design reviewed:** envelope fanout in the canonical
[`phases/PHASE-83-MSGSIG.md`](../phases/PHASE-83-MSGSIG.md)

**Reviewed plan commit:** `2732a94c47c54e1a24a1028393ea5395b7938e22`

**Previous independently reviewed plan commit:**
`eb1ee87321cb510c24d33bec77aa5db95d9b5ddc`

**Previous review:**
`security-phase-83-option-a-fourth-review-2026-08-08.md` (external series;
not committed to this repository)

**Related audits:** `security-audit-2026-08-03.md` and
`security-audit-follow-up-2026-08-05.md` (external series; not committed to
this repository — the phase-81 audit and its follow-up they correspond to are
summarized in [`open-items.md`](../open-items.md) and the plan's own record)

**Review scope:** the selected envelope-fanout design at current HEAD. The
retired transcript, first-responder and per-sender-stream designs were not
re-reviewed.

The plan records additional author-side reviews and reads using overlapping
round numbers. "Fifth independent review" here means the fifth review in this
repository-level Option A review series, following the four review files in
`docs/`; it does not adopt the plan's internal review count as evidence.

## Executive summary

Selecting envelope fanout and making it the canonical Phase 83 plan is a
defensible product and security decision. It remains the only considered
design that simultaneously keeps normal sending asynchronous, avoids a
creator-dependent departure freeze, and retains deniable per-recipient
authentication. Moving the selected design to `PHASE-83-MSGSIG.md` also removes
the ambiguity about which design implementers should follow.

The new revision materially answers the fourth review:

- backup records are merged within an anchor and different anchors always
  conflict;
- backup pages now use double-buffered generations and a committed page-hash
  manifest;
- guest expiry is client-selected, signed, transactionally stored and
  idempotently retried;
- observed removals stay omitted across later policy-fork discovery;
- the rollout uses a durable required-era epoch and instance acknowledgements;
- receive-side membership is now checked, preventing a removed member's
  long-lived pairwise key from retaining member assurance; and
- history, guest-cap and residual-risk language is much more complete.

Nevertheless, the current `Gate 0 passed` claim is premature. Five
load-bearing gaps remain:

1. fork recovery is explicitly left at sketch level, is ambiguous when
   conversion forks assert different owners, and lets the owner replace a
   democratic roster without governance authorization;
2. a shed sender cannot satisfy both the mandatory self-flap and the frozen
   64-recipient effective roster;
3. the multi-instance barrier treats an expired heartbeat row as proof that a
   process cannot still deliver, contrary to the current runtime's deliberate
   keep-connections-alive behavior;
4. the authenticated message canonical is absent from the selected document
   and delegated to unspecified git history and a later implementation slice;
   and
5. scalar per-record backup revisions do not converge concurrent same-anchor
   updates from two devices and can turn an ordinary sync race into a persistent
   security warning.

All five can be fixed without mandatory identity verification, coordinator
round trips on send, or a channel-wide freeze. The only composer pause proposed
below is for the exceptional participant who is itself outside the 64-person
effective roster, and it clears automatically when a slot opens.

**Disposition: retain the selected envelope-fanout plan, but Gate 0 does not
pass at `2732a94c`. Complete one focused state-machine revision before starting
implementation.**

## Status of the fourth-review findings

| Finding | Fifth-review status | Assessment |
|---|---|---|
| P83-A-R4-01 | **Resolved** | Merge is keyed by `(channel, anchor_hash)`; `policy_p` no longer orders roots, and different anchors always survive as a surfaced conflict. |
| P83-A-R4-02 | **Resolved** | Inactive-namespace writes, per-generation IDs, committed sealed-page hashes and a commit-last switch prevent authenticated mixed generations. |
| P83-A-R4-03 | **Resolved** | The client signs an absolute expiry inside advertised caps; the server never clamps and atomically stores invite plus certificate. Revoke and retry are also coupled. |
| P83-A-R4-04 | **Resolved** | Admissions intersect and removals union across policy-fork discovery; a verified omit latch cannot silently reopen. |
| P83-A-R4-05 | **Partially resolved; one blocking lease gap** | The durable epoch, per-connection era, three enforcement gates and instance acknowledgements are the right architecture. Expiring an instance row is not yet proof that its still-running process has self-fenced. |
| Canonical completion items | **Mostly resolved** | Signature/governance bytes, history quotas, tombstones, guests, grant subtypes and rollover presentation are specified. The message canonical and successor-anchor canonical remain outside the frozen plan. |

## Blocking findings

The identifiers below use `P83-A-F5-*` to avoid colliding with the plan's own
`R5`–`R7` numbering.

### P83-A-F5-01 — The fork "era door" is an incomplete and overpowered authority transition

**Severity:** Critical for channel governance and fork recovery

**Disposition:** Blocking

The plan introduces an owner-signed successor anchor at `era + 1`, referencing
both fork heads and carrying a fresh manifest. It then explicitly leaves that
canonical at sketch level for slice A-2
([plan lines 471–482](../phases/PHASE-83-MSGSIG.md#L471-L482)).

This is not merely serialization detail. It leaves two authority questions
unanswered:

1. **A conversion fork may not have one owner.** Two competing conversion
   anchors can assert different owner IDs or fingerprints. "The anchor's owner
   slot" therefore does not identify one signer acceptable to clients holding
   both roots. Accepting either branch's claimed owner lets the chosen branch
   resolve its own conflict.
2. **A fresh manifest bypasses democratic governance.** In democratic mode,
   membership additions and removals require proposals; the current server
   explicitly limits proposals to democratic channels
   ([`governance_ws.go` lines 210–252](../../internal/server/governance_ws.go#L210-L252)).
   The era door instead lets the fixed owner unilaterally choose an entirely
   fresh roster after surfacing a policy fork. That restores dictator-like
   membership power precisely when governance evidence is ambiguous.

The rule also lacks exact signed bytes, monotonic-era validation, old/new mode
binding and the relationship between the new manifest and the conservative
pre-fork roster. A security-root transition cannot be deferred to an
implementation slice while the design gate is marked complete.

**Required correction:**

- freeze the successor canonical in the plan, including channel, old era, new
  era, previous anchor hash, ordered fork-head hashes, owner identity, mode and
  fresh manifest hash;
- for a policy fork, require the successor to preserve the last common policy
  and conservative effective roster; any membership delta still needs the
  normal signed certificate and governance authorization;
- for a conversion fork, permit automatic successor recovery only when every
  referenced anchor binds the same owner ID and fingerprint and that owner
  signs the successor;
- when fork roots disagree about owner, keep that channel read-only and use
  explicit high-assurance recreation or optional manual verification — do not
  select an owner on the server's behalf; and
- accept only exactly `current_era + 1`, bind the full predecessor set, and
  persist the era latch against rollback.

An even smaller safe choice is to remove the era door from this phase and keep
recreation as the sole rare-fork exit. Forks are exceptional and already
surfaced, so this does not burden everyday messaging.

### P83-A-F5-02 — A shed sender cannot form a valid 64-flap message

**Severity:** High protocol contradiction and scoped usability failure

**Disposition:** Blocking cap-overflow state machine

The suite-2 parser requires exactly one self-flap and at most 64 total flaps
([plan lines 320–338](../phases/PHASE-83-MSGSIG.md#L320-L338)). On concurrent
admission overflow, the plan computes an effective roster of exactly 64,
declares that a shed target receives no flaps, and still says the shed target's
messages pass receive-side membership acceptance
([plan lines 604–641](../phases/PHASE-83-MSGSIG.md#L604-L641)).

When the shed target is the sender, no valid official-client send is defined:

- omitting its self-flap makes the envelope malformed;
- adding itself to all 64 effective recipients creates 65 flaps; and
- replacing one effective recipient with itself silently omits a participant
  whom the frozen roster says must receive the message.

Receive-side acceptance of an already formed message does not solve how an
honest shed client forms that message.

**Required correction:** freeze the honest-client behavior explicitly:

- a participant who is itself shed cannot originate suite-2 messages while
  shed;
- keep its draft and show the existing *"admitted — waiting for room"* state at
  the composer;
- reactivate and send normally as soon as deterministic roster recomputation
  gives it a slot; and
- continue accepting its validly tagged incoming artifacts under the existing
  membership rule, so a malicious server cannot forge a removal merely from
  shed status.

Also state unambiguously whether "guests before members, descending hash" names
the records removed first or retained first. This is a rare, target-local cap
race — not a channel-wide departure freeze — and is the honest usability
tradeoff for a hard 64-flap format.

### P83-A-F5-03 — Gate F needs process self-fencing, not an expired-row assumption

**Severity:** High mixed-era rollout correctness

**Disposition:** Blocking distributed cutover invariant

The revised Gate F is much stronger than best-effort presence aggregation. It
uses a durable required era, local per-connection enforcement, and an
`acked_era` barrier. However, it excludes a stale instance row on the premise
that an instance unable to heartbeat is unable to deliver and that its sockets
die with the reaped row
([plan lines 1209–1217](../phases/PHASE-83-MSGSIG.md#L1209-L1217)).

That premise contradicts current runtime behavior. The instance heartbeat loop
logs errors, re-registers, and deliberately keeps connected clients alive
([`presence/loops.go` lines 64–105](../../internal/presence/loops.go#L64-L105)).
If another janitor reaps the row, the server recreates presence for the
connections it still holds
([`ws.go` lines 1214–1223](../../internal/server/ws.go#L1214-L1223)). A heartbeat
goroutine, database path or lease update can fail while the WebSocket process
and a delivery/pubsub path remain alive long enough to violate the barrier.
Deleting a database row does not kill operating-system sockets.

**Required correction:** make `acked_era` a renewable safety lease with local
self-fencing:

- an instance may acknowledge an era only after all of its connections meet
  it;
- it must renew that acknowledgement before a deadline shorter than the
  barrier's stale-row exclusion threshold;
- if renewal cannot be confirmed by the deadline, the process locally disables
  hello admission, send acceptance and fanout delivery, then closes or upgrades
  its sockets before other instances may exclude its row; and
- recovery re-reads the durable epoch and repeats the connection-era check
  before any gate reopens.

Add an acceptance case where only the heartbeat/lease database path is
partitioned while the process, sockets and pubsub delivery remain live. The
expected result is local self-fencing before the cluster barrier advances.

Users see the same draft-preserving update banner. Self-fencing activates only
when the control-plane lease is genuinely unsafe; it does not add a normal send
round trip or operator step.

### P83-A-F5-04 — The selected plan does not contain its authenticated message canonical

**Severity:** High for H-01 and interoperable implementation

**Disposition:** Blocking protocol completeness

The plan says the body plaintext inherits typed canonical envelopes from the
retired transcript plan, that the exact bytes exist somewhere in git history,
and that slice A-3 will "re-freeze" them later
([plan lines 348–355](../phases/PHASE-83-MSGSIG.md#L348-L355)). The retired design
has been removed from the working tree, and no commit/path is a normative part
of the wire definition.

Those bytes are the data authenticated by every per-recipient MAC. They define
sender identity, channel binding, replay identity, parent/thread relationships,
edits, reactions and attachment commitments — the substance of H-01. Two
implementers can follow the selected document and still produce incompatible
or differently authenticated objects.

**Required correction:** copy the complete canonical definitions into the
selected plan before implementation:

- exact domain/type bytes for messages, edits and reactions;
- every fixed-width and length-prefixed field in order;
- the definitions and permitted values of `writer_scope` and
  `client_msg_id`;
- parent, original-object and attachment bindings;
- absence/optional-field encoding and total parser bounds; and
- cross-object, cross-channel, replay, trailing-byte and type-confusion vectors.

Do not rely on an unspecified historical revision or allow A-3 to make a new
protocol decision after Gate 0. Reusing the already reviewed bytes is fine; the
canonical selected document simply needs to contain them.

### P83-A-F5-05 — Scalar backup `rev` does not converge concurrent same-anchor updates

**Severity:** High for multi-device usability and deterministic recovery

**Disposition:** Blocking merge-state completion

The backup assigns an identity-local scalar `rev` per `(channel, anchor_hash)`.
For equal revisions with different bytes, it retains both records and surfaces
a "genuine same-identity write race"
([plan lines 964–976](../phases/PHASE-83-MSGSIG.md#L964-L976),
[1030–1047](../phases/PHASE-83-MSGSIG.md#L1030-L1047)).

Two devices sharing one identity can routinely start from revision N and write
different legitimate revision N+1 states — for example, one advances the policy
latch while the other records a leave/tombstone or conflict observation. This
is not an authority fork. The plan neither defines a field-wise join nor says
how the next repack collapses both records into one revision N+2. Keeping both
can make benign multi-device activity look like a security conflict forever;
choosing either wholesale can lose a monotonic latch.

The separate `repack_seq` rule resolves which complete backup generation wins.
It does not merge two conflicting records within that generation.

**Required correction:** define a same-anchor join that preserves security
facts without warning on an ordinary sync race:

- adoption and conflict-observed flags join monotonically;
- verified policy heads use ancestry: the descendant wins, while a genuine
  same-sequence policy fork retains both as actual fork evidence;
- leave/tombstone UI state is derived from the verified membership/leave chain
  or uses an explicitly reversible UI field, never a whole-record last writer;
- rollback floors join by maximum only after their referenced chains verify;
  and
- the merged result is emitted as one record at `max(rev) + 1`.

If one fixed record cannot represent genuine policy-fork heads, use a bounded
set keyed by policy hash rather than overloading duplicate whole records. A
device identifier can break serialization ties, but must not be used as LWW for
security latches.

This avoids false alarms and manual recovery in ordinary multi-device use while
retaining loud treatment for real anchor or policy forks.

## Non-blocking completion items

### Persist the complete create-channel retry request

The pending operation is described as `id + anchor + adoption intent`, but an
idempotent retry also needs the exact manifest and other creation fields whose
hash the anchor binds
([plan lines 927–940](../phases/PHASE-83-MSGSIG.md#L927-L940)). Persist the complete
canonical request or enough immutable bytes to reproduce it after a reload.
This keeps lost acknowledgements invisible to users.

### Restore or remove the referenced audit artifacts

The plan links
`docs/audits/security-phase-83-seventh-review-2026-08-08.md` and
`security-phase-83-eighth-review-2026-08-08.md`, but neither file exists at
current HEAD; both were deleted in commit `7cc46e5`. Restore them if they are
part of the Gate 0 evidence, or remove the links and keep only the disposition
summary. A security-gate status should be auditable from the checked-out tree.

### Reset the document status until the changed text is re-reviewed

The header and decision table currently say Gate 0 passed even though later
normative changes explicitly reopened portions of the gate and the findings
above remain. Mark Gate 0 pending until the successor anchor, shed-sender rule,
self-fencing lease, message canonical and same-anchor merge are frozen and
re-reviewed.

## Security and usability assessment

| Property | Fifth-review assessment |
|---|---|
| Design selection | **Accepted:** envelope fanout is the strongest usability/security balance among the considered designs. |
| Normal sending | **Good:** one action, asynchronous, no coordinator or global serialization. |
| Removal behavior | **Good:** no channel freeze; send-side omission and receive-side membership checks are both present. |
| Membership authority | **Good on the normal path; fork successor is blocking.** |
| Message authenticity (H-01) | **Sound construction, incomplete canonical document:** the per-recipient MAC design is credible, but exact authenticated object bytes must be present. |
| Fresh-device downgrade | **Accurately scoped:** no suite-1 origination; poisoned conversion remains a stated TOFU disclosure residual. |
| Guests | **Substantially resolved:** fragment era, signed expiry, atomic mint/revoke and historical labels are coherent. |
| History | **Accepted:** immediate grantor-attested history with explicit provenance and bounded storage. |
| Backup | **Generation-safe, but same-anchor concurrent record merge is incomplete.** |
| 64-participant cap | **Product scope accepted; shed-sender behavior is contradictory.** |
| Mixed-client rollout | **Strong architecture, missing stale-process self-fencing.** |
| FS / PCS | **Correctly out of scope and clearly stated.** |
| L-01 | **Out of scope; remains separate account-recovery work.** |

The remaining technical severity is **Critical** because the fork successor can
rewrite channel authority and the exact recovery authority is ambiguous. The
likelihood is low in ordinary trusted deployments because it requires a
surfaced fork, but severity describes impact, not probability. The Gate-F and
backup-race issues are more likely to appear as deployment or multi-device
usability failures than as confidentiality exploits.

For Chalk's common trusted friends-and-family deployment, the current system
can remain usable under its documented operator trust assumptions. Phase 83 is
specifically intended to strengthen guarantees against a compromised logical
server; its exceptional authority and restore paths must therefore be correct
before that stronger claim ships.

## Required focused revision

Before implementation:

1. freeze a governance-preserving successor-anchor protocol, or remove the era
   door and retain recreation for fork recovery;
2. define a shed participant as unable to originate while shed, with automatic
   draft-preserving reactivation;
3. add an era-ack lease and local process self-fencing before stale instances
   leave the Gate-F barrier;
4. place the complete message/edit/reaction canonical in the selected plan;
5. define a convergent field-wise join for equal-revision, same-anchor backup
   records; and
6. persist complete channel-create retries and repair the review-evidence links.

Do not add mandatory picture-word verification, all-senders-online history,
per-send server coordination, or a channel-wide composer freeze. The safe
failure modes remain rare and scoped: one conflicted channel, one shed
participant, or one self-fenced unhealthy instance.

## Verification performed

This review:

- compared the previous independently reviewed Option A revision at
  `eb1ee87321cb510c24d33bec77aa5db95d9b5ddc` with selected-plan HEAD
  `2732a94c47c54e1a24a1028393ea5395b7938e22`;
- confirmed `PHASE-83-MSGSIG-ALTERNATIVE.md` was removed and envelope fanout is
  now the canonical `PHASE-83-MSGSIG.md` design;
- reassessed all five fourth-review blockers and the completion items;
- reviewed the newly added sender-acceptance, overflow-shed, fork-recovery,
  backup-generation and Gate-F state machines;
- checked current governance behavior for democratic membership transitions;
- checked current instance-heartbeat, reaping and live-connection recovery
  behavior against the proposed Gate-F barrier;
- checked that the two audit artifacts referenced by the plan are absent at
  current HEAD; and
- ran `git diff --check` successfully on the reviewed phase-document changes.

No implementation tests were run. Phase 83 remains design-only; this is a
documentation/source-assisted protocol review.

## Verdict

The move to one selected plan is good, and envelope fanout remains the right
choice for Chalk's stated usability priorities. The author has closed the
fourth review's backup-generation, guest-lifecycle and removal-latch defects
and added important receive-side protection. Those improvements should all be
retained.

The remaining issues sit in exceptional paths, but exceptional cryptographic
authority and distributed-state paths still define the guarantee. They can be
fixed without making routine chat harder to use.

**Retain envelope fanout as Phase 83. Gate 0 does not pass at `2732a94c`;
complete the focused revision above and independently re-review that delta
before implementation.**

# Sixth Independent Security and Usability Review of Phase 83 Option A

**Review date:** 2026-08-09

**Selected design reviewed:** envelope fanout in the canonical
[`phases/PHASE-83-MSGSIG.md`](../phases/PHASE-83-MSGSIG.md)

**Reviewed plan commit:** `7dbdcb31b71f6fb40a389c326491ffcb4a46070f`

**Fifth-review plan commit:** `2732a94c47c54e1a24a1028393ea5395b7938e22`

**Previous review:**
[`security-phase-83-option-a-fifth-review-2026-08-09.md`](security-phase-83-option-a-fifth-review-2026-08-09.md)

**Related audits:** `security-audit-2026-08-03.md` and
`security-audit-follow-up-2026-08-05.md` (external series; not committed to
this repository)

**Scope:** the accumulated seventh-through-ninth revision delta after the fifth
independent review, plus a focused re-read of the membership, identity,
authenticated-object, backup and Gate-F state machines affected by that delta.
The retired transcript, first-responder and per-sender-stream designs were not
re-reviewed.

The plan also contains author-side R11 and R12 review artifacts. They were used
as change rationale, not as evidence that the resulting design is correct. This
review independently checked their replacement text against the current plan
and repository.

## Executive summary

The author made substantial, correct improvements. The fifth review's fork
door, shed-sender, Gate-F lease and missing-canonical findings are addressed in
the normative plan. The R11 correction also closes the removed-founding-member
receive bug, and the R12 split between current and historical identity
resolution is the right model for signed authority artifacts.

Envelope fanout therefore remains the preferred design. Its everyday behavior
is still strong: one-action asynchronous sends, no coordinator on the message
path, no departure freeze, automatic conversion, and target-local rather than
channel-wide failure handling.

Gate 0 nevertheless remains open. Four load-bearing issues remain:

1. per-target certificate chains still provide no authenticated order between
   one member's removal and a different target's admission; a removed member
   cooperating with a malicious server can exploit server-controlled first-seen
   order on a fresh/restored device to create a lasting unauthorized admission;
2. messages, edits, reactions and history grants do not carry the membership or
   fingerprint reference needed by the new historical-identity resolver, so
   legitimate pre-rotation objects fail after identity replacement and an
   unsafe fallback would restore retired-key impersonation;
3. edits and reactions do not contain the `writer_scope` and `client_msg_id`
   fields required by the plan's own replay identity, making the frozen H-01
   replay rule impossible to implement for two of the three object types; and
4. the field-wise backup join operates only after both records have been read,
   but the current preferences store is last-write-wins per key. Concurrent
   repacks can overwrite each other's inactive pages and commit, so a losing
   device's unique security state is not durably merged if it goes offline or
   dies.

These corrections do not require a per-message server round trip, mandatory
picture-word verification, all participants online, or a global composer
freeze. Membership transitions may be serialized as rare control-plane
operations while normal messages continue; historical identities can be
rendered with lower, honest assurance; and backup convergence can use a small
conditional commit or immutable per-device contributions.

**Disposition: retain envelope fanout, but Gate 0 does not pass at
`7dbdcb31`. Complete one more protocol-state revision and re-review it before
starting any Phase 83 slice.**

## Status of the fifth-review and later findings

| Finding | Sixth-review status | Assessment |
|---|---|---|
| P83-A-F5-01 | **Resolved** | The successor-anchor era door is removed. Era is fixed at 1 and recreation is the only fork exit in this phase. This is safer than shipping an under-specified authority-root transition. |
| P83-A-F5-02 | **Resolved** | A shed participant cannot originate while shed; its draft is retained and the composer reactivates automatically when a slot opens. This is a narrow, honest usability cost rather than a channel freeze. |
| P83-A-F5-03 | **Resolved in design** | `acked_era` is now a renewable lease with a local deadline shorter than stale-row exclusion, process self-fencing and a hostile partition test. Exact timing constants remain implementation work. |
| P83-A-F5-04 | **Partially resolved** | The complete message/edit/reaction canonical is now in the selected plan. The added text exposes a separate replay-identity contradiction for edits and reactions (F6-03). |
| P83-A-F5-05 | **Not fully resolved** | The field-wise record join is useful, but no storage-level convergence exists when two devices concurrently overwrite the same inactive namespace and commit key (F6-04). |
| P83-A-R11-01 | **Resolved** | One `member_state` predicate supersedes a manifest entry as soon as any verified chain exists. Removed founding members no longer pass the literal receive predicate forever. |
| P83-A-R11-02 | **Partially resolved** | Runtime keys are bound to the fingerprint authorized by membership. The current/historical split is correct for authority artifacts, but authenticated message and grant wires do not say which historical admission signed or sealed them (F6-02). |
| P83-A-R11-03 | **Resolved** | The plan requires one pure membership module and routes all listed consumers through it. |
| P83-A-R12-01 | **Resolved for authority artifacts; open for content objects** | `authorized_fp_at(actor_admit_ref)` plus fingerprint-keyed historical identity fetch repairs old membership/policy certificate verification. Messages and grants lack an equivalent reference (F6-02). |
| P83-A-R12-02 | **Resolved as a security scope decision** | Owner-key succession is not invented inside Phase 83. Channel recreation is cryptographically honest, but the product still needs an assisted break-glass workflow before owner identity replacement can be called usable. |

## Blocking findings

The identifiers below use `P83-A-F6-*` to avoid colliding with the plan's own
review numbering.

### P83-A-F6-01 — Per-target chains cannot order an actor's removal against a new target's admission

**Severity:** Critical confidentiality impact under the stated removed-member
plus malicious-server threat; blocking

The plan deliberately makes actor authority non-retroactive: a membership
certificate stays valid when its `actor_admit_ref` points to a state in which
the actor was admitted. That is necessary to preserve legitimate historical
actions. It then tries to prevent a removed actor from using that old
reference forever with a local first-seen rule: after a device has observed
Alice's removal, it rejects newly seen certificates that reference Alice's
superseded admission.

That rule protects an existing device which observed events in the honest
order. It does not protect a fresh or restored device, because the certificate
chains are independent per target and the server chooses their delivery order.

A concrete democratic-channel attack is:

1. Alice is admitted as A1 and later legitimately removed.
2. Alice retains her signing key, as the design already assumes for
   post-removal message injection.
3. Alice and a malicious server create a new admit certificate for a
   server-controlled target Mallory. It references Alice's old
   `actor_admit_ref`, the old democratic policy head and a server-attested
   `gov_record`.
4. A fresh/restored Carol has no backed-up membership heads — the plan
   explicitly excludes certificate heads from backup.
5. The server serves Mallory's certificate before Alice's removal. Alice is
   valid at the referenced admission state, so Carol accepts Mallory.
6. The server then serves Alice's removal. The observed-removal rule applies
   only to certificates not previously seen; Mallory's accepted admission
   survives and receives future flaps from Carol.

The result is content disclosure, not merely misleading UI or denial. It is
the cross-target version of the old R11 removed-member problem: the common
`member_state` predicate correctly determines Alice's current status, but the
protocol still cannot prove whether Alice signed Mallory's different target
chain before or after Alice was removed.

This also makes restore outcome depend on server-selected fetch order, which is
incompatible with the stated pure state-machine goal. Calling the condition a
stale-view residual is insufficient: a device can be shown both chains and
still reach different authority state solely from presentation order.

**Required correction:** add authenticated ordering for membership authority,
without putting ordinary messages behind it. Viable approaches include:

- a channel-wide membership-control log whose transitions link one verified
  head, while message sending remains independent and freeze-free;
- an equivalently signed state/checkpoint reference that makes the actor's
  membership current at the admission's exact control-plane position; or
- a conservative re-attestation scheme for restored devices, combined with an
  encrypted backup of accepted membership heads and removal latches.

Whichever mechanism is chosen must make full-state validation independent of
artifact fetch order, reject a certificate first created after its actor's
removal, preserve legitimate certificates accepted before removal, and state
the no-backup fresh-device residual precisely. Serializing the uncommon
membership-change path is compatible with high usability; serializing every
message or freezing the channel is not required.

Required vectors: Bob-admit then Alice-removal in both fetch orders; forged
Mallory-admit after Alice-removal served before and after that removal; restore
with backed-up heads; and fresh device without backup.

### P83-A-F6-02 — Historical identity resolution has no selector in messages or grants

**Severity:** High authenticity and restore-usability contradiction; blocking

The R12 repair correctly defines two resolvers: `authorized_fp_current`
for live traffic and `authorized_fp_at` for historical authority artifacts.
Membership, guest and policy certificates carry `actor_admit_ref`, so the
second resolver has an authenticated temporal selector. Messages, edits,
reactions and history grants do not.

Consider a legitimate message from Alice identity A1, first fetched after
Alice was removed and re-admitted as A2. The canonical contains Alice's UUID
but no sender admission reference or fingerprint. The receive rule must
therefore use `authorized_fp_current(Alice) = A2`, derive
`K_mac(A2→recipient)`, and reject A1's valid tag as a forgery/mismatch. A fresh
or restored device falsely loses authentication for all pre-rotation A1
objects it had not already accepted.

Blindly trying every retired identity is unsafe. A compromised A1 key could
then authenticate newly injected objects after A2 became current. With no
authenticated admission reference, the receiver cannot distinguish an old A1
object from a new injection made with A1.

History grants have the same gap. Their canonical names the grantor UUID and
the grantee's admission, but not the grantor's admission. A grant sealed
under `K_history(A1→B)` cannot be safely selected or opened after A2 becomes
current. The plan currently classifies history-grant acceptance as current
traffic, which turns an ordinary delayed fetch around identity replacement
into unexplained history loss.

**Required correction:** bind the temporal identity in every authenticated
content object:

- add `sender_admit_ref` (or an equally strong authenticated
  membership/fingerprint reference) to message, edit and reaction canonicals;
- add `grantor_admit_ref` to history and legacy-key grants;
- resolve the MAC/grant key through `authorized_fp_at(ref)`;
- grant full current-member assurance only when the referenced admission is the
  current effective admission; and
- render a valid retired-admission object first fetched later as a distinct
  lower-assurance `former-identity` result, analogous to `former-member`, never
  as current assurance and never as an attributed forgery.

Objects already accepted locally under A1 keep their assurance, as the plan
already requires. New objects made with a retired key can at most obtain the
loud, non-current historical label. This preserves readable history without
silently restoring a compromised key's current authority.

Also specify backup re-encryption when the local identity scalar changes. The
channel-security backup key is derived from that scalar; remove plus
re-admit alone does not migrate encrypted security state to the new identity.

### P83-A-F6-03 — Edits and reactions cannot satisfy the frozen replay identity

**Severity:** High H-01 protocol-completeness contradiction; blocking

The plan defines every suite-2 object's durable identity and replay key as
`(sender_user_id, writer_scope, client_msg_id)`, and says later envelopes with
the same triple are duplicates.

Only a `0x01` message contains `writer_scope` and `client_msg_id`. The frozen
`0x02` edit contains the sender, target, previous revision hash, timestamp and
replacement content; the `0x03` reaction set contains the actor, target,
previous-set hash, timestamp and emoji set. Neither contains the two fields the
universal replay rule requires. Reactions also name `actor_user_id`, while the
declared replay tuple assumes `sender_user_id`.

An implementation cannot follow both normative sections. It must either invent
wire fields after Gate 0, silently scope the replay rule to messages, or choose
an undocumented content-hash identity for edits and reactions. H-01 explicitly
requires replay context for all encrypted objects whose meaning depends on
server metadata; this is not an implementation detail.

**Required correction:** either add `writer_scope` plus a fresh
`client_object_id`/`client_msg_id` to edits and reactions and define their
idempotent acknowledgement behavior, or freeze explicit object-type-specific
identities. If `object_hash(canonical)` is the identity for edits/reactions,
state its first-seen and duplicate rules, observed-ancestry rollback behavior,
and optimistic retry semantics. Add replay-under-new-server-ID vectors for all
three types, not only messages.

### P83-A-F6-04 — The backup join does not converge concurrent commits

**Severity:** High multi-device recovery and usability; blocking

The new same-anchor field-wise join is correct once both candidate records are
available. It joins monotonic flags, derives tombstones, orders verified policy
heads by ancestry and emits `max(rev) + 1`.

The storage protocol does not guarantee that both candidates ever become
available. Two devices read commit sequence N, both select the same inactive
`a` or `b` namespace, both write pages for N+1, and both overwrite the one
`channel_security_commit` key. The current preference store is explicitly
last-write-wins per key
([`preferences.go` lines 7–9](../../internal/store/preferences.go#L7-L9)) and its
JSONB update replaces a supplied key wholesale
([`preferences.go` lines 46–68](../../internal/store/preferences.go#L46-L68)).
There is no compare-and-set on the old commit hash or sequence.

Consequences:

- page writes can interleave in the same inactive namespace; hash validation
  detects the torn generation but leaves only the previous generation remotely;
- if each page set is internally complete, the last commit wins wholesale and
  the other device's unique records are absent from the backup; and
- the claim that nothing is lost relies on the losing device remaining alive,
  observing the winner and repacking later. If it goes offline or dies after
  its acknowledged write is overwritten, its conflict observation, newer
  anchor or other security state is not durably merged.

That is the exact ordinary two-device race F5-05 asked the plan to close. A
record-level join cannot repair an update that the storage protocol discarded
before any reader saw it.

**Required correction:** freeze one honest-concurrency mechanism:

- a conditional commit endpoint accepting `expected_commit_hash` or
  `expected_repack_seq`, with losers re-reading, joining and retrying;
- immutable generation keys plus a small conditional head pointer; or
- bounded immutable per-device contributions that readers join before
  publishing a compacted generation.

The server-side condition is concurrency control, not cryptographic authority;
all pages and commits remain authenticated and rollback floors remain local.
A malicious server can still deny service, but an honest server must not lose
one of two acknowledged security updates.

Required tests: two writers with disjoint records; two writers changing the
same record; page-write interleaving; loser crash immediately after ack; and a
third device restoring after the race.

## Non-blocking completion items

### Define the owner-zero identity resolver explicitly

Membership and policy canonicals permit `actor_admit_ref = zeros` for the
anchor owner, while `authorized_fp_at()` currently lists only manifest and
certificate references. Add the explicit zero-reference branch resolving to
the immutable anchor `owner_ed25519_fp`; otherwise the frozen pseudocode has no
result for the most privileged signer.

### Make policy-fork backup keys internally consistent

The backup says records merge by `(channel, anchor_hash)`, then says two policy
fork records under the same anchor survive "keyed by `policy_head`." The fixed
record contains `policy_head`, but the stated key and sort order do not include
it. Freeze either a `(channel, anchor_hash, policy_head)` fork-record key or one
bounded set-valued policy field, including deterministic sorting and later
collapse. This is separate from the commit race above.

### Turn owner-channel recreation into an assisted break-glass flow

Not inventing successor anchors inside Phase 83 is the right security decision.
Bare "recreate the channel," however, is not yet a usable recovery procedure
for an owner who controls many channels or whose old key is suspected
compromised. Before identity replacement is exposed with Phase 83 enabled,
define a one-action assisted flow that creates a replacement channel, carries
forward a locally verified roster and settings, marks the old channel unsafe
and read-only, and explains what history cannot be transferred with current
assurance. If that belongs to a future owner-succession phase, make it an
explicit release dependency rather than a surprise after rotation.

## Security and usability assessment

| Property | Sixth-review assessment |
|---|---|
| Design selection | **Accepted:** envelope fanout remains the best usability/security balance among the considered designs. |
| Normal sending | **Good:** asynchronous, one action, no coordinator and no global serialization. |
| Removal of a message sender | **Improved:** the common predicate closes the removed-manifest-member receive bug on devices with the relevant state. |
| Removal as future membership authority | **Blocking:** independent target chains and first-seen ordering let a removed actor plus malicious server create an admission on fresh/restored state. |
| Runtime identity binding | **Good for current traffic and authority certificates; incomplete for historical content and grants.** |
| Message authenticity (H-01) | **Construction remains sound; canonical replay identity is incomplete for edits/reactions.** |
| Fresh-device downgrade | **Understated:** the documented conversion-TOFU residual must also cover cross-target post-removal authority when no authenticated control-plane order/head exists. |
| Guests and history | **Normal flows remain usable; history across identity replacement needs an authenticated grantor reference.** |
| Backup | **Record join improved, storage commit still last-write-wins and non-convergent.** |
| 64-participant cap | **Accepted:** scope is explicit and the rare shed-sender state now preserves drafts and auto-recovers. |
| Mixed-client rollout | **Accepted in design:** the renewable self-fencing lease closes the stale-process assumption without normal user friction. |
| Owner compromise recovery | **Cryptographically honest but product-incomplete:** assisted recreation or a later reviewed succession phase is needed. |
| FS / PCS | **Correctly out of scope and clearly stated.** |
| L-01 | **Still separate work; Phase 83 must not overstate identity-compromise recovery until backup rekey and owner recovery are integrated.** |

The Critical severity of F6-01 describes confidentiality impact, not expected
frequency. It requires a removed member's signing key or cooperation plus a
malicious logical server and a device without reliable prior control-plane
state. That combination is less likely in Chalk's common trusted deployment,
but it is inside the stronger adversarial model Phase 83 is designed to serve.

For a deployment that explicitly trusts its operator and server, Phase 83's
everyday product benefits remain useful and the exploit likelihood is lower.
The documentation should continue to separate that deployment assumption from
the compromised-logical-server guarantee rather than turning optional manual
verification into mandatory ceremony.

## Required focused revision

Before implementation:

1. authenticate cross-target membership-control ordering so a removed actor
   cannot create a newly accepted admission through server-selected fetch
   order;
2. bind sender/grantor admission references into messages, edits, reactions and
   grants, with a safe lower-assurance result for valid retired identities;
3. make edit and reaction replay identities implementable and add complete
   cross-server-ID replay vectors;
4. add conditional or immutable backup publication so concurrent acknowledged
   repacks are actually joined;
5. define the owner-zero resolver and policy-fork backup key exactly; and
6. record the assisted owner-recreation and backup-rekey integration needed for
   usable identity-compromise recovery.

Do not solve these by putting ordinary message sends behind a consensus log,
requiring all members online, mandating picture-word verification, or freezing
an entire channel after routine departures. The only newly serialized work
needs to be rare membership-control and backup publication; normal chat remains
asynchronous.

## Verification performed

This review:

- compared the fifth-review plan at
  `2732a94c47c54e1a24a1028393ea5395b7938e22` with current HEAD
  `7dbdcb31b71f6fb40a389c326491ffcb4a46070f`;
- read the accumulated seventh, eighth and ninth revision delta and the
  author-side R11/R12 review artifacts;
- re-evaluated every `P83-A-F5-*` finding against the current normative text;
- traced the new `member_state`, `authorized_fp_current` and
  `authorized_fp_at` rules through send, receive, authority validation, guests,
  history grants and identity replacement;
- checked the full message/edit/reaction canonical against its declared replay
  identity and the original H-01 audit requirement;
- checked the backup algorithm against the current preferences store's
  last-write-wins per-key behavior;
- confirmed the current identity store retains retired generations while the
  active fetch path serves only the active generation, matching the plan's
  stated implementation delta;
- confirmed the Gate-F lease text now accounts for the current runtime's
  heartbeat re-registration and live-socket behavior; and
- ran `git diff --check` successfully on the reviewed plan/audit delta.

No implementation or runtime tests were run. Phase 83 remains design-only;
this is a documentation and source-assisted protocol review.

## Verdict

The author closed most of the fifth review cleanly, and the selected design
still protects usability much better than the retired transcript plan. The
normal chat path should not be redesigned.

The remaining issues are control-plane causality, temporal identity selection,
object replay identity and multi-device publication — not the basic X25519,
HKDF, AES-GCM or per-recipient HMAC construction. Each has a focused correction
that preserves coordinator-free sends and avoids routine user ceremony.

**Retain envelope fanout as Phase 83. Gate 0 remains open at `7dbdcb31`; fix
P83-A-F6-01 through P83-A-F6-04 and re-review the resulting normative delta
before implementation.**

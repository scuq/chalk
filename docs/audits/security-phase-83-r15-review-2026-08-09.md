# Independent Security Review — Phase 83 MSGSIG (R15 re-audit)

**Review date:** 2026-08-09

**Scope:** full re-audit of the twelfth (final) envelope-fanout
revision — membership-control chain, witness mechanism,
identity-history logic, grants, backup merge.

**Historical note:** this is the review that triggered the 2026-08-09
trust-model revision. Its findings were not folded into a thirteenth
fanout revision; instead scuq withdrew the malicious-server claim and
phase 83 was redesigned (see the current `PHASE-83-MSGSIG.md`; the
fanout design's final text is at git `731eac5`). It is committed here
because the new plan cites P83-A-R15-01 as the decision's trigger.

**Verdict at the time: GATE 0 — OPEN.** Two blocking findings; the
underlying message-encryption construction still sound.

## P83-A-R15-01 — Persistent control split-view remains possible

**Severity:** Critical

The twelfth revision's in-band witness puts `(control_p, control_head)`
in every authenticated object — useful, but the security conclusion
"the false universe survives only a permanent, total partition from
honest traffic" is incorrect. The actual requirement is much weaker:
**the server must suppress traffic only from clients that have learned
a control state incompatible with the victim's branch.**

A perfectly honest Bob can still be stale at `H`. Bob's message seals
`control_head = H`; Carol (on the concealed `H → M` branch) accepts it,
because `H` is a valid ancestor of her branch — the specification
explicitly passes stale senders. Carol can therefore simultaneously
receive normal honest traffic from stale members and attacker-branch
traffic, while never learning about `R` (the concealed removal). Carol
believes Mallory is CURRENT and generates a normal flap for Mallory:
**content disclosure, not denial.** The §A.8 residual understated the
risk by calling sustained equivocation "permanent total partition …
denial-class."

What the witness actually provides: *eventual fork detection if
authenticated traffic from incompatible control histories intersects.*
It does not provide fork prevention, guaranteed convergence, bounded
detection, or confidentiality against persistent selective
equivocation. Valuable, but a different property.

## P83-A-R15-02 — Control-floor backup merge is undefined

**Severity:** High / Blocking

The backup record gained `(control_head, control_p)` as the control
rollback floor, but the field-wise merge never defines how they join.
Two devices can legitimately hold divergent heads (`HA` at p=20, `HB`
at p=22) that are not ancestor-related. `max(control_p)` alone is
insecure; arbitrary or last-writer selection is insecure; discarding
the conflict lets a restored device forget observed equivocation.

Required: an ancestry join — equal heads keep either; an ancestor
yields to its descendant; divergent heads are a `CONTROL_FORK`,
persisted monotonically (`control_fork_observed = true`, head/position
= last common ancestor), never cleared except by channel recreation,
and blocking all new membership/policy transitions after restore.

## What would close R15-01

There is no clever extra hash: if the server controls all
communication between clients, an in-band mechanism cannot force two
divergent worlds to meet. The realistic choices:

- **Option A — quorum-certified control chain.** Control advancement
  requires a quorum certificate; voters never sign two children of one
  committed state; quorum intersection guarantees at most one valid
  successor per position. Real fork *prevention*. Membership
  administration becomes a quorum operation (messages stay
  coordinator-free); removal thresholds need a short formal quorum
  proof (e.g. `q = floor(2N/3) + 1`, with the removal target excluded
  from the eligible set).
- **Option B — small fixed control-witness committee** (e.g. 3-of-4):
  strong anti-equivocation under an explicit witness-honesty
  assumption; small rooms (a 2-person DM) have no Byzantine fault
  tolerance without a third authority — a mathematical reality.
- **Option C — independent control notary / transparency service:**
  only meaningful as a genuinely separate trust domain; for a
  self-hosted system, less attractive than a client quorum.
- **Option D — accept the split-view residual:** then R14 is not
  closed cryptographically, C-01 must be qualified ("which valid
  signed authority branch a zero-state client sees can be
  server-selected"), and this is no longer strong malicious-server
  E2EE group membership.

**Recommendation at the time:** a small client-side quorum
(control-witness certificates) — not a group key, not MLS, not a
message coordinator; only authority-changing operations acquire
consensus. Keep the gossip regardless, as defense in depth
(implementation bugs, double-signing witnesses, withheld-state
evidence, convergence speed) — but no longer ask it to provide a
guarantee it cannot.

Suggested central invariant: *for every committed control position p,
at most one control artifact can obtain a valid quorum certificate; a
client must not accept a control artifact at p without a valid QC
derived from the eligible witness set at p−1; a witness must never
sign two distinct control-body hashes for one (channel, p).* The
malicious server is then reduced to withholding/delaying — an
availability attack — and can no longer produce a valid hidden branch.

## Audit verdict (twelfth fanout revision)

| Area | Result |
|---|---|
| Envelope encryption | sound |
| Pairwise authentication | sound |
| Identity-generation binding | sound |
| Removed-member receive handling | sound |
| Historical messages/grants | sound |
| Control-chain ordering within one branch | sound |
| In-band fork detection | sound |
| Control-chain branch uniqueness | **broken** |
| Split-view confidentiality | **broken** |
| Backup control-floor merge | **undefined** |
| Gate F machinery | sound on this pass |

Closing advice, which the redesign followed: stop modifying the
message wire (six adaptations deep, no longer where the weakness is);
make the next revision about the control plane's actual guarantee —
or, as chosen, change what is claimed.

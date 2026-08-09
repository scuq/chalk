# Independent Security Review — Phase 83 MSGSIG (R14 delta review)

**Review date:** 2026-08-09

**Scope:** the tenth+eleventh revision delta at `3d9aa45` — the R13 work
and the new F6 changes, with a focused pass over the membership-control
chain.

**Verdict: GATE 0 — FAIL / remain open.** One Critical blocker in the
new membership-control chain; the other major F6 changes look
structurally sound on this pass.

## What passed

**R13-01 is closed.** The owner-zero case is now explicitly handled by
`authorized_fp_at(actor, ref)`: zero is accepted only for the anchor
owner and resolves to `anchor.owner_ed25519_fp`. That fixes the
owner-signature hole.

**R13-02 is closed.** Messages, edits and reactions now carry
`actor_admit_ref`; history and legacy grants carry `grantor_admit_ref`.
Historical A1 objects can therefore still select A1 after a later A2
rotation. The separation between identity verification and current
membership authorization is also preserved.

**F6-03 looks closed.** Edits and reactions now carry the same replay
identity components as messages, giving all object types the uniform
`(actor, writer_scope, client_msg_id)` first-seen identity.

**F6-04 looks materially better.** Moving from a last-write-wins
preferences commit to immutable generation namespaces plus a CAS commit
head is the correct shape for preventing acknowledged concurrent backup
writes from disappearing.

The new `former-identity` state is also sensible: a cryptographically
valid object from a superseded identity should not be mislabeled as
either a current message or a forgery.

## P83-A-R14-01 — The control chain trusts a malicious server as sequencer

**Severity:** Critical / Blocking

The new F6-01 solution says the server maintains a single
`control_head` and accepts a new control artifact only when
`artifact.prev_control_head == server.control_head`. The design then
concludes that an artifact minted after Alice's removal "cannot be
inserted before it, because minting requires holding the head."

That conclusion only holds if the server honestly maintains exactly one
head. But Phase 83's own threat model explicitly assumes the server may
be malicious; elsewhere the document correctly says "a malicious server
enforces nothing." The `control_head` CAS therefore cannot itself be a
security boundary.

### Attack

Start with valid control head `H`. Alice is currently admitted. The
honest branch becomes `H → R` (R = remove Alice). The malicious server
now simply continues presenting old `H` to Alice. Alice still owns her
legitimate long-term signing key and her historical admission
reference. She signs `M` = admit Mallory, with `prev_control_head = H`
and her old valid `actor_admit_ref`.

The server now has:

```
        ┌─ R: remove Alice
H ──────┤
        └─ M: admit Mallory
```

Both are individually valid signed control artifacts — exactly what the
document calls a control fork. The server then gives Carol, a fresh
client, only `H → M` and hides `R`. Carol sees a perfectly linear
authenticated chain. At M's control position Alice is still admitted,
because the removal exists only on the hidden sibling branch. Therefore
Mallory's admission validates. The server can subsequently continue
that branch and never reveal `R`.

So the claimed property — a post-removal mint cannot chain before the
removal on any device — does not hold against the malicious server the
design is supposed to tolerate. It holds only against an honest CAS
sequencer.

### Why the existing fork handling doesn't solve it

"Two valid artifacts naming one `prev_control_head` → control fork →
surface both" works only if the client learns both branches. A
malicious server has no reason to reveal both. This is a
split-view / equivocation problem. A fresh client has no globally
trusted information telling it `H → R` exists when the server shows
only `H → M`. The control-floor backup helps a device that previously
observed `R`, but it does not protect a fresh device, which is
precisely the F6-01 case.

This is materially stronger than the existing "server withheld the
tail" residual. With simple truncation the fresh client merely misses a
recent removal. With the hidden fork the server can present new
attacker-beneficial membership state that was created after the
real-world removal event, signed by the removed actor on a concealed
branch. That is not merely a prefix of the honest chain. The document
currently claims "any chain it serves is one the honest mints actually
produced, in the order they produced it" — but there is no single
authenticated meaning of "the order they produced it" once the
malicious server is permitted to equivocate about `control_head`.

### The underlying problem

A hash chain provides tamper evidence within one branch, but it does
not provide global uniqueness of the branch without some trusted
anti-equivocation mechanism. Server-side CAS gives operational
serialization, but against a malicious server it cannot establish that
two clients received the same history. This is essentially the same
class of problem Certificate Transparency solves with gossip/witnesses,
and secure group protocols solve through authenticated group state
progression.

### What would close it?

- **Option 1 — Explicitly weaken the threat model** (server trusted to
  serialize and not equivocate). A major security-model change; given
  the rest of Phase 83 is engineered against a malicious server, not
  recommended.
- **Option 2 — Add an anti-equivocation witness** (signed/checkpointed
  control head replicated somewhere the server cannot independently
  fork; gossip or an external transparency witness). Makes two branches
  detectable beyond the server's control; adds infrastructure.
- **Option 3 — Make control advancement cryptographically unique**
  (current-authority co-signing/quorum). Pushes the protocol toward
  coordinator/group-state territory; needs a fresh design review.
- **Option 4 — Accept hidden forks as a stated residual.** Then F6-01
  is not actually closed, and "membership is never server-selected"
  needs substantial qualification. Not recommended unless that weaker
  guarantee is actually acceptable.

### Concrete adversarial vector to add

Selective fork visibility, the litmus test for any replacement
solution:

```
Initial:            control_head = H; Alice admitted
Honest client:      signs R = remove Alice, prev = H
Malicious server:   stores R on branch A; continues advertising H to Alice
Alice:              signs M = admit Mallory, prev = H
Server view to Carol (fresh): serve only H → M; never reveal R
Expected secure outcome:      Mallory must not become CURRENT
```

Under the present specification, Carol cannot reject `M`.

### One smaller note

The phrase "minting requires holding the head" should disappear
regardless of the eventual fix. A client never cryptographically holds
the unique head; it holds a head the server presented. That distinction
is exactly where the attack lives.

## Updated audit state

| Finding | Status |
|---|---|
| R11-01 membership predicate | Closed |
| R11-02 identity binding | Closed |
| R11-03 shared member-state implementation | Closed |
| R12-01 historical signer resolution | Closed |
| R12-02 owner rotation | Closed |
| R13-01 owner zero ref | Closed |
| R13-02 historical message/grant identity | Closed |
| F6-02 former-identity / backup rekey | Looks closed |
| F6-03 uniform replay identity | Looks closed |
| F6-04 backup concurrent commit | Looks closed |
| **R14-01 hidden control-head fork / malicious sequencer** | **Critical blocker** |

## Gate 0

**FAIL / remain open.** The cryptographic envelope is still not the
problem. The blocker is now very specifically the membership-control
ordering model: the new hash chain solves reordering by an honest
sequencer, but not equivocation by a malicious sequencer. Since Chalk
already assumes the server can be malicious, `control_head` CAS cannot
be the root of uniqueness. Resolve this design question before doing
more polishing elsewhere, because any subsequent membership semantics
will depend on what guarantee the control-order mechanism actually
provides.

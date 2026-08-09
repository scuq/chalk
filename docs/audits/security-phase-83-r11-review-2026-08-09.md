# Independent Security Review — Phase 83 MSGSIG (R11 series)

**Review date:** 2026-08-09

**Scope:** `PHASE-83-MSGSIG.md`, seventh revision, plus
implementation-readiness inspection of the supplied Chalk repository.

**Verdict: GATE 0 — FAIL / RE-REVIEW REQUIRED**

Reviewer's cover note: I reviewed the seventh-revision Phase 83 design and
cross-checked the uploaded repository for implementation assumptions. My audit
conclusion is: Gate 0 should remain open. I found one clear High-severity
blocker and one additional High-severity specification gap that should be
frozen before A-1/A-4 implementation begins. The repository also confirms
Phase 83 itself has not landed yet, which matches the plan status.

## Executive summary

The envelope-fanout cryptographic construction is internally coherent. I did
not find a fundamental break in the X25519 → HKDF → per-recipient wrap +
recipient-specific HMAC construction.

The design is also unusually disciplined about distinguishing cryptographic
guarantees from accepted residuals. In particular, it explicitly acknowledges
no forward secrecy / PCS, TOFU conversion, recipient-forgeable deniable
authentication, malicious-server staleness, and lack of a per-message roster
commitment.

However, I found two specification issues affecting the exact property
Phase 83 claims to provide: removal must prevent an ex-member from continuing
to appear as an authenticated current sender.

## Findings

| ID | Severity | Finding |
|---|---|---|
| P83-A-R11-01 | High / Blocking | Removed manifest members can remain valid senders under the frozen receive predicate |
| P83-A-R11-02 | High / Blocking specification gap | Admission fingerprint is not explicitly bound to the runtime identity used for DH/MAC/signature validation |
| P83-A-R11-03 | Low | Security-critical member predicate is defined separately for send and receive, inviting future semantic drift |
| P83-A-R11-04 | Informational | Lack of FS/PCS substantially enlarges the consequence of long-term X25519 compromise, but is accurately disclosed |
| P83-A-R11-05 | Informational | No roster commitment permits sender equivocation/exclusion; accurately disclosed and consistent with the deniability choice |

### P83-A-R11-01 — Removed manifest member remains acceptable

**Severity:** High — Gate blocker

This is the strongest finding.

The membership state machine correctly specifies the send-side rule:

> a flap is emitted only when the verified chain ends in admit, or for
> manifest members with no chain yet.

That is correct because a manifest entry acts as the initial admission only
until a certificate chain supersedes it.

The receive-side rule is different:

> the claimed sender is a manifest member or a target whose verified chain
> currently ends in admit.

Taken literally:

1. Alice is an original manifest member.
2. Alice is subsequently removed.
3. Alice retains her static X25519 key.
4. Therefore Alice can still derive `K_mac(Alice→Bob)`.
5. With cooperation from a malicious server, Alice submits a new suite-2
   message to Bob.
6. The MAC verifies.
7. Sender acceptance evaluates Alice ∈ manifest.
8. The first arm succeeds regardless of Alice's later removal chain.
9. The message becomes authenticated-for-you.

This reintroduces essentially the vulnerability that P83-A-R5-01 was supposed
to close: pairwise MAC keys survive removal, so membership has to be checked
at receive time. The document itself explains precisely that threat.

It also contradicts the claimed audit property that removal is two-sided and
that the receive rule prevents authenticated speech from a departed member.

**Required correction**

Freeze one common predicate, approximately:

```
currently_admitted(target) =
    if target has a verified membership chain:
        chain currently ends in admit
    else:
        target is a manifest member
```

Then both flap emission and sender acceptance MUST call that exact predicate.

In other words:

```
manifest member with no chain yet
OR
verified chain currently ends in admit
```

— not —

```
manifest member
OR
verified chain currently ends in admit
```

Required vectors:

- manifest member → removed → live injection → `unauthorized-sender`
- manifest member → removed → historical backfill → `former-member`
- manifest member → removed → re-admitted → accepted
- manifest member with no certificate chain → accepted
- non-manifest later admit → accepted
- later admit → removed → rejected

I would make this a single pure state-machine function shared by send and
receive rather than duplicate prose/logic.

### P83-A-R11-02 — Admission fingerprint/runtime identity binding is not frozen

**Severity:** High — Gate blocker as a specification issue

Membership admits contain `target_ed25519_fp`, and manifest entries similarly
contain an `ed25519_fp`.

That is necessary because authorization of a user UUID alone is insufficient:
the membership artifact must authorize a specific cryptographic identity.

But §A.4's frozen validation rules enumerate chain shape, authorization,
observed-removal behavior, rollback and fork handling without explicitly
freezing the following load-bearing check:

```
SHA-256(fetched_ed25519_public) ==
    fingerprint authenticated by the target's effective admission state
```

The implementation must then verify the existing Ed25519→X25519
self-signature before using that X25519 key.

Without that explicit rule, two plausible implementations exist:

Safe interpretation:

```
membership cert
    ↓
authorized Ed25519 fingerprint
    ↓
fetched Ed25519 public must match
    ↓
verify self-sig over X25519 public
    ↓
use X25519
```

Unsafe interpretation:

```
membership cert says UUID Alice is admitted
    ↓
fetch "current identity for Alice" from server
    ↓
use that identity
```

Under the second interpretation, a malicious identity service/server could
substitute a different first-seen identity for an unpinned member even though
the admission certificate authenticated another fingerprint.

The existing Chalk identity layer already provides the correct primitive:
`verifyIdentitySelfSig()` verifies Ed25519 over the X25519 public key. The
Phase 83 state machine needs to freeze the other half of that relationship:
which Ed25519 key the membership state authorized.

**Required rule**

For every effective member:

```
authorized_fp =
    manifest.ed25519_fp
    if no later admission supersedes the manifest state
    OR
    latest valid admit.target_ed25519_fp
```

Before flap emission, sender MAC verification, actor signature validation,
history-grant acceptance, or voice acceptance:

```
SHA256(identity.ed25519_public) == authorized_fp
AND
verifyIdentitySelfSig(
    identity.x25519_public,
    identity.ed25519_public,
    identity.self_sig
)
```

A mismatch must not silently become TOFU.

Suggested typed result: `identity-mismatch` — or reuse the existing
identity-changed wall if that is already a hard-stop security state.

This rule should also specify what happens during a legitimate identity
replacement. Right now the Phase 83 document contains membership fingerprints
but does not define an identity-generation transition.

### P83-A-R11-03 — Duplicate security predicates

**Severity:** Low

R11-01 happened because the same concept — "is this principal currently
admitted?" — is independently expressed in send and receive rules.

This is a maintainability/security smell.

There should be exactly one pure function conceptually equivalent to:

```
EffectiveMemberState(channel, target, verified_state)
```

returning something like:

```
CURRENT | FORMER | NEVER_ADMITTED | FORKED | SHED | GUEST_LAPSED
```

Then:

```
send flap       := CURRENT && !SHED
sender accepted := CURRENT
history         := FORMER etc.
```

Note how this also prevents SHED from accidentally becoming equivalent to
removal — the document correctly says a shed member's incoming messages remain
valid because their membership chain still ends in admit.

This is a strong candidate for a reference-model/state-machine test rather
than scattered UI/client conditions.

## Cryptographic core

I did not identify a practical cryptographic break in the central message
construction.

The design separates `K_mac`, `K_wrap` and `K_history` through independent
HKDF info strings and uses fresh per-message ephemeral X25519 for wrapping the
message key.

The wire also binds the encrypted canonical object into the recipient HMAC:

```
HMAC(
    K_mac(sender→recipient),
    "chalk-fan-mac-v1" || canonical || SHA256(body_ct)
)
```

while the canonical itself starts with the channel ID. The document explicitly
preserves that channel binding.

An attacker can mutate `eph_pub`, flap nonce or wrapped key and cause a
decrypt/unwrap failure, but I do not see a way to turn that into authenticated
substituted plaintext. That is availability damage rather than an integrity
break.

The all-zero X25519 shared-secret rejection is also explicitly required.

## Forward secrecy / post-compromise security

Not a new finding, but operationally important.

Phase 83 deliberately has no forward secrecy and no post-compromise security.
Compromise of a user's long-term X25519 private key plus recorded traffic
allows recovery of historic message keys through that user's flaps.

The authenticity consequence is particularly strong: compromise of Bob's
X25519 key allows the attacker to derive every `K_mac(*→Bob)` and therefore
impersonate each of those people to Bob.

The document already states this accurately. I therefore do not classify it as
a Phase-83 blocker.

I would, however, make identity replacement/recovery particularly prominent
operationally because changing only passwords or sessions does not repair this
compromise.

## Deniability

The deniable-MAC construction is conceptually consistent. Bob possesses the
same secret necessary to produce an Alice→Bob MAC, so Bob cannot later prove
to Carol that Alice authored it. This achieves the desired non-transferability.

That means the UI wording "authenticated for you" is substantially better than
"signed by Alice". The plan explicitly recognizes this property.

The same caveat applies to `K_history`: a grantee can technically create a
valid grant addressed to themselves because they also know the pairwise key.
This is consistent with the same deniable-authentication model, but
documentation should avoid implying third-party-verifiable grantor signatures.

## Message equivocation / omitted recipients

The design has no cryptographically authenticated full recipient roster per
message. Consequently a malicious sender can construct different flap sets for
different recipients or deliberately omit someone while presenting what
appears to be the same logical message.

The plan explicitly records this and states that solving it would require
cross-recipient comparison or a transferable sender commitment, conflicting
with the deniability goal. I agree with treating this as an accepted design
tradeoff rather than a newly discovered vulnerability.

The UI/documentation must simply avoid making claims equivalent to "everyone
in this channel received this message". Authentication proves authorship for
the local recipient, not consistent broadcast.

## Fresh-device / malicious-server behavior

The design is much stronger once an anchor has been persisted or independently
verified. The weak point remains first observation: without backup or prior
verification, conversion is TOFU and a malicious server can provide a poisoned
roster containing a decrypting attacker identity. The document correctly
recognizes that this is content disclosure, not merely denial of service.

That residual is material but accurately scoped. The one-way rule that a
build-F client never originates suite 1 is a good downgrade boundary.

## Gate F

The revised instance-ack lease/self-fencing design is substantially stronger
than relying on expiring presence rows. The key property is correctly moved
into the process itself:

- ack renewal must be confirmed,
- local fencing occurs before the server row can cease counting toward the
  barrier,
- send/delivery/hello gates close locally,
- fencing clears only after rereading the durable era and renewing
  successfully.

That addresses the otherwise dangerous case where a partitioned instance keeps
live sockets after its DB heartbeat disappears.

I did not find a new Gate-F blocker in this review.

## History grants

The history grant construction is reasonably well compartmentalized:
independent `grant_id`, absolute immutable range, fixed `chunk_count`,
per-grantee quota, dedicated `K_history`, subtype separation, canonical-object
and ciphertext hashes, incomplete grants render nothing.

The explicit refusal to evict a live chunk when the global ceiling is reached
is the correct failure mode.

I did not identify a history-grant confidentiality escalation beyond the
already accepted pairwise-key compromise model.

## Repository readiness

The supplied repository currently contains no Phase-83 fanout implementation
symbols such as `chalk-fan`, `MAX_FLAPS`, `channel_anchor`, `member_manifest`,
`chalk-member-cert`, `channel_security_enc`, `era_enforced` — which is
consistent with the document's statement that the phase is planned and no
slice should land before Gate 0 closes.

I inspected the existing crypto/identity infrastructure because Phase 83
depends heavily on it. Relevant observations:

- existing identities use X25519 for key agreement and Ed25519 as the identity
  trust anchor;
- `verifyIdentitySelfSig()` verifies the Ed25519 signature over the X25519
  public key;
- the existing trust layer is TOFU plus optional manual picture-word
  verification;
- existing membership/storage code already distinguishes the channel owner and
  prohibits removing the owner;
- current heartbeat behavior matches the concern described in the revised
  Gate-F section: a process can re-register and continue operating after its
  instance row is reaped.

So the new protocol is being designed against real runtime behavior rather
than an imaginary clean-slate system, which is a positive sign.

I could not execute the Go test suite in this audit environment because the
repository requests Go 1.25.12 and the toolchain attempted to download it from
proxy.golang.org, while this environment has no outbound network access. That
does not affect the protocol findings above.

## Required changes before Gate 0 can pass

1. **Fix the sender-acceptance predicate.** Replace "manifest member OR chain
   currently ends in admit" with "manifest member with no chain yet OR chain
   currently ends in admit". Preferably define one common effective-membership
   function used by both sending and receiving.
2. **Freeze the identity-fingerprint linkage.** Explicitly require that the
   Ed25519 identity being used matches the fingerprint authenticated by the
   manifest/current admit certificate, and then verify the Ed25519→X25519
   self-signature.
3. **Add mandatory vectors** for: initial-manifest member → remove → inject;
   initial-manifest member → remove → backfill; initial-manifest member →
   remove → re-admit; admitted fingerprint ≠ server-fetched identity; correct
   Ed25519 fingerprint + wrong X25519/self-sig; identity change while
   membership remains active.
4. **Make the effective-member-state implementation one pure state-machine
   component** and consume it from flap creation, sender acceptance, voice
   sender acceptance, guest handling, and actor authorization.

## Final assessment

| Property | Assessment |
|---|---|
| Cryptographic construction | good / reviewable |
| Wire canonicalization | strong |
| Parser requirements | strong |
| Membership authority model | strong but currently inconsistent at receive |
| Downgrade resistance | strong after Gate F |
| Fresh-device protection | intentionally limited |
| Forward secrecy | absent by design |
| Deniability | achieved at the cost intended |
| Implementation status | not started |
| Gate 0 | **FAIL pending R11-01 and R11-02** |

The most important issue is R11-01. It is a small textual/state-machine
difference with a large security consequence: implemented literally, it
restores post-removal authenticated injection specifically for members that
originated in the anchor manifest.

Once that is corrected and the fingerprint→runtime-key binding is made
normative, I would consider the seventh-revision design suitable for another
independent Gate-0 pass rather than requiring a redesign of the cryptographic
core.

The encouraging part is that I would not redesign the envelope-fanout crypto
based on this review. The primary blocker is a state-machine predicate bug,
not a broken primitive or fundamental construction. The manifest member
receive rule is exactly the kind of one-word difference that becomes nasty
after implementation, so catching it while Phase 83 is still dark is ideal.

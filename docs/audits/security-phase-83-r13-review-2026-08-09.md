# Independent Security Review — Phase 83 MSGSIG (R13 delta review)

**Review date:** 2026-08-09

**Scope:** focused pass over §A.4/§A.5 of the ninth revision and the R12
changes, with repository cross-checks.

**Verdict: GATE 0 — STILL OPEN.** R12-01 and R12-02 are correctly
addressed, but the fix exposes two new temporal-identity problems: one
small specification hole, one more important wire-format problem.

## R12 findings

**P83-A-R12-01: CLOSED.** The `authorized_fp_current(principal)` /
`authorized_fp_at(membership_ref)` split is correct: historical
authority artifacts resolve the identity committed by their
`actor_admit_ref`, live traffic resolves the current admission
fingerprint — matching the non-retroactive authority model. The
`(user_id, ed25519_fp)` historical identity lookup is the right key:
the authenticated fingerprint, not an implementation-specific
generation number.

**P83-A-R12-02: CLOSED.** Owner identity replacement is now explicitly
outside Phase 83 (owner key replacement → recreate channel), internally
consistent with the immutable owner fingerprint in the anchor and the
deliberate absence of successor anchors. I agree with this resolution.

## P83-A-R13-01 — Owner-signed authority artifacts have no `authorized_fp_at()` mapping

**Severity:** High / Blocking

The new resolver maps `manifest_admit_ref → manifest fingerprint` and
`admit cert_hash → admission fingerprint`. But both policy and
membership certificates explicitly encode `actor_admit_ref = zeros`
when the actor is the anchor owner ("zeros ONLY for the anchor owner"),
and the signature is then validated against
`authorized_fp_at(actor_admit_ref)`. There is no definition for
`authorized_fp_at(zeros)` — a literal implementation cannot validate an
owner-signed policy/member/guest certificate under the newly frozen
identity resolver.

**Fix** — extend the resolver explicitly, including the actor in the
signature because zeros by itself identifies nothing:

```
authorized_fp_at(actor, membership_ref) =
    if membership_ref == zeros:
        require actor == anchor.owner
        return anchor.owner_ed25519_fp
    if membership_ref is manifest_admit_ref:
        return referenced manifest ed25519_fp
    if membership_ref is admit cert_hash:
        return referenced admit target_ed25519_fp
    otherwise:
        invalid
```

Also freeze: zeros is valid **iff** actor == anchor.owner; a zero ref
supplied by any other actor must be malformed/unauthorized.

Required vectors: owner + zero `actor_admit_ref` + correct owner key →
valid; non-owner + zero `actor_admit_ref` → reject; owner + zero ref +
substituted identity → `identity-mismatch`; historical owner-signed
cert → verifies against the anchor owner fingerprint.

Gate blocker, but mechanically easy to close.

## P83-A-R13-02 — Identity rotation breaks verification of ordinary historical messages

**Severity:** High / Blocking

This is the more important issue. Certificates now carry enough
information to resolve their historical signer (`actor_admit_ref` →
`authorized_fp_at` → A1). **Ordinary suite-2 messages do not.** The
frozen message canonical contains only `sender_user_id`,
`writer_scope`, `client_msg_id`, … — no `sender_admit_ref` and no
authenticated sender fingerprint.

Consider: Alice admitted as A1 → sends message M under A1 → identity
replaced (A1 removed, A2 re-admitted) → Bob restores another device →
Bob backfills M. Live crypto identity resolution uses
`authorized_fp_current(Alice) = A2`, but M's HMAC was generated from
`K_mac(A1 → Bob)`. Bob tries `K_mac(A2 → Bob)` and gets a MAC failure.
A perfectly legitimate historical message becomes a
`mismatch`/forged-attempt on a fresh device merely because the sender
legitimately rotated later. The directional rule only saves objects
already locally accepted under A1; it does not solve first fetch on
another device. This is the same temporal mismatch R12-01 fixed for
certificates, still present in the message layer.

**Why the server cannot fix it:** asking the server "which old identity
should I use for this message?" would let a malicious server choose
among retired identities. The historical identity generation must be
authenticated inside the message's protected canonical.

**Recommended fix:** add `h32(sender_admit_ref)` to all sender/actor-
originated suite-2 canonical objects — `manifest_admit_ref(sender)` for
a manifest member, the current admit `cert_hash` for a later admission.
Receive then does: member state / historical classification +
`authorized_fp_at(sender_admit_ref)` → historical Ed25519 identity →
self-sig → historical X25519 → `K_mac` historical sender → recipient.

This remains deniable: it is not a message signature, merely a binding
of which authenticated membership state selects the pairwise identity.
For current/live acceptance, `member_state(sender) == CURRENT` is still
independently required, so an old admission ref does not let an
ex-member regain current authority. The two checks answer different
questions — `sender_admit_ref`: "which identity produced this object?";
`member_state` current: "is this person allowed to speak as a current
member now?" That distinction is important.

**The same problem exists in history grants.** The grant canonical has
`grantee_admit_n`/`grantee_admit_cert_hash` but no authenticated
*grantor* admission reference. A grant created under A1, fetched after
the grantor rotates to A2, was sealed under `K_history(A1 → Bob)` while
acceptance would resolve `authorized_fp_current(grantor) = A2` — the
stored grant becomes undecryptable. Add `grantor_admit_ref` to the
history grant canonical, verify via `authorized_fp_at(grantor_admit_ref)`.
The grantee reference already exists, which makes the absence on the
grantor side particularly noticeable. The same change applies to
`legacy_key_grant`.

**Edits and reactions:** cover all three suite-2 object types with one
common field and one semantic rule — `h32(actor_admit_ref)` where actor
is `sender_user_id` for messages and edits, `actor_user_id` for
reactions. The HMAC already authenticates the canonical, so the
reference is protected by the existing construction.

**Historical verification versus historical authorization:** adding
`sender_admit_ref` must not change removal semantics. If a malicious
server delivers a removed member's old-identity message as new/live,
the client may establish it was cryptographically created with A1 — but
because the sender is not currently admitted, the result must still be
`unauthorized-sender` on live delivery, `former-member` on backfill.
Conceptually: (1) resolve the identity that produced the object via
`sender_admit_ref`; (2) verify the MAC; (3) independently evaluate
current `member_state`; (4) apply live/backfill classification. That
preserves the R11 fix.

## Updated status

| Finding | Status |
|---|---|
| R11-01 founding-member removal | Closed |
| R11-02 fingerprint/runtime identity binding | Closed |
| R11-03 duplicate membership predicates | Closed |
| R12-01 historical authority after identity rotation | Closed |
| R12-02 owner identity replacement | Closed |
| **R13-01 zero owner `actor_admit_ref` undefined** | **High / Blocker** |
| **R13-02 historical messages/grants lose signer generation after rotation** | **High / Blocker** |
| Envelope encryption construction | Still sound |
| Removal acceptance model | Still sound |
| Gate F | No new issue found |
| Backup model | No new issue found |

## Recommended ninth → tenth revision delta

Only these conceptual changes:

```
authorized_fp_at(actor, ref):
    zero ref + actor == anchor.owner → anchor.owner_ed25519_fp
    manifest ref                    → manifest fingerprint
    admit cert ref                  → admit fingerprint
```

and authenticated historical identity references added to:

```
message/edit/reaction:  actor_admit_ref
history grant:          grantor_admit_ref
legacy-key grant:       grantor_admit_ref
```

Then use `authorized_fp_at(ref)` to select the identity that
verifies/decrypts the historical artifact, while retaining
`member_state()` as the separate current-authorization decision.

I would not change X25519/HKDF/HMAC/AES-GCM or the overall fanout
architecture. This is again a protocol-state temporal binding issue
rather than a cryptographic primitive problem. Once R13-01 and R13-02
are frozen, the next review can stay narrowly focused on the added
references and their interaction with removal/re-admission.

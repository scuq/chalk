# Independent Security Review — Phase 83 MSGSIG (R12 delta review)

**Review date:** 2026-08-09

**Scope:** Gate-0 delta review of the eighth-revision
`PHASE-83-MSGSIG.md` against the R11 findings
(`security-phase-83-r11-review-2026-08-09.md`), plus repository
cross-checks of the identity and membership layers.

**Verdict: GATE 0 — STILL OPEN.** R11-01/02/03 are closed; the new
identity-replacement text exposes two additional High findings.

## Result

| Finding | Status |
|---|---|
| R11-01 removed manifest member injection | Closed |
| R11-02 membership fingerprint not bound to runtime key | Closed |
| R11-03 duplicated membership predicates | Closed |
| **R12-01 historical signer identity after rotation** | **High / Blocker** |
| **R12-02 owner identity replacement impossible** | **High spec contradiction** |
| Cryptographic envelope construction | No new issue |
| Gate-F lease/self-fencing | No new issue |
| History grant construction | No new issue |
| No-FS/PCS disclosure | Correctly documented |
| Roster equivocation | Correctly documented |

## P83-A-R12-01 — Historical actor identity is ambiguous after identity replacement

**Severity:** High / Blocking

The new `authorized_fp()` rule resolves the fingerprint of the **latest
effective admission state** and requires it before actor signature
validation. That works for current messages, but not necessarily for
historical membership/policy certificates.

Suppose: Alice has identity A1 → Alice admits Bob / signs a policy cert
→ Alice's identity rotates → Alice is removed + re-admitted as A2.
Later Carol restores a device and refetches the old certificate Alice
signed while she had A1. The certificate correctly references Alice's
historical `actor_admit_ref` (the Alice/A1 admission), and the state
machine explicitly says actor authorization is non-retroactive: Alice
leaving later must not invalidate actions she performed while admitted.

But the new identity rule can be read as `authorized_fp(Alice) = A2`,
because A2 is the latest effective admission — while the historical
certificate was signed with A1. Result: signature made by A1 vs
`authorized_fp = A2` ⇒ `identity-mismatch`. That would break
verification of legitimate historical authority after a user's identity
rotation.

The document actually contains both concepts — actor authority is
evaluated at `actor_admit_ref` / the referenced state; identity at the
latest effective admission state. Those need to become the same temporal
model.

**Required fix**

Make the fingerprint resolver explicitly state-relative:

```
authorized_fp_current(principal)      // ordinary current traffic
authorized_fp_at(actor_admit_ref)     // authority artifacts
```

Conceptually, for a historical artifact:

```
identity_for_ref(actor_admit_ref)
    → admitted Ed25519 fingerprint
    → identity record matching that fingerprint
    → verifyIdentitySelfSig(...)
    → verify artifact signature
```

This also means Chalk must be capable of resolving retired identity
generations. The current repository already preserves them in
`identity_keys`: old generations receive `retired_at` rather than being
deleted — exactly what Phase 83 needs. But today's `fetch_identity`
uses `GetActiveIdentityKeyAny(...)` and therefore returns only the
active generation. So A-2 needs to freeze a historical identity lookup
mechanism, keyed by `(user_id, ed25519_fp)` or `(user_id, generation)`.
I prefer fingerprint, because that is what the authenticated membership
artifact actually commits to.

**Required vector:** A1 admitted → A1 signs Bob-admit → A1 removed →
A2 re-admitted → fresh device verifies Bob-admit → succeeds using A1.

This is a real Gate blocker because otherwise identity rotation can
retrospectively destroy the membership authority chain.

## P83-A-R12-02 — Owner identity replacement does not work

**Severity:** High specification contradiction; small fix possible

The new text says "The only repair is identity replacement" and defines
replacement as remove + re-admit. But Chalk has a special principal:
the channel owner. The Phase-83 document says owner identity is fixed
at the anchor, and the current implementation explicitly prohibits
removing the owner (`ErrCannotRemoveOwner`; the server reports "the
channel owner cannot be removed"; governance likewise rejects owner
removal).

So the transition owner A1 → remove owner → re-admit owner A2 cannot
happen under the current security model. More importantly, the anchor
itself contains `owner` and `owner_ed25519_fp`, and successor anchors
were deliberately removed from Phase 83 after F5-01. Therefore an owner
whose identity key is compromised or legitimately regenerated cannot be
repaired using the R11-02 identity-replacement procedure.

**Preferred fix (the smaller one):** explicitly exclude owners from
identity replacement.

```
Non-owner identity replacement:
    remove + re-admit with new target_ed25519_fp
Owner identity replacement:
    not supported in Phase 83; recreate the channel.
```

That is consistent with the existing design decision ("a security-root
transition earns its own phase") and avoids reopening the
successor-anchor problem. Also change the residual from "The only
repair is identity replacement" to approximately:

> Compromise recovery requires identity replacement. For non-owner
> members this is remove + re-admit. Because the owner's fingerprint is
> part of the immutable channel anchor, owner identity replacement
> requires channel recreation in this phase.

I would not invent an owner-key-rotation artifact inside Phase 83. That
deserves separate design/audit because it changes the authority root.

## Previous blocker verification

The previous serious bug is now fixed correctly. There is now exactly
one `currently_admitted()` predicate with the right semantics (a
verified chain must currently end in admit; manifest membership is
accepted only while no chain exists; once any verified chain exists it
supersedes the manifest entry entirely). That closes the
founding-member removal attack. The receive side explicitly consumes
the common predicate rather than reconstructing membership
independently.

The fingerprint binding is also substantially improved —
`SHA-256(identity.ed25519_public) == authorized_fp` plus
`verifyIdentitySelfSig(...)`, with `identity-mismatch` instead of
falling back to TOFU. That closes the malicious-server
identity-substitution interpretation from R11-02. The remaining R12-01
issue isn't that the binding is weak; it's that it now needs a
historical version for non-retroactive authority verification.

## Gate 0

Still **OPEN**. Neither new finding requires changing the message
encryption construction. R12-01 needs essentially
`authorized_fp_current(user)` / `authorized_fp_at(actor_admit_ref)`
plus historical identity retrieval. R12-02 can be solved very cheaply
by declaring owner identity change → recreate channel, which is
already philosophically consistent with the decision not to introduce
security-root succession in Phase 83.

After those two changes, I would do another focused re-read of
§A.4/§A.5 rather than restarting the entire cryptographic audit.

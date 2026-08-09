# Independent Security Review — Phase 83 MSGSIG (R16: first review of the signed-envelope redesign)

**Review date:** 2026-08-09

**Scope:** the redesigned `PHASE-83-MSGSIG.md` (signed sealed
envelopes, first-responder rotation, server pin) against the revised
2026-08-09 trust model.

**Verdict: architecture good; GATE 0 — still OPEN, but only for two
fairly contained issues.** Neither requires bringing back fanout,
quorum, or control chains. The simplification removes most of the
difficult Phase-83 state machinery instead of continuing to patch it,
and dropping the malicious-chalkd claim makes the old R15 split-view
problem gone by design, not merely reclassified.

## 1. High — Retired identity generations are not protected against host/database tampering

The most important new issue. Current-identity verification is fine
(fingerprint → fetch → current pin must match → verified). But
`verified-former-identity` currently accepts a **server-attested
retired generation of the same user** — a hole under claim 2.

**Attack:** host malware with DB write access inserts a fake retired
generation row for Alice carrying an attacker key, then manufactures
an object with `sender_user_id = Alice`,
`sender_ed25519_fp = fingerprint(attacker_key)`, signed with the
attacker's key. Honest chalkd truthfully reports what its database
says: "this retired identity belongs to Alice." The client verifies
the fake key and classifies the object `verified-former-identity`. The
host has converted arbitrary DB modification into historical
impersonation — conflicting with D.1's claim that signatures make
host-side tampering and member impersonation detectable.

**Recommended solution:** give identity generations their own tiny
cryptographic chain — no old membership machinery needed:

```
identity_generation:
  "user identity v1"
  || uuid16(user) || u32be(generation)
  || h32(ed25519_pub) || h32(x25519_pub)
  || h32(prev_generation_hash)
  || sig64                       // signed by the PREVIOUS generation
```

Generation 1's trust comes from the existing TOFU/current pin; each
rotation signs the successor with the old key (rotation already has
the old identity in hand). Clients store/pin the chain.
`verified-former-identity` then requires the fingerprint to exist in
the **cryptographically verified identity history**, not merely in a
server database row. Much lighter than anything from old Phase 83.

## 2. High — First-responder rotation is not actually serialized by the version ceiling

The return to first-responder rotation under the trusted-server model
is right, but "concurrent rotation attempts serialize on the server's
version ceiling" is insufficient — the problem occurs **before** the
version commit. Alice and Bob both respond to `rotation_due`, mint
`KA`/`KB`, and both upload per-recipient wraps for version 8: recipients
can end up holding a mixture (`Alice→wrap(KA)`, `Bob→wrap(KB)`, …)
depending on which insert wins, and only afterwards does one client
win the version CAS. The version *number* was serialized; **which key
became version 8 was not.** (The existing implementation avoided this
only because rotation was creator-only.)

**Recommended solution — one atomic rotation transaction:**

```
rotate_channel_key {
    channel_id, expected_version, new_version,
    wraps: [ per-recipient signed_wrap(K_new) … ]
}

server: BEGIN; lock channel;
  require member(caller) ∧ rotation_due ∧ current == expected;
  validate: exactly the current roster represented; every wrap suite 2,
    correct channel/version/recipient, signer = caller;
  insert all wraps; current_key_version += 1; rotation_due = false;
COMMIT
```

Winner: rotation committed. Loser: `stale_key_version(current=8)` —
fetches the winning key. No mixed key generation can exist. With ≤64
members and ~188-byte signed wraps, one transaction/request is
perfectly reasonable — probably simpler than the phase-25 multi-step
protocol.

**And one explicit send gate**, frozen with the rotation fix: while
`rotation_due`, an ordinary send at the current/old key must be
rejected (`rotation_required`); the client rotates atomically and
retries the original send under the new key — still one user action.
Otherwise a sender who has not yet noticed the removal sends under the
old key and defeats the "next sender rotates first" property.

## The revised trust claims — one wording tweak

Distinguish data-access host compromise from arbitrary process
control. "Malicious code may access … even process memory" alongside
"chalkd itself is honest" lets a reader conclude
ptrace-and-patch-the-authorization-branch is in scope, at which point
claims 1 and 2 are indistinguishable. Suggested boundary: *the host is
not trusted for confidentiality or stored-data integrity (read
storage, read process memory, modify persistent data); the model does
not attempt to preserve protocol correctness if the attacker alters
chalkd's executable code or live control flow — that is equivalent to
a malicious chalkd and falls under claim 1.*

## Server pin / inner channel

Rechecked and liked: client ephemeral + server ephemeral + fresh
client nonce, server signs the transcript with the pinned Ed25519 key,
ECDH → directional session keys → AES-GCM every frame. A reasonable
application-layer answer to the browser's inability to inspect TLS
material, and the bundle-serving-MITM limit is honestly stated.

Recommendation (freeze in 83-6, not left to implementation):
domain-separate the directions —
`K_c2s = HKDF(shared, "chalk-inner-c2s-v1" || transcript_hash)`,
`K_s2c = HKDF(shared, "chalk-inner-s2c-v1" || transcript_hash)` —
bind at least protocol version, both ephemerals, the client nonce and
the server identity key into the transcript hash, use independent
monotonic per-direction nonce counters, and close the connection on
any repeated/out-of-order counter.

## Signed message envelope

Much cleaner than fanout. The good lessons are kept
(`sender_ed25519_fp`, `writer_scope`, `client_msg_id`, `object_hash`,
reply binding, attachment hashes, append-only edit ancestry) while the
machinery is gone (flaps, per-target chains, control chain, control
backup floor, gossip, grant machinery, Gate F). Sign-then-seal is
straightforward and gives actual transferable authorship, which the
revised product explicitly accepts. **No new canonical-format blocker
found in this pass.**

## One wording correction

"No identity private keys ever exist server-side" now collides with
the new server Ed25519 identity key. Intended meaning: no **user**
identity private keys, channel space keys, message keys, or message
plaintext exist server-side; chalkd necessarily holds its own
server-identity private key. State both, or an auditor flags the
literal contradiction immediately.

## Updated verdict

| Area | Result |
|---|---|
| Revised trust model | Much better |
| Malicious-server membership claim | Correctly withdrawn |
| Old R15 split-view problem | No longer applicable |
| Canonical signed envelope | Good |
| Replay identity | Good |
| Append-only edits | Good |
| Current identity authenticity | Good |
| **Retired identity authenticity under DB compromise** | **High** |
| First-responder rotation concept | Good |
| **Concurrent rotation atomicity** | **High** |
| rotation_due send gate | Must freeze with the rotation fix |
| Server pin / inner channel | Good direction; freeze the session construction |
| Host-threat wording | Clarify |
| "identity private keys" wording | Fix |

**Gate 0: OPEN — but much closer.** Do not add more heavy crypto
architecture. Two substantive changes for the next revision:
(1) cryptographically chain identity generations, so database
compromise cannot invent an Alice-A0 historical identity;
(2) replace multi-step first-responder key publication with one atomic
server-mediated rotation transaction, with `rotation_due` rejecting
old-key sends until it succeeds. After those, this version is in a far
healthier position for a clean Gate-0 pass than the previous fanout
design.

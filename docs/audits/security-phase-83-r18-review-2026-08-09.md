# Independent Security Review — Phase 83 MSGSIG (R18: third review of the signed-envelope design)

**Review date:** 2026-08-09

**Scope:** the third revision (R17 fix folded), plus a broader
adversarial pass over the trust-model claims.

**Verdict: R17-01 closed; one trust-model contradiction blocks
Gate 0.** No protocol redesign needed — the fix is narrowing a claim.

## P83-A-R18-01 — Host DB tampering can become membership/key disclosure

**Severity:** Critical / Blocking

The revised model simultaneously says: (1) chalkd is honest and
membership is server-asserted; (2) host malware may **modify
persistent server data**; (3) host compromise must not yield message
plaintext. These three cannot all hold.

Malware modifies the database and adds attacker-controlled Mallory to
Alice's channel. chalkd stays completely honest — it reads its
database and truthfully reports the roster it sees. Because Phase 83
deliberately removed cryptographically authenticated membership, the
roster is authoritative, so an honest client wraps the channel key to
Mallory:

```
host DB modification → fake membership → honest client signs a wrap
for Mallory → Mallory obtains the channel key → plaintext disclosed
```

No signature fails; no executable was modified; no control flow was
patched — squarely inside the current claim 2, directly contradicting
D.5's "host compromise … opens nothing." Depending on phase-82
join/reshare semantics it can expose **already-sent** messages too
(a newly inserted member receiving the current space key decrypts
ciphertext stored under that version).

**Why message signatures don't help:** they protect message bytes.
This attack changes *who clients believe should receive the key* and
lets honest clients do the encryption work.

**Recommendation — change the claim, not the crypto.** Do not
reintroduce signed membership chains. Narrow claim 2 to
**read** compromise: an attacker may read database, disks, backups
and process memory, and such access must not reveal plaintext or
keys; stored-object *corruption* should fail closed where feasible.
An attacker capable of **altering the authorization state chalkd
consumes** is equivalent to a malicious chalkd and falls under
claim 1. That makes the architecture internally consistent; the
alternative (authenticated membership records) walks back toward the
retired machinery and is not worth it under this model.

## Previous findings

| Item | Status |
|---|---|
| R17-01 generation-cert encoding | **Closed** — canonical excludes `sig64`; root frozen as `chalk-idgen-root.v1` |
| Atomic rotation | Closed — version-bound `rotation_due`, complete wrap set inserted before the version advances |
| Send gate | Closed — `rotation_required` while due |
| Malicious rotator | Correctly residualized |
| Inner-channel nonce | Closed — `u32be(0) \|\| u64be(counter)` frozen |

## Minor wording

D.2's "marks the channel rotation due, version v+1" should phrase the
stored structure consistently: *on any membership shrink at current
version v, the server stores `rotation_due.from_version = v`; the
required successor is exactly v+1.* Editorial.

## Updated audit status

| Item | Status |
|---|---|
| Signed envelope | Good |
| Generation certificate | Good |
| Historical identity chain | Good |
| Atomic rotation + send gate | Good |
| Malicious rotator residual | Good |
| Inner pinned channel | Good |
| Malicious-server withdrawal | Good |
| **Host DB write + unauthenticated membership** | **Critical** |
| Gate 0 | **OPEN** |

The design works nicely if the intended model is: honest chalkd and
trusted integrity of its authorization state, untrusted host for
confidentiality/read access — a perfectly defensible and dramatically
simpler security model. With claim 2 narrowed accordingly (and "host
may modify persistent server data" / "opens nothing" qualified), the
next review should be primarily a final claim-consistency pass.

## Author's disposition (scuq, 2026-08-09)

The claim is lowered as recommended — database manipulation is
acknowledged as a real, undefended threat to authorization state —
**and** two mitigations were commissioned rather than leaving it at
wording: a client-derived roster-diff notice in every channel (a
membership change is announced to users even when it was produced by
direct database manipulation, because clients diff the roster they
see, not the events the server chooses to emit), and a hardening
phase (99, `PHASE-99-DBCREDS.md`) to store database credentials more
securely at rest and in chalkd's memory, raising the cost of the DB
write in the first place.

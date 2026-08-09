# Independent Security Review — Phase 83 MSGSIG (R19: fourth review of the signed-envelope design)

**Review date:** 2026-08-09

**Scope:** the fourth revision (R18 fix folded); final adversarial
pass over the combined claims.

**Verdict: R18 closed correctly; one remaining Critical claim
mismatch, from combining claim 2 with claim 3.** Narrower than the
previous problems; the preferred fix makes no protocol change.

## P83-A-R19-01 — Reading the server identity key can lead to channel-key disclosure

**Severity:** Critical / Gate blocker

Claim 2 allowed malicious host code to read chalkd **process memory**,
and the residual said "stealing the server identity key → impersonate
the server, not read history." But with the simplified model,
impersonating the server is enough to influence the roster, and phase
82 intentionally auto-reshares the channel key to whoever the server
says is a member:

```
host read compromise
  → steal chalkd's Ed25519 server identity private key from memory
  → MITM a client and pass D.3's pinned-server handshake
  → present a roster containing Mallory
  → the client auto-reshares a signed channel-key wrap to Mallory
  → Mallory decrypts the current channel key
```

No database write necessary — conflicting with claim 2's "must not
yield already-sent messages" (and depending on key-version lifetime,
the current space key opens already-stored ciphertext of that
version, not merely future traffic).

**R18 itself is closed** — the trusted/untrusted split (protocol
behaviour + authorization-DB integrity trusted; storage
confidentiality untrusted) is exactly the right simplification. The
only problem is that the server-identity private key crossed the
boundary: claim 2 allowed stealing it while claim 3 makes possession
equivalent to authenticated chalkd.

**Recommended solution — Option A, narrow claim 2 one final time** (the
smallest fix and the best fit): define claim 2 as a **server-storage
compromise claim**. An attacker may read the database, filesystem
data, backups, logs and snapshots; such access reveals no channel
space keys, message plaintext, message keys, or user identity private
keys. Live compromise of chalkd's process, its server-identity
private key, or its protocol execution is equivalent to compromise of
chalkd and outside this claim. The resulting model is standard and
understandable — *server-side data breach does not reveal message
contents* — and very clean:

```
DB dump / stolen disk / backup     → E2EE holds
live chalkd compromise             → trusted endpoint lost
authorization DB modification      → trusted endpoint lost
server identity private-key theft  → trusted endpoint lost
```

(Option B — keep live-memory compromise and move the server key into
a TPM/HSM chalkd can use but not export — works, but reintroduces
deployment complexity contrary to the simplification just achieved.)

## D.6 is useful, but one claim is too strong

Keep the client-derived roster diff as defense-in-depth, but "a silent
membership edit is impossible even for a pure DB insert" overstates
it. The property actually guaranteed: *a persisted unauthorized
membership change is surfaced when an existing client next observes a
roster containing that change* — an attacker could manipulate and
restore a roster while clients are offline, and visibility timing
depends on refresh and wrap flows. The "the user has been told before
the key-wrap" wording is only valid if the ordering is frozen:

```
fetch roster → compute diff → persist + surface additions
            → only then permit rewrapForMissing(new roster)
```

An inexpensive hardening worth freezing; not a Gate blocker if D.6 is
described as detection.

## Everything else now looks good

Identity-generation chain (canonical/signature/root) correct; rotation
(`rotation_due.from_version`, strict send gate, complete wrap set,
atomic transaction) correct; malicious rotator appropriately an
availability residual; signed messages clean and dramatically easier
to reason about than the retired fanout design; inner-channel
transcript binding, directional HKDF, GCM nonce construction and
counter checking good; authorization-DB writes now honestly out of
scope.

## Gate status

| Area | Status |
|---|---|
| R17 identity-chain blocker | Closed |
| R18 authorization-DB contradiction | Closed |
| Atomic rotation + send gate | Good |
| Signed message envelope | Good |
| Server inner-channel construction | Good |
| D.6 roster observation | Useful mitigation |
| **Live host read → server-key theft → fake roster → key reshare** | **Critical** |

**Gate 0: OPEN, one claim-boundary issue remaining.** The preferred
next revision makes no protocol change at all: redefine claim 2 as
protection against persistent server-storage disclosure, and classify
live process/key compromise with malicious chalkd.

# Independent Security Review — Phase 83 MSGSIG (R20: the final pass)

**Review date:** 2026-08-09

**Author's note on scope:** this pass examined the fourth-revision
text (the quotes below — claim 2 permitting process-memory reads,
D.3's and D.5's "impersonate the server, not read history", D.6's
"impossible" — are from that state). The fifth revision, committed at
`5dec77a` while this review was in flight, had already applied
recommendations 1 and 2 (claim 2 narrowed to persistent storage;
server-key theft inside the malicious-chalkd boundary). The sixth
revision applies recommendations 3 and 4 verbatim. Recorded here
unabridged because it is the review whose checklist Gate 0's pass is
conditioned on.

**Final verdict: Gate 0 OPEN — one Critical claim-boundary fix
remains; no protocol redesign needed.** All previous protocol findings
remain closed.

## P83-A-R19-01 — still open (in the reviewed text)

Claim 2 said malicious code may read "server storage … and process
memory" and acknowledged the server-identity key exists there
("stealing it impersonates the server, it opens no history"); D.3 and
D.5 repeated it. That conclusion is not valid with server-asserted
membership:

```
read chalkd process memory → steal the server Ed25519 identity key
→ MITM a legitimate client → pass the pinned D.3 handshake
→ behave as a fake chalkd → present a roster containing Mallory
→ honest client wraps the space key to Mallory → Mallory has the key
```

The D.6 notice doesn't prevent this; it only reports Mallory's
appearance. These cannot all be simultaneously true: arbitrary
process-memory read in scope; the server key readable there;
possession of that key authenticating chalkd; chalkd membership
assertions causing clients to reshare keys; and process-memory reads
not revealing message keys. Message signatures don't help — the
attacker isn't forging Alice's messages, they're convincing Alice
that Mallory belongs in the recipient set.

**The fix is very small** — narrow claim 2 to persistent-data
compromise:

> Server persistent storage is not trusted for confidentiality. An
> attacker may read the database, filesystem, backups, logs and
> stored ciphertexts. Such access must not reveal message plaintext,
> channel space keys, message keys, or user identity private keys.
> Compromise of chalkd's live process, live protocol execution,
> authorization state, or server-identity private key is equivalent
> to compromise of chalkd itself and falls under claim 1.

The resulting boundary:

| Compromise | Security result |
|---|---|
| DB dump | E2EE holds |
| stolen backup | E2EE holds |
| disk snapshot | E2EE holds |
| stored ciphertext theft | E2EE holds |
| corrupt stored signed object | detected / fails closed |
| authorization DB modification | malicious-chalkd boundary |
| server identity key theft | malicious-chalkd boundary |
| live process control | malicious-chalkd boundary |

Also rename the residual "Host compromise (read)" to something like
**"Server-storage disclosure"** — "host compromise" normally implies
much broader control than obtaining a database dump.

## D.6 needs one wording downgrade

Keep D.6, but "a silent membership edit is impossible even for a pure
DB insert" is too absolute. The actual guarantee:

> D.6 surfaces unauthorized roster changes to any existing client
> that observes the changed roster; it is detection, not prevention,
> and provides no guarantee against changes that are never observed.

(Example: DB-add Mallory, no client refreshes, DB-remove Mallory — no
client necessarily observes anything. Those cases are already outside
claim 1, so this is not a security blocker; just avoid "impossible".)
The "user has been told before the key-wrap" sentence is only
strictly true if the implementation freezes
observe → persist diff → render notice → allow rewrap. If the
stronger UX property is wanted, freeze that order; otherwise say the
notice and rewrap are caused by the same observed roster update
without claiming the human necessarily sees the notice first.

## Everything else passes this review

- **Identity continuity:** `chalk-idgen.v1` no longer circular;
  signature outside the canonical; deterministic generation hashes;
  retired identities require a chain to the pin.
- **Message authenticity:** stable sender identity, replay identity,
  attachments, replies, edits and reactions bound appropriately.
- **Rotation:** shrink → `rotation_due.from_version` → old-key sends
  rejected → one atomic `rotate_channel_key` → complete v+1 wrap set →
  retry. Closes the mixed-key race; concurrent rotation resolves to
  one complete winner.
- **Malicious rotator:** accurately accepted as availability-only.
- **Server pin:** cryptographically coherent under the revised
  boundary; transcript, directional keys and the frozen 96-bit
  counter nonce are sensible.
- **Authorization integrity:** honestly assigned to claim 1.
- **Old fanout/control-chain findings:** irrelevant to this
  architecture.

## What to change before Gate 0 PASS

1. Remove process-memory read from claim 2.
2. Explicitly put server-identity key compromise inside claim 1 /
   malicious-chalkd compromise.
3. Rename the residual from "Host compromise (read)" to
   server-storage disclosure.
4. Change D.6's "silent membership edit is impossible" to the
   narrower *observed roster changes are surfaced* guarantee.

After those changes, based on the protocol and claim set reviewed, I
would be comfortable marking **Gate 0 PASS**. The remaining problem is
no longer a crypto or protocol-state blocker — the text simply
promised more protection under live server-process compromise than
the simplified architecture can provide.

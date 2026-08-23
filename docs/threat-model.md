# Threat Model

What chalk protects, what it does not, and — importantly — which of its
intended guarantees are **not yet met**. Every claim below is meant to be
checkable against the code; where a guarantee is aspirational it says so
rather than rounding up.

Last reviewed: 2026-08-09 (the trust-model revision).

## The trust model (revised 2026-08-09)

chalk's claims were re-scoped by scuq after the phase-83 fanout design's
review series established what defending against an actively malicious
server actually costs (the decision record in
[phases/PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md); the retired
design at git `731eac5`). The claims are now exactly these:

1. **chalkd is honest.** The server software is trusted to run the
   protocol as written — store faithfully, deliver to the right
   members, assert membership and ordering truthfully. chalk makes
   **no** claim against a chalkd that actively lies.
2. **The host is not trusted for confidentiality of persistent
   storage — a server-side data breach must not reveal message
   contents** (narrowed 2026-08-09 twice, R18 then R19, to this final
   form). An attacker may read the database, filesystem data,
   backups, logs and snapshots, and such access yields **no** message
   plaintext, message keys, channel space keys, or *user* identity
   private keys — none ever exist server-side. Three things are
   explicitly **equivalent to a malicious chalkd** and outside this
   claim: altering chalkd's executable code or live control flow;
   **altering the authorization state chalkd consumes** (membership
   is server-asserted, so a database write that inserts a principal
   makes honest clients wrap the channel key to it — **database
   manipulation is a real threat and chalk does not defend
   authorization state against it**, mitigated by phase 83's
   client-derived roster-diff notices, which surface a persisted
   change before any auto-reshare wraps to it, and by phase 99's
   credential hardening,
   [phases/PHASE-99-DBCREDS.md](phases/PHASE-99-DBCREDS.md)); and
   **live compromise of chalkd's process, memory included** — the
   server-identity private key lives there, its holder *is* the
   server to every pinned client, and clients auto-reshare to the
   roster the server presents (the R19 finding). The clean model:
   a DB dump, stolen disk or backup opens nothing; live chalkd
   compromise, authorization-table modification, or server-key theft
   is a lost trusted endpoint. Stored *cryptographic* objects —
   ciphertexts, wraps, identity records — remain tamper-evident and
   fail closed under phase 82's and 83's signatures; it is the
   authorization tables whose integrity is trusted.
3. **A client can detect a MITM toward its home server.** The network
   path is untrusted even with valid TLS; the client pins the server
   identity it registered with and proves it at every connection
   through an inner sealed channel (phase 83, built).

An operator (or intruder) who makes chalkd itself misbehave is
therefore outside the model — that is claim 1's boundary, stated here
once and referenced below rather than hedged in every section.

## What is actually built

- **Message and attachment bodies are encrypted in the browser** under
  per-channel space keys (AES-256-GCM), which are themselves wrapped to each
  member's X25519 identity key. The server stores ciphertext and opaque wraps.
  (`web/src/crypto/`, phases 22–25.)
- **Identity keys** are per-user X25519 + Ed25519, derived from a 24-word
  BIP-39 encryption phrase that never leaves the client.
- **Account auth is password + mandatory TOTP** (auth v2, phase 31). Passkeys
  are an additional convenience factor, never a bypass of the second factor.
- **Voice and video** ship (phase 30) and are E2E encrypted by WebRTC's DTLS,
  with the peer fingerprints signed by each side's Ed25519 identity key and
  verified before media flows (`web/src/voice/signal-crypto.ts`).
- **Transport** is TLS 1.3; the SPA is served with a restrictive CSP
  (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`).
- **Every message, edit and reaction is a signed sealed envelope**
  (phase 83): a canonical Ed25519-signed object inside the existing
  space-key encryption, verified fail-closed against pinned identities
  with typed verdicts (`verified` / `verified-former-identity` /
  `mismatch` / `forged` / `unpinned` / `unsigned`), a replay-triple
  dedup, append-only edit revisions whose chain is verified back to
  the original, and identity generations linked by signed
  `chalk-idgen.v1` certs so a database row alone can never mint a
  "retired identity" (`web/src/crypto/envelope.ts`, `idgen.ts`,
  `revisions.ts`).
- **Key rotation on membership shrink is first-responder and atomic**
  (83-5): the next sender uploads every member's signed wrap and the
  version bump in one transaction; sends are gated (`rotation_required`)
  until it commits, so content is never sealed under a key a removed
  member still holds.
- **The home server's identity is pinned** at registration and proven
  at every connect through an inner sealed channel over the WebSocket
  (83-6, `internal/innerchan`, `web/src/crypto/innerchan.ts`); a
  changed key stops the client at a fingerprint-comparison wall.
- **Roster changes are client-observed** (83-7, D.6): each device
  diffs the membership it sees against the set it last persisted and
  surfaces additions, removals and key changes as "observed" notices
  — recorded before any auto-reshare wraps to a newcomer.

## Guarantees not met, or not met unconditionally

Intended properties the current implementation does not deliver outright.
Listed first, because a threat model that buries its gaps is worse than none.
One of them is now met *provided the operator has turned a setting on*, which
is written as such rather than rounded up to "fixed".

### Confidentiality against a malicious server — **conditionally met (phase 82)**

This was the phase-81 audit's C-01 and the gravest gap in the design. Phase 82
(`docs/phases/PHASE-82-SIGNEDWRAP.md`) closed it, but **the last step is the
operator's**, so the honest answer depends on one setting.

What phase 82 built:

- **Signed wraps** (suite 2). Every channel-key wrap chalk produces carries an
  Ed25519 signature over the sealed bytes *and* the slot — channel, key
  version, recipient, signer — under the canonical `chalk-wrap-sig.v1`
  encoding. Verify-then-decrypt, so a forged wrap never reaches the X25519
  private key.
- **An identity anchor.** A signature is only worth the answer to "which key is
  Bob's?", and before phase 82 that answer came from the server. Trust-on-
  first-use pinning (`web/src/crypto/trust.ts`) commits the server to its first
  answer about a peer, and the picture-word check (below) is now the *same*
  record at a higher assurance level rather than a parallel universe the crypto
  path could not read.
- **Downgrade resistance.** Once a device has opened one signed wrap for a
  channel, an unsigned one is refused for that channel at any key version; a
  filled key slot is never silently replaced; and the server refuses one member
  overwriting another's wrap slot except as a suite upgrade.
- **Guest links** carry the owner's public key in the URL fragment — the one
  value the server never sees — and the guest verifies against it.

**The condition.** Existing channels were full of unsigned wraps, so refusing
them outright would have locked users out of their own history. Instead a
self-healing sweep re-signs wraps as channels get used, and
`CHALK_WRAP_SIG_REQUIRED` is what finally withdraws acceptance of unsigned ones.
With the flag off, a server that reaches a channel before any current-build
member has opened it can still substitute a key.

Since 82-10 the flag defaults to **true**, so a new deployment meets this
guarantee out of the box — it has no legacy wraps to strand. The condition now
applies only to a deployment that predates phase 82:

> **For operators upgrading an existing deployment:** `chalkctl update` leaves
> your current setting alone, which for almost everyone is `false`. Run
> `chalkctl wrapsig status` until it reports READY — that means the sweep has
> re-signed every member's wraps — then `chalkctl wrapsig enable`. **Until you
> do, this guarantee is not met on your deployment.** `chalkctl wrapsig disable`
> puts it back if someone is stranded.

**Where this guarantee's edge now sits (revised 2026-08-09).** Channel
membership is asserted by the server and signed by nobody, and any key
holder auto-reshares the key to whoever appears in the roster. A server
that adds a principal it controls is therefore handed the key by a
legitimate member's client — signing a wrap proves who *sent* a key,
not who *deserved* one. Under the revised trust model this is an
**accepted property, not a gap**: claim 1 trusts chalkd not to do it,
and the client keeps it visible rather than silent (a join notice, and
a per-key provenance line in the members panel). What phase 82's
signatures + pins defend, and defend well under claim 2, is the *host*:
malware that tampers with stored wraps or substitutes key material in
the database is caught by verify-then-decrypt against pinned
identities. The former plan to authenticate membership itself (anchored
certificate chains) was retired with the malicious-server claim —
record in [phases/PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md).

TOFU's own limit is also worth stating plainly: a server that lies from the
*very first* fetch of a peer gets its key pinned, and only the out-of-band
picture-word comparison ever detects that. What pinning closes is every *later*
substitution.

### Sender authenticity — **met (phase 83), with stated residuals**

Since phase 83 the body plaintext of every message, edit and reaction is
a canonical, Ed25519-signed envelope — sender, the signing identity
generation, the sender's own timestamp, parent/thread binding, body, and
attachment digests — signed then sealed under the existing space-key
encryption. Verification is fail-closed and typed: a server that
relabels the outer frame yields `mismatch` (the signed values win and
are what renders), a member forging another member's speech yields
`forged`, and content is displayed under an unmistakable warning rather
than dropped. The signing generation is sealed into every envelope and
resolved through the signed `chalk-idgen.v1` generation chain, so
history stays verifiable across key rotations and a fabricated
"retired identity" database row proves nothing.

Residuals, stated plainly:

- Server-minted message ID, timestamp and sequence stay *outside* the
  signature as receipt metadata: replay and re-dating are
  **detectable** (the replay triple renders once; the signed
  `sender_ts` is shown alongside receipt time), not prevented — and
  under claim 1 the server is trusted not to do them.
- Messages sent by builds predating phase 83 render uniformly as
  **`(unsigned)`** — one quiet label, no alarm, no false claim.
- Guest sends and pre-83 sealed reaction sets remain unsigned
  (recorded caveats in the phase doc).
- Signatures are transferable proof of authorship — the earlier fanout
  design's deniability was retired with its threat model.

## Adversaries chalk does defend against

### Network attackers (passive and active)

All traffic is TLS 1.3. Message-layer encryption sits inside it, so breaking
TLS does not by itself yield message bodies. An active attacker with a valid
certificate (CA mis-issuance, DNS takeover) occupies the server's *network*
position; phase 83's server-identity pin and inner sealed channel detect
someone other than the registered home server answering: the client pins the
server's Ed25519 identity at registration, every connection proves it over a
signed handshake, and every frame after it is sealed under per-direction
keys a TLS-terminating MITM does not hold. A changed key stops the client at
a fingerprint-comparison wall that only an explicit human choice clears. Two
honestly-stated limits: a MITM present at first registration wins that
device's pin, and a MITM that serves the SPA bundle itself is endpoint
compromise no in-page mechanism can detect (an installed PWA's cached bundle
narrows that window; it does not close it).

### A server reading message content *by accident*

Distinct from a *malicious* server: bodies are ciphertext in Postgres, so
backups, logs, an idle admin browsing tables, or a stolen database dump do
not expose message content. This is the guarantee that genuinely holds today,
and it is the one most compromises actually involve.

The server still sees metadata in every case:

- who has accounts (usernames, public keys)
- who is in which channel
- when messages were sent — timestamps and ordering
- message and attachment sizes
- coarse online/offline status
- that a message was edited and when — not its old or new text
- who reacted to which message and when — **not which emoji**: a reaction is
  one row per (message, reactor) holding that reactor's emoji set sealed
  under the channel key

### Stolen credentials

Three separate secrets with three separate consequences:

- The **password** (+ TOTP) grants account access. Alone it does not decrypt
  history on a new device unless the seed wrap is present.
- The **recovery phrase** resets the password. It is a reset, not a login:
  it also requires a live TOTP code, or an explicit `reset_totp` that clears
  the second factor for re-enrollment.
- The **24-word encryption phrase** is the decryption root — it derives the
  identity key and unwraps space keys. Guard it like a wallet seed.

Since phase 81: changing the password revokes every other session, a recovery
reset revokes all of them, and both close the corresponding live WebSocket
connections. Rotating the recovery phrase, replacing TOTP, and adding or
removing a passkey each require the current password plus a live code, so a
stolen session cannot be escalated into permanent account takeover. Sessions
also expire 90 days after sign-in regardless of activity.

### Identity-key substitution

Two defences, at two assurance levels, sharing one record since phase 82:

- **Trust-on-first-use pinning.** The first time this device resolves a peer's
  identity key it pins it. A later change is surfaced as "key changed" in the
  members panel, behind a wall that says what it means, and the crypto path
  refuses to adopt key material signed by a repudiated pin. This is automatic
  and needs no user action.
- **Picture-word verification** (phase 24): an out-of-band comparison that both
  sides see the same fingerprint. Since 82-2 this upgrades the same pin rather
  than living in a parallel store the crypto path could not read.

Limits, stated plainly: TOFU cannot detect a server that lies from the very
first fetch of a peer — only the out-of-band check does that. Verification
remains optional and advisory for *conversation*: chalk will not stop you
talking to an unverified peer. It is no longer advisory for *key adoption*.

Both records survive the loss of a browser profile since phase 84: the pin set
is backed up through user prefs as AES-256-GCM ciphertext under a key derived
from the identity's X25519 scalar, so a new device restores its pins instead of
meeting every peer as a stranger — which is the one state in which a
substitution is adopted in silence. The server holds the blob and can neither
read a pin nor forge one; a tampered blob fails its tag and is discarded. What
it *can* do is withhold the blob or serve an older one, and neither gains it
anything: the merge only ever adds a record or strengthens the evidence behind
one, so a stale copy cannot delete a pin or downgrade it, and a withheld one
leaves the device where it would have been with no backup at all.

The merge deliberately refuses the obvious rule. If a device that pinned a
substituted key on first sight could overwrite a device holding the real one,
the backup would launder the attack into the machine that was about to catch
it. So a plain sighting never overturns another: same key merges, an
out-of-band comparison wins, and between two uncompared sightings the earlier
one stands. A peer who genuinely reinstalled therefore reads as "key changed"
until someone compares the new number out of band — an alarm rather than a
silent adoption, and one comparison settles it for every device at once.

### Online guessing and resource exhaustion

Anonymous auth endpoints carry per-IP rate limits, with a much tighter budget
on the Argon2-heavy recovery paths and a concurrency bound on memory-hard
hashing (phase 81). TOTP has a per-account failure lockout. The in-flight
ceremony and pending-signup caches are size-capped.

Per-IP limits require `CHALK_TRUSTED_PROXY` to be set behind a reverse proxy;
`chalkctl` generates it. Without it every request appears to come from the
proxy and the limits collapse into one shared bucket.

## Adversaries chalk does NOT defend against

### Endpoint compromise

An attacker with live access to your unlocked device reads everything you
read. No E2E system defends against this.

### An actively malicious chalkd — by decision, not omission

The revised trust model (top of this document) trusts the server
software *and the authorization state it consumes*. A chalkd made to
lie — by its operator, by compulsion, by an intruder who reads or
controls the running process (the server-identity key lives in its
memory — claim 2's R19 boundary), **or by anyone who can write its
database's membership tables** (the R18 boundary) — can
misassert membership (and be handed channel keys by honest clients),
reorder and replay, withhold, and partition. The client keeps membership changes
visible (join notices, wrap provenance), which is not prevention and is
not claimed to be. What even a lying chalkd never gets: message
plaintext it was not legitimately sent, or the ability to substitute
stored key material undetected (phase 82's wraps + pins hold
regardless, because they bind to client-side identities it does not
control). The retired fanout design and its audit trail
(`docs/audits/`, git `731eac5`) document exactly what closing this
would take — quorum or witness machinery — if the claim is ever
revisited.

### Traffic analysis

Packet timings and sizes are visible. chalk does not pad messages, add cover
traffic, or hide that you use chalk.

### Denial of service

Rate limits blunt casual abuse. A well-resourced DDoS is the operator's
problem (Cloudflare or similar).

### Compelled access to the server

A subpoena yields metadata, ciphertext, wrapped keys, and credential hashes —
not plaintext message bodies. This is claim 2 doing its job, and it covers
the common compelled case (hand over the data) and the common intrusion case
(read the storage). An operator compelled to *act* — to make chalkd lie — is
the actively-malicious-chalkd case above, outside the revised trust model:
they cannot substitute a channel key (`CHALK_WRAP_SIG_REQUIRED`), but they can
add a principal and be handed the key by a member's client. Treat legal
compulsion as covered for *past* messages; *future* ones depend on the
operator staying honest, which is claim 1 stated in legal terms.

### Guest links

Whoever holds an unexpired ephemeral guest link **is** that guest; the link
is the credential. Links are shown once, live at most 24 hours, and can be
revoked. Guest rooms are off unless the operator enables them.

### Active MITM during initial registration

WebAuthn binds a passkey to the chalk origin, so a passkey registered on a
fake origin belongs to that origin. Mitigated by correct RP-ID locking to the
canonical origin.

## Out of scope

- Federation (server-to-server, à la Matrix) — considered and declined,
  and under the revised trust model effectively closed: claim 1 trusts
  *your own* chalkd, and membership is server-asserted by design, so
  federating would extend that full trust to servers the operator does
  not run. Reasoning, and what *does* work across deployments, in
  [phases/PHASE-88-FEDERATION.md](phases/PHASE-88-FEDERATION.md).
- Anonymity (no Tor integration, no IP hiding)
- Anti-spam beyond rate limits
- Forward secrecy and post-quantum security — explicit non-goals of the
  phase 22+ design

## Cryptographic primitives

All client-side crypto is native WebCrypto; nothing is bundled or hand-rolled.

| Purpose | Primitive |
|---|---|
| Password → master key | Argon2id, server floor 256 MiB / 3 passes / 1 lane |
| Auth proof & KEK | HKDF-SHA256 over the master key |
| Recovery-phrase hashing | Argon2id, 64 MiB / 1 pass / 2 lanes (the phrase carries 256 bits, so the cost is anti-theft, not anti-guessing) |
| Identity keys | X25519 (agreement) + Ed25519 (signatures) |
| Key wrapping | Ephemeral X25519 + HKDF-SHA256 + AES-256-GCM |
| Message & attachment bodies | AES-256-GCM, random 96-bit nonces |
| TOTP secrets at rest | AES-256-GCM under `CHALK_TOTP_ENC_KEY` |
| Transport | TLS 1.3 |
| Voice/video media | DTLS-SRTP, fingerprints signed with Ed25519 |

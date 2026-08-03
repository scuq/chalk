# Threat Model

What chalk protects, what it does not, and — importantly — which of its
intended guarantees are **not yet met**. Every claim below is meant to be
checkable against the code; where a guarantee is aspirational it says so
rather than rounding up.

Last reviewed: phase 82 (signed channel-key wraps).

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

## Guarantees not met, or not met unconditionally

Intended properties the current implementation does not deliver outright.
Listed first, because a threat model that buries its gaps is worse than none.
One of them is now met *provided the operator has turned a setting on*, which
is written as such rather than rounded up to "fixed".

### Confidentiality against a malicious server — **conditionally met (phase 82)**

This was the phase-81 audit's C-01 and the gravest gap in the design. Phase 82
(`docs/PHASE-82-SIGNEDWRAP.md`) closed it, but **the last step is the
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
`CHALK_WRAP_SIG_REQUIRED` (default **false**) is what finally withdraws
acceptance of unsigned ones. With the flag off, a server that reaches a channel
before any current-build member has opened it can still substitute a key.

> **For operators: turn `CHALK_WRAP_SIG_REQUIRED` on once your users have been
> on a current build for a while.** Until you do, this guarantee is not met on
> your deployment.

**What remains unmet even with the flag on.** Channel membership is asserted by
the server and signed by nobody, and any key holder auto-reshares the key to
whoever appears in the roster. A server that adds a principal it controls is
therefore handed the key by a legitimate member's client. Signing a wrap proves
who *sent* a key, not who *deserved* one. The client makes this visible rather
than silent (a join notice, and a per-key provenance line in the members
panel); the fix is phase 83's authenticated channel-state transcript.

TOFU's own limit is also worth stating plainly: a server that lies from the
*very first* fetch of a peer gets its key pinned, and only the out-of-band
picture-word comparison ever detects that. What pinning closes is every *later*
substitution.

### Sender authenticity — **NOT met**

Message ciphertext carries no sender signature, and the AEAD associated data
is only `suite + channel ID + key version`
(`web/src/crypto/spacekey.ts`). Sender, device, message ID, timestamp, and
thread relationship are all plaintext metadata attached by the server,
*outside* what the encryption authenticates.

Two consequences:

- A malicious server can replay a ciphertext it has seen under a different
  sender, timestamp, or thread, and the recipient's decryption still
  succeeds.
- Every member of a channel holds the same symmetric key, so the ciphertext
  alone cannot prove which member wrote it. An honest server enforces
  attribution from the authenticated connection; a dishonest one need not.

The fix is a signed message envelope binding the sender's identity and the
server-supplied metadata to the ciphertext, covering edits, reactions, and
attachment references as well. This is phase 83, and the expensive half of it
— the identity anchor a signature would be checked against — was already paid
for by phase 82.

## Adversaries chalk does defend against

### Network attackers (passive and active)

All traffic is TLS 1.3. Message-layer encryption sits inside it, so breaking
TLS does not by itself yield message bodies — subject to the malicious-server
section above, since a TLS-breaking active attacker occupies the server's
position and inherits whatever that position can still do on your deployment.

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

### Malicious server, for membership — see above

Listed here as well so it is not missed. Channel *content* is defended once
`CHALK_WRAP_SIG_REQUIRED` is on; channel *membership* is not defended at all
yet, and a server that adds a principal it controls will be handed the key by
a member's client. The client makes that visible, which is not the same as
preventing it. Phase 83.

### Traffic analysis

Packet timings and sizes are visible. chalk does not pad messages, add cover
traffic, or hide that you use chalk.

### Denial of service

Rate limits blunt casual abuse. A well-resourced DDoS is the operator's
problem (Cloudflare or similar).

### Compelled access to the server

A subpoena yields metadata, ciphertext, wrapped keys, and credential hashes —
not plaintext message bodies. An operator compelled to *act*, as opposed to
hand over data, is the malicious-server case above: with
`CHALK_WRAP_SIG_REQUIRED` on they cannot substitute a channel key, but they can
still add a principal to a channel and be handed the key by a member's client,
because membership is not yet authenticated (phase 83). Treat legal compulsion
as covered for *past* messages and not yet for *future* ones.

### Guest links

Whoever holds an unexpired ephemeral guest link **is** that guest; the link
is the credential. Links are shown once, live at most 24 hours, and can be
revoked. Guest rooms are off unless the operator enables them.

### Active MITM during initial registration

WebAuthn binds a passkey to the chalk origin, so a passkey registered on a
fake origin belongs to that origin. Mitigated by correct RP-ID locking to the
canonical origin.

## Out of scope

- Federation (server-to-server, à la Matrix)
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

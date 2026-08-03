# Threat Model

What chalk protects, what it does not, and — importantly — which of its
intended guarantees are **not yet met**. Every claim below is meant to be
checkable against the code; where a guarantee is aspirational it says so
rather than rounding up.

Last reviewed: phase 81 (security-audit remediation).

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

## Guarantees NOT met today

These are intended properties of the design that the current implementation
does not deliver. They are listed first because a threat model that buries
its gaps is worse than none.

### Confidentiality against a malicious server — **NOT met**

A channel key is encrypted *to* each recipient but is **not signed by
anyone**. Anyone who can write the `channel_keys` row — which includes the
server itself — can construct a valid-looking wrap around a key of their own
choosing, because producing a wrap needs only the recipient's public key, and
the server stores those.

The sharpest instance is channel bootstrap: the creator publishes its own
wrap, reads it back, and adopts whatever decrypts
(`web/src/crypto/channel-crypto.ts`). A server that answers that read-back
with its own wrap gets its chosen key adopted *and then redistributed to the
whole channel by the legitimate creator*. Key rotation and first-unwrap on a
recovered device have the same weakness in weaker form.

Picture-word verification (below) checks *identity* keys. It does not cover
the provenance of a channel-key wrap, and nothing in the client consults a
peer's verification state before accepting one.

**Until this is fixed, do not rely on chalk to keep message content from the
server operator.** The fix is a signed key-distribution protocol: a canonical
wrap envelope signed by the sender's Ed25519 identity key, binding channel,
key version, recipient, and wrap bytes, verified before the key is persisted.

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
attachment references as well.

## Adversaries chalk does defend against

### Network attackers (passive and active)

All traffic is TLS 1.3. Message-layer encryption sits inside it, so breaking
TLS does not by itself yield message bodies — subject to the malicious-server
gap above, since a TLS-breaking active attacker in the server's position
inherits the same unsigned-wrap opportunity.

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

A malicious server can hand you a wrong *identity* public key for a peer. The
defense is **picture-word verification** (phase 24): an out-of-band check
that both sides see the same identity fingerprint.

Its limits, stated plainly: it is optional, it is advisory (the client does
not refuse to talk to an unverified peer), and — per the first section — it
does not protect channel-key distribution.

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

### Malicious server, for content — see above

Listed here as well so it is not missed: this is currently an *undefended*
adversary, not a defended one.

### Traffic analysis

Packet timings and sizes are visible. chalk does not pad messages, add cover
traffic, or hide that you use chalk.

### Denial of service

Rate limits blunt casual abuse. A well-resourced DDoS is the operator's
problem (Cloudflare or similar).

### Compelled access to the server

A subpoena yields metadata, ciphertext, wrapped keys, and credential hashes —
not plaintext message bodies. But an operator who is compelled to *act*, as
opposed to hand over data, can exploit the unsigned-wrap gap to obtain
subsequent plaintext. Treat legal compulsion as covered only once that gap is
closed.

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

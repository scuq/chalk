# Threat Model

> **Current status (phase 21).** chalk is presently a **plaintext** group
> chat: MLS was removed in the 21-series rip-out, and the
> identity-wrapped-space-key encryption is not yet built (phases 22–25).
> **Right now the server operator and anyone with server/database access
> can read message content.** The confidentiality guarantees described
> below are the phase 22+ target. This document states both: what holds
> today, and what the rebuild restores. Don't rely on the future guarantees
> until phase 23 ships and is verified.

## Adversaries chalk will defend against (phase 22+)

### Malicious or compromised server operator

Goal: anyone with full server access cannot read message content,
attachment content, or private settings. They will still see metadata:

- Who has accounts (handles, public keys)
- Who is in which channel
- When messages were sent (timestamps, ordering)
- Sizes of messages and attachments
- Coarse online/offline status

**Today this goal is NOT met** — messages are plaintext in Postgres. It is
restored when space-key encryption lands (phase 23): the server holds only
wrapped keys it cannot unwrap and ciphertext it cannot read.

### Network attackers (passive and active)

All traffic is over TLS (auto-issued via Let's Encrypt or operator certs).
Under phase 23+, message-layer encryption sits inside TLS, so an adversary
who breaks TLS still cannot read message bodies. Today, only TLS protects
content in transit.

### Stolen recovery code / stolen phrase (phase 22+)

Two separate secrets, two separate consequences:
- A leaked **recovery code** lets an attacker register a new passkey
  (auth). It does not by itself decrypt messages. New-device registration
  is observable to the user's other clients.
- A leaked **24-word phrase** is the decryption root — it can derive the
  identity key and unwrap space keys. It must be guarded like a wallet
  seed. (This is the cost of the "re-enter your phrase to recover history"
  capability.)

Surfacing "new device added" prominently is the primary detection
mechanism for unexpected registrations.

### Active key substitution (MITM on key distribution) (phase 24)

A malicious server could hand you a wrong public key for a peer. The
defense is the phase-24 **picture-word verification**: an out-of-band check
that both sides see the same identity. Until phase 24, there is no defense
against a server lying about peer keys.

## Adversaries chalk does NOT defend against

### Endpoint compromise (live attacker on your device)

If an attacker has live access to your unlocked device, they can read
everything you can read. No e2e system defends against this.

### Active MITM during initial passkey registration

The passkey is bound to the chalk origin via WebAuthn (phishing-resistant).
If a user is tricked into registering on a fake origin, that origin holds
their passkey. Mitigated by correct WebAuthn RP-ID locking to the canonical
chalk origin.

### Traffic analysis

A network observer can see packet timings and sizes. chalk does not pad
messages, add cover traffic, or hide that you use chalk.

### Denial of service

Per-connection and per-user rate limits only. Well-resourced DDoS is the
operator's job (Cloudflare, etc.).

### Compelled access to the server

Today a subpoena yields plaintext messages and metadata. Under phase 23+
it yields ciphertext, metadata, wrapped keys, and recovery-code hashes —
not plaintext. If your threat model includes legal compulsion, self-host
outside that jurisdiction, and do not rely on encryption until phase 23.

## Out of scope

- Federation (server-to-server like Matrix)
- Anonymity (no Tor integration, no IP hiding)
- Voice/video (chat only)
- Anti-spam beyond rate limits
- Forward secrecy and post-quantum security (explicit non-goals of the
  phase 22+ design — see the rebuild AMENDMENT)

## Cryptographic primitives

**Current:** WebAuthn / passkeys (auth), Argon2id (recovery-code hashing,
`time=3, memory=64MB, parallelism=4`), TLS 1.3 (transport). No message
encryption at rest or in the payload.

**Planned (phase 22+):** X25519 (key agreement, native WebCrypto), Ed25519
(signatures, native WebCrypto), HKDF-SHA256 (key wrapping), AES-256-GCM
(message + attachment encryption). No custom or bundled crypto — every
primitive is native WebCrypto. See the rebuild plan for details.

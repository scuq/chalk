# Threat Model

## Adversaries chalk defends against

### Malicious or compromised server operator

The server stores messages and routes them between users. chalk is designed so that anyone with full access to the server cannot read message content, attachment content, or learn private settings. They can see:

- Who has accounts (handles, public keys)
- Who is in which channel
- When messages were sent (timestamps, ordering)
- Sizes of messages and attachments
- Coarse online/offline status

This is the standard MLS deployment model: server is a smart relay, not a trusted intermediary.

### Network attackers (passive and active)

All traffic is over TLS (auto-issued via Let's Encrypt or operator-provided certs). MLS provides additional encryption inside TLS, so a network adversary who breaks TLS still cannot read messages.

Sticky-session load balancing uses IP hash, which is fine for our threat model — we don't need to hide which instance you're talking to.

### Stolen recovery phrase

A leaked recovery phrase lets the attacker register a new passkey on a new device. It does **not** let them:
- Log in directly (recovery flow is a separate endpoint)
- Read existing messages (MLS forward secrecy)
- Impersonate the user immediately (a registration step is required, which is observable to other clients)

A user noticing unexpected device additions is the primary detection mechanism. We surface "new device added" events prominently in all clients.

### Compromise of one device

MLS provides post-compromise security via key updates. After a compromised device is removed, future messages cannot be decrypted by the attacker even if they retained old key material.

Device removal is performed by any other device of the user. Cross-device coordination uses the same MLS machinery.

## Adversaries chalk does NOT defend against

### Endpoint compromise (live attacker on your device)

If an attacker has live access to your unlocked device, they can read everything you can read. No e2e system defends against this.

### Active MITM during initial passkey registration

The first passkey is bound to the chalk origin via WebAuthn, which is phishing-resistant. But if a user is tricked into registering on a fake origin, that fake origin holds their passkey. We mitigate by:
- Using `webauthn` correctly (RP ID locked to the canonical chalk origin)
- Recommending `passkeys.dev`-style verifiable deployments

### Traffic analysis

A network observer can see packet timings and sizes. We do not pad messages, do not introduce cover traffic, and do not hide the fact that you are using chalk. If you need that level of privacy, this isn't the right tool.

### Denial of service

We rate-limit per connection and per user. We do not defend against well-resourced DDoS; that's the operator's job (Cloudflare, etc.).

### Compelled access to the server

A subpoena to the operator yields ciphertext, metadata (who talks to whom, when, channel membership), and recovery code hashes. It does not yield message plaintext or attachment plaintext.

If your threat model includes legal compulsion, you must self-host on infrastructure outside that jurisdiction.

## Out of scope

- Federation (server-to-server like Matrix)
- Anonymity (no Tor integration, no IP hiding)
- Voice/video (chat only)
- Anti-spam beyond rate limits

## Cryptographic primitives in use

- **MLS** (RFC 9420) for group messaging — provides forward secrecy and post-compromise security
- **AES-256-GCM** for attachment encryption — WebCrypto-native, hardware-accelerated
- **WebAuthn / passkeys** for authentication — phishing-resistant, hardware-backed
- **Argon2id** for recovery code hashing — `time=3, memory=64MB, parallelism=4`
- **TLS 1.3** for transport (managed by Caddy or autocert)

No custom cryptography. Where possible, primitives are delegated to platform APIs (WebCrypto, WebAuthn) or audited libraries (CoreCrypto for MLS).

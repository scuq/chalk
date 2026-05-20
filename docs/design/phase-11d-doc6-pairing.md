# Phase 11d Design Doc #6 — Online Pairing Flow

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — the cryptographic operations, wire-format
field details, QR-code structure, and failure-mode specifics for the
8-frame pairing family defined abstractly in doc #2 §4
**Depends on:** doc #1 (threat model), doc #2 (wire protocol abstract
frames), doc #5 (client state machines for pairing)

This document specifies WHAT each pairing frame contains and HOW the
two devices and chalkd jointly transport the `backup_master_key` from
an existing device to a new device. Doc #5 §5 specified the state
machines; this doc fills in the field-by-field detail.

A note on terminology: this doc calls the v1 flow "pairing" rather
than "PAKE pairing" because v1 is not, strictly, a PAKE. It is
key-agreement (ECDH) authenticated by an out-of-band secret carried
in a QR code. v2 introduces a true PAKE primitive (SPAKE2+) to
support 6-digit PINs; v2 is sketched in §10 but not specified to
implementation detail.

---

## 1. Goals and non-goals

### 1.1 Goals

- **Confidentiality of master_key in transit**: chalkd, observing the
  full exchange, learns nothing about the master_key.
- **Integrity of master_key on delivery**: the new device either
  receives the correct master_key or detects tampering and aborts.
- **Replay resistance**: an attacker recording one pairing session
  cannot replay it later to extract the master_key.
- **Bidirectional confirmation**: both devices know the pairing
  succeeded before either commits to a long-lived state change.

### 1.2 Non-goals

- **PAKE-strength password authentication**: v1 relies on a 128-bit
  random OOB secret in a QR code. This is adequate AS LONG AS the QR
  is not observed. Defense against observed QR is out of scope for
  v1; see v2 sketch in §10.
- **Mutual identity attestation**: v1 does not require either device
  to prove its long-term chalk identity to the other. Authentication
  flows through chalkd's existing per-WS-connection auth. The
  critical-event-on-other-devices mechanism (per D9 in doc #1) is the
  second line of defense against unauthorized pairings.
- **Perfect forward secrecy of master_key**: master_key is a static
  user secret. Compromising the receiving device after pairing
  reveals master_key directly. This is intrinsic to the goal
  (transferring a static key), not a PAKE design flaw.

### 1.3 Threat model recap

From doc #1 §2.2:
- **A1 passive network observer**: cannot recover master_key
  (this design's primary goal).
- **A2 honest-but-curious chalkd**: cannot recover master_key
  (server sees only ECDH pubkeys + ciphertexts, never the OOB
  secret).
- **A3 hostile chalkd**: can attempt to MitM by substituting its own
  ephemeral keys. Defense: the OOB secret binds the session-key
  derivation, and chalkd does not see the OOB secret.
- **A5 stolen recovery phrase**: irrelevant to pairing (pairing uses
  master_key on the existing device, not the recovery phrase).
- **QR observation**: out of scope for v1 (Option C, doc #5 §5.4).
  v2 (SPAKE2+) addresses this.

---

## 2. Cryptographic primitives

All primitives are existing chalk dependencies. No new ones
introduced.

| Use | Primitive | Library |
|-----|-----------|---------|
| ECDH key agreement | X25519 | `@noble/curves` (already in chalk) |
| KDF | HKDF-SHA-256 | `@noble/hashes` (already in chalk) |
| AEAD | XChaCha20-Poly1305 | `@noble/ciphers` (already in chalk) |
| Random | `crypto.getRandomValues` | WebCrypto (browser native) |
| Base64url | (encoding only) | small utility |

Parameter choices:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| ECDH curve | X25519 | Standard, 128-bit security level, fast |
| KDF hash | SHA-256 | Sufficient for 128-bit security; SHA-512 wasted |
| KDF output | 32 bytes | One AEAD key |
| AEAD nonce | 24 bytes random | XChaCha20-Poly1305 standard |
| AEAD tag | 16 bytes (built into Poly1305) | — |
| OOB secret | 128 bits (16 bytes) random | Brute-force resistant offline |

---

## 3. The OOB secret and QR code

### 3.1 OOB secret generation

The initiator (existing device) generates a 128-bit random secret at
the start of every pairing offer:

```typescript
const oobSecret = new Uint8Array(16);
crypto.getRandomValues(oobSecret);
```

This secret is NEVER sent over the network. It is encoded into the
QR code that the user displays on the initiator's screen and scans
on the claimant's camera.

### 3.2 QR code content format

The QR code contains a single URL-safe string carrying everything the
claimant needs to start the pairing flow:

```
chalk-pair://v1/<pairing_id>/<initiator_ephemeral_pubkey>/<oob_secret>
```

Where each segment is base64url-encoded:
- `pairing_id`: 16 bytes (UUID without dashes) → 22 chars b64url
- `initiator_ephemeral_pubkey`: 32 bytes (X25519 pubkey) → 43 chars b64url
- `oob_secret`: 16 bytes → 22 chars b64url

Total payload string length: ~95 chars + scheme/path prefix ≈ 110-120
characters. Easily fits in a QR code at moderate density.

Example (illustrative, not real bytes):

```
chalk-pair://v1/AAECAwQFBgcICQoLDA0ODw/<base64url(32-byte pubkey)>/<base64url(16-byte secret)>
```

The `chalk-pair://` scheme is reserved for chalk's URL handling. On
mobile, this can deep-link into the chalk app. On desktop, the
claimant device's chalk client opens its camera and scans, then
parses the URL directly.

### 3.3 QR code lifetime

The QR code is valid for 5 minutes from generation. The initiator
device displays a countdown timer in the UI. After 5 minutes, the
displayed QR no longer works (server returns `pairing_expired`); the
user generates a new one.

### 3.4 What chalkd sees vs doesn't

The QR code is transferred **camera-to-screen, OUT OF BAND**. chalkd
never sees it.

What chalkd DOES see:
- The initiator's WS frame creating the pairing offer (containing
  `initiator_ephemeral_pubkey`, NOT containing `oob_secret`)
- The claimant's WS frame claiming the pairing (containing
  `claimant_ephemeral_pubkey`, NOT containing `oob_secret`)

chalkd never holds enough information to derive the session key.
This is the critical security property.

---

## 4. Key derivation

After both devices have exchanged ephemeral pubkeys (via chalkd as a
relay), each independently derives the same session key.

### 4.1 ECDH shared secret

Both sides compute:

```
# Initiator side:
shared_ikm = X25519(initiator_eph_priv, claimant_eph_pub)

# Claimant side:
shared_ikm = X25519(claimant_eph_priv, initiator_eph_pub)

# Both arrive at the same 32-byte shared secret.
```

### 4.2 Session-key derivation

```
session_key = HKDF-SHA-256(
  ikm = shared_ikm,
  salt = oob_secret,
  info = pairing_kdf_info(pairing_id, initiator_eph_pub, claimant_eph_pub),
  length = 32 bytes,
)

where pairing_kdf_info(pid, ipk, cpk) =
  utf8("chalk.pairing.v1") || pid || sha256(ipk) || sha256(cpk)
```

The `info` parameter binds the session key to:
- The pairing version (`"chalk.pairing.v1"`)
- The specific pairing session (pairing_id)
- The exact pubkeys exchanged (their SHA-256 fingerprints)

This binding ensures:
- Different pairing sessions never derive the same key (different
  pairing_id and pubkeys → different info → different key).
- An attacker who substitutes a pubkey midflight gets a different
  session key than the other side derives, causing AEAD failure on
  decrypt.

The `oob_secret` enters as the HKDF salt. chalkd doesn't have it, so
chalkd cannot derive the session key even with full visibility into
ECDH pubkeys.

### 4.3 Why salt vs info for oob_secret

HKDF separates "salt" (random, may be public) from "info" (context,
may be predictable). We use the OOB secret as salt because the salt
is mixed into the extraction phase, where unpredictability is most
beneficial. The info parameter carries the bindings (pairing_id +
pubkey fingerprints) which are public but session-specific.

### 4.4 Constant-time considerations

`X25519` is constant-time in `@noble/curves` by design. HKDF-SHA-256
is data-independent in `@noble/hashes`. The AEAD operations are
constant-time in `@noble/ciphers`. No additional constant-time
discipline required at the chalk layer.

---

## 5. Frame-by-frame specification

The eight pairing frames, with full payload schemas.

### 5.1 `pairing_offer` (C→S, initiator)

The initiator's first frame. Creates a server-side pairing session.

```go
type PairingOfferPayload struct {
    // The initiator's ephemeral X25519 public key.
    InitiatorEphPubKey string `json:"initiator_eph_pubkey"`  // base64, 32 bytes

    // Pairing variant: "qr" in v1, "pin" in v2.
    Kind string `json:"kind"`

    // Optional: human-readable label the initiator suggests for the
    // new device. Used in the critical event if the user labels it
    // before pairing. Capped at 128 chars (doc #4 §9.5).
    SuggestedLabel string `json:"suggested_label,omitempty"`
}
```

**Server validation**:
- `initiator_eph_pubkey` is exactly 32 bytes after base64-decode
- `kind` in `{"qr"}` (v1; `"pin"` added in v2)
- `suggested_label` ≤ 128 characters

**Server state**: create a `PairingSession` (doc #4 §6.1) with
status `OFFERED`, expires_at = now + 5 minutes. Generate a fresh
`pairing_id` (UUID).

### 5.2 `pairing_offer_ack` (S→C, initiator)

Server's response to the initiator.

```go
type PairingOfferAckPayload struct {
    PairingID string `json:"pairing_id"`  // UUID
    ExpiresAt int64  `json:"expires_at"`  // unix-ms
}
```

The initiator now has everything needed to display the QR code:
- `pairing_id` (from this ack)
- `initiator_eph_pubkey` (the initiator already has its own pubkey)
- `oob_secret` (the initiator already generated it locally)

### 5.3 `pairing_claim` (C→S, claimant)

The claimant scans the QR, decodes it, generates its own ephemeral
keypair, and claims the offer.

```go
type PairingClaimPayload struct {
    PairingID         string `json:"pairing_id"`
    ClaimantEphPubKey string `json:"claimant_eph_pubkey"`  // base64, 32 bytes

    // The claimant's "proof of OOB knowledge". Computed by the
    // claimant using the OOB secret and pubkeys it knows. Allows
    // the server (without knowing OOB) to forward only valid claims
    // to the initiator.
    //
    // Specifically:
    //   proof = HMAC-SHA-256(
    //     key = oob_secret,
    //     data = "chalk.pairing.claim.v1" || pairing_id
    //          || initiator_eph_pubkey || claimant_eph_pubkey,
    //   )
    //
    // 32 bytes, base64.
    Proof string `json:"proof"`
}
```

**Server validation**:
- `pairing_id` exists and is in `OFFERED` state
- not expired
- `claimant_eph_pubkey` 32 bytes

**Server action**: the server cannot verify the `proof` (no OOB
secret). It stores `claimant_eph_pubkey` and `proof` in the session,
transitions session to `CLAIMED`, and forwards the proof to the
initiator via `pairing_event`. The initiator verifies.

**Race protection**: if two claimants race, the first claim wins.
The second receives `pairing_already_claimed`. The server uses an
atomic state transition (e.g. `CAS` on the in-memory session map).

### 5.4 `pairing_claim_ack` (S→C, claimant)

```go
type PairingClaimAckPayload struct {
    InitiatorEphPubKey string `json:"initiator_eph_pubkey"`  // base64, 32 bytes
    PairingID          string `json:"pairing_id"`
}
```

Relays the initiator's pubkey to the claimant. (The claimant already
has this from the QR code, but receiving it from chalkd validates the
session is live.)

The claimant should verify the pubkey from this ack matches the one
from the QR code. Mismatch → `pairing_proof_invalid` (chalkd may be
substituting). Abort.

### 5.5 `pairing_event` (S→C, initiator)

Server pushes to the initiator that a claim has arrived.

```go
type PairingEventPayload struct {
    PairingID         string `json:"pairing_id"`
    ClaimantEphPubKey string `json:"claimant_eph_pubkey"`  // base64, 32 bytes
    Proof             string `json:"proof"`                // base64, 32 bytes
    ClaimantDeviceID  string `json:"claimant_device_id"`   // UUID; the
                                                            // device's chalk auth ID
}
```

**Initiator action**:

1. Verify the proof:
   ```
   expected_proof = HMAC-SHA-256(
     key = oob_secret,
     data = "chalk.pairing.claim.v1" || pairing_id
          || initiator_eph_pubkey || claimant_eph_pubkey,
   )
   if not constant_time_equal(expected_proof, received_proof):
     // Either chalkd is malicious OR an attacker without OOB knowledge
     // tried to claim. Abort.
     emit pairing_cancel
     state → PAIR_FAILED_TAMPERED
     return
   ```

2. Derive session_key (per §4.2).

3. Encrypt master_key under session_key (per §5.7).

4. Send `pairing_complete`.

### 5.6 `pairing_complete` (C→S, initiator)

```go
type PairingCompletePayload struct {
    PairingID            string `json:"pairing_id"`

    // master_key encrypted under session_key.
    // ciphertext = XChaCha20-Poly1305-Encrypt(
    //   key = session_key,
    //   nonce = nonce,
    //   aad = "chalk.pairing.complete.v1" || pairing_id_bytes(16),
    //   plaintext = master_key (32 bytes),
    // )
    EncryptedMasterKey string `json:"encrypted_master_key"`  // base64, 48 bytes
                                                              // (32 byte key + 16 byte tag)
    Nonce              string `json:"nonce"`                  // base64, 24 bytes

    // Initiator's confirmation that pairing succeeded on this side.
    // confirmation = HMAC-SHA-256(
    //   key = session_key,
    //   data = "chalk.pairing.initiator_confirm.v1" || pairing_id_bytes(16),
    // )
    // 32 bytes, base64.
    InitiatorConfirm string `json:"initiator_confirm"`
}
```

Server validates the pairing exists and is in `CLAIMED` state.
Server CANNOT verify `encrypted_master_key` or `initiator_confirm`
(it lacks session_key). Forwards both to the claimant verbatim via
`pairing_complete_event`.

### 5.7 `pairing_complete_event` (S→C, claimant)

(Naming note: doc #2 lists this as part of `pairing_complete` family
but I realize while writing this doc that the claimant needs an
explicit push frame, not just a state derivation. Adding here; doc #2
should be updated in a follow-up pass to include this frame in
family C.)

```go
type PairingCompleteEventPayload struct {
    PairingID          string `json:"pairing_id"`
    EncryptedMasterKey string `json:"encrypted_master_key"`
    Nonce              string `json:"nonce"`
    InitiatorConfirm   string `json:"initiator_confirm"`
}
```

**Claimant action**:

1. Compute expected initiator_confirm:
   ```
   expected = HMAC-SHA-256(session_key, "chalk.pairing.initiator_confirm.v1" || pairing_id_bytes(16))
   if not constant_time_equal(expected, received_initiator_confirm):
     // Session keys diverge; chalkd may be MitM, or the OOB secret
     // didn't match. Abort.
     state → PAIR_FAILED_TAMPERED
     emit pairing_cancel
     return
   ```

2. Decrypt master_key:
   ```
   try:
     master_key = XChaCha20-Poly1305-Decrypt(
       key = session_key,
       nonce = received_nonce,
       aad = "chalk.pairing.complete.v1" || pairing_id_bytes(16),
       ciphertext = received_encrypted_master_key,
     )
   except AEADAuthError:
     // Defense in depth — initiator_confirm should have caught this.
     state → PAIR_FAILED_TAMPERED
     return
   ```

3. Sanity-check the master_key shape (32 bytes; first-byte / last-byte
   sanity not meaningful for random bytes, but length is).

4. Cache master_key locally (encrypted under device DB key per D2).

5. Send `pairing_complete_ack` with claimant's confirmation:
   ```
   claimant_confirm = HMAC-SHA-256(
     session_key,
     "chalk.pairing.claimant_confirm.v1" || pairing_id_bytes(16),
   )
   ```

### 5.8 `pairing_complete_ack` (C→S, claimant)

```go
type PairingCompleteAckPayload struct {
    PairingID        string `json:"pairing_id"`
    ClaimantConfirm  string `json:"claimant_confirm"`  // base64, 32 bytes
}
```

Server forwards `claimant_confirm` to initiator (via a dedicated push
or piggybacked on a `pairing_status_event` — TBD in implementation).

**Initiator's final action**: verify claimant_confirm matches the
expected HMAC. If yes, the pairing has succeeded end-to-end. The
initiator can dismiss its QR code UI.

If verification fails: emit a `device_added_paired` critical event
with "Wasn't me" prominently shown (this is a sign the OOB may have
been observed by a third party who hijacked the pairing). The user
should rotate their recovery phrase immediately.

### 5.9 `pairing_cancel` (C→S, either party)

```go
type PairingCancelPayload struct {
    PairingID string `json:"pairing_id"`
    Reason    string `json:"reason,omitempty"`  // optional, for UI logging
}
```

Either party can send. Server transitions the session to `CANCELLED`
and frees the in-memory state. Forwards a `pairing_cancel_event` to
the other party so they update UI.

No ack frame; cancel is fire-and-forget.

---

## 6. End-to-end flow with all crypto operations

Putting §3-§5 together. This pseudocode is the complete v1 flow.

### 6.1 Initiator side

```typescript
async function startPairing(): Promise<void> {
  // STEP 1: Generate ephemeral keypair + OOB secret
  const initiatorEphPriv = x25519.utils.randomPrivateKey();  // 32 bytes
  const initiatorEphPub = x25519.getPublicKey(initiatorEphPriv);
  const oobSecret = crypto.getRandomValues(new Uint8Array(16));

  // STEP 2: Offer to server
  const offerAck = await ws.request('pairing_offer', {
    initiator_eph_pubkey: b64(initiatorEphPub),
    kind: 'qr',
  });
  const pairingId = offerAck.pairing_id;

  // STEP 3: Display QR code
  const qrPayload = `chalk-pair://v1/${b64url(uuidBytes(pairingId))}/${b64url(initiatorEphPub)}/${b64url(oobSecret)}`;
  ui.showQR(qrPayload);

  // STEP 4: Wait for claim
  const event = await ws.waitForPush<PairingEventPayload>('pairing_event', {
    timeoutMs: 5 * 60 * 1000,
    filter: (p) => p.pairing_id === pairingId,
  });

  // STEP 5: Verify proof
  const claimantEphPub = b64decode(event.claimant_eph_pubkey);
  const expectedProof = hmacSha256(
    oobSecret,
    utf8('chalk.pairing.claim.v1') ||
      uuidBytes(pairingId) ||
      initiatorEphPub ||
      claimantEphPub,
  );
  if (!constantTimeEqual(expectedProof, b64decode(event.proof))) {
    await ws.send('pairing_cancel', { pairing_id: pairingId, reason: 'proof_mismatch' });
    throw new Error('pairing_proof_invalid');
  }

  // STEP 6: Derive session_key
  const sharedIkm = x25519.sharedKey(initiatorEphPriv, claimantEphPub);
  const sessionKey = hkdfSha256(
    sharedIkm,
    oobSecret,
    utf8('chalk.pairing.v1') ||
      uuidBytes(pairingId) ||
      sha256(initiatorEphPub) ||
      sha256(claimantEphPub),
    32,
  );

  // STEP 7: Encrypt master_key
  const masterKey = await getCachedMasterKey();  // must be available
  if (!masterKey) throw new Error('master_key_not_available');

  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const aad = utf8('chalk.pairing.complete.v1') || uuidBytes(pairingId);
  const encryptedMasterKey = xchacha20poly1305Encrypt(sessionKey, nonce, aad, masterKey);

  // STEP 8: Compute initiator_confirm
  const initiatorConfirm = hmacSha256(
    sessionKey,
    utf8('chalk.pairing.initiator_confirm.v1') || uuidBytes(pairingId),
  );

  // STEP 9: Send pairing_complete
  await ws.request('pairing_complete', {
    pairing_id: pairingId,
    encrypted_master_key: b64(encryptedMasterKey),
    nonce: b64(nonce),
    initiator_confirm: b64(initiatorConfirm),
  });

  // STEP 10: Wait for claimant_confirm (relayed by server)
  const claimantConfirmEvent = await ws.waitForPush('pairing_claimant_confirm', {
    timeoutMs: 60 * 1000,
    filter: (p) => p.pairing_id === pairingId,
  });

  const expectedClaimantConfirm = hmacSha256(
    sessionKey,
    utf8('chalk.pairing.claimant_confirm.v1') || uuidBytes(pairingId),
  );
  if (!constantTimeEqual(expectedClaimantConfirm, b64decode(claimantConfirmEvent.claimant_confirm))) {
    // Severe: master_key may have been delivered to the wrong party.
    // Emit a critical event for the user to investigate.
    await emitLocalCriticalEvent({
      kind: 'device_added_paired',
      severity: 'critical',
      body: 'Pairing completed but the receiving device could not confirm. ' +
            'If you did not pair a device, rotate your recovery phrase now.',
    });
    throw new Error('pairing_claimant_confirm_invalid');
  }

  // STEP 11: Done
  ui.showSuccess('Device paired');

  // ZERO ephemeral material
  initiatorEphPriv.fill(0);
  sessionKey.fill(0);
  oobSecret.fill(0);
  // masterKey stays cached for normal use
}
```

### 6.2 Claimant side

```typescript
async function claimPairing(qrPayload: string): Promise<void> {
  // STEP 1: Parse QR
  const parsed = parseQrPayload(qrPayload);
  if (!parsed) throw new Error('qr_invalid');
  const { pairingId, initiatorEphPub, oobSecret } = parsed;

  // STEP 2: Generate own ephemeral keypair
  const claimantEphPriv = x25519.utils.randomPrivateKey();
  const claimantEphPub = x25519.getPublicKey(claimantEphPriv);

  // STEP 3: Compute proof
  const proof = hmacSha256(
    oobSecret,
    utf8('chalk.pairing.claim.v1') ||
      uuidBytes(pairingId) ||
      initiatorEphPub ||
      claimantEphPub,
  );

  // STEP 4: Send claim
  const claimAck = await ws.request('pairing_claim', {
    pairing_id: pairingId,
    claimant_eph_pubkey: b64(claimantEphPub),
    proof: b64(proof),
  });

  // STEP 5: Verify the server's relayed initiator_eph_pubkey
  // matches what was in the QR.
  if (!constantTimeEqual(initiatorEphPub, b64decode(claimAck.initiator_eph_pubkey))) {
    await ws.send('pairing_cancel', { pairing_id: pairingId, reason: 'initiator_pubkey_mismatch' });
    throw new Error('pairing_proof_invalid');
  }

  // STEP 6: Derive session_key
  const sharedIkm = x25519.sharedKey(claimantEphPriv, initiatorEphPub);
  const sessionKey = hkdfSha256(
    sharedIkm,
    oobSecret,
    utf8('chalk.pairing.v1') ||
      uuidBytes(pairingId) ||
      sha256(initiatorEphPub) ||
      sha256(claimantEphPub),
    32,
  );

  // STEP 7: Wait for pairing_complete
  const completeEvent = await ws.waitForPush<PairingCompleteEventPayload>('pairing_complete_event', {
    timeoutMs: 60 * 1000,
    filter: (p) => p.pairing_id === pairingId,
  });

  // STEP 8: Verify initiator_confirm
  const expectedInitiatorConfirm = hmacSha256(
    sessionKey,
    utf8('chalk.pairing.initiator_confirm.v1') || uuidBytes(pairingId),
  );
  if (!constantTimeEqual(expectedInitiatorConfirm, b64decode(completeEvent.initiator_confirm))) {
    await ws.send('pairing_cancel', { pairing_id: pairingId, reason: 'initiator_confirm_mismatch' });
    throw new Error('pairing_proof_invalid');
  }

  // STEP 9: Decrypt master_key
  let masterKey: Uint8Array;
  try {
    masterKey = xchacha20poly1305Decrypt(
      sessionKey,
      b64decode(completeEvent.nonce),
      utf8('chalk.pairing.complete.v1') || uuidBytes(pairingId),
      b64decode(completeEvent.encrypted_master_key),
    );
  } catch (e) {
    // AEAD failure — defense in depth; should have been caught by
    // initiator_confirm verification.
    await ws.send('pairing_cancel', { pairing_id: pairingId, reason: 'aead_failure' });
    throw new Error('pairing_aead_failure');
  }

  if (masterKey.length !== 32) {
    throw new Error('master_key_wrong_size');
  }

  // STEP 10: Cache master_key locally
  await cacheMasterKeyLocally(masterKey);  // encrypted under device DB key

  // STEP 11: Compute claimant_confirm and send ack
  const claimantConfirm = hmacSha256(
    sessionKey,
    utf8('chalk.pairing.claimant_confirm.v1') || uuidBytes(pairingId),
  );
  await ws.send('pairing_complete_ack', {
    pairing_id: pairingId,
    claimant_confirm: b64(claimantConfirm),
  });

  // STEP 12: Hand off to Flow 3's MASTER_KEY_AVAILABLE state
  // (download history secrets, instantiate history clients, etc.)
  await beginHistoryRestore(masterKey);

  // ZERO ephemeral material
  claimantEphPriv.fill(0);
  sessionKey.fill(0);
  oobSecret.fill(0);
  // masterKey stays cached for normal use
}
```

### 6.3 Server side (chalkd)

The server is a relay. Per-frame behavior is described in §5 above.
The server's in-memory `PairingSession` (doc #4 §6.1) tracks:

```go
type PairingSession struct {
    PairingID         string
    UserID            string
    OldDeviceID       string  // initiator's device ID from WS auth
    NewDeviceID       string  // claimant's device ID; nullable until claim
    OldEphemeralPubKey []byte
    NewEphemeralPubKey []byte
    ClaimantProof     []byte  // forwarded to initiator without inspection
    InitiatorConfirm  []byte  // forwarded to claimant
    ClaimantConfirm   []byte  // forwarded to initiator
    EncryptedMasterKey []byte // forwarded to claimant
    EncryptedMKNonce  []byte
    Kind              string
    Status            PairingStatus  // OFFERED, CLAIMED, COMPLETING, COMPLETED, CANCELLED
    CreatedAt         time.Time
    ExpiresAt         time.Time
}
```

The server never inspects `ClaimantProof`, `InitiatorConfirm`,
`ClaimantConfirm`, `EncryptedMasterKey`, or `EncryptedMKNonce`. They
are opaque relay payloads.

State machine (server side):

```
[no session] --pairing_offer--> OFFERED
OFFERED --pairing_claim--> CLAIMED
OFFERED --5min expire--> CANCELLED (auto)
OFFERED --pairing_cancel--> CANCELLED
CLAIMED --pairing_complete--> COMPLETING
CLAIMED --pairing_cancel--> CANCELLED
COMPLETING --pairing_complete_ack--> COMPLETED
COMPLETED --(emit critical event device_added_paired)--> [session purged after 1min]
```

**When the `device_added_paired` critical event fires**: the server
emits it on transition to `COMPLETED`, i.e. upon receipt of
`pairing_complete_ack` from the claimant. This is the latest
server-visible event in the happy path.

There is an alternative: wait for the new device's `device_announce`
frame (which would only fire if the new device successfully decrypted
master_key, verified initiator_confirm, and started bootstrapping
its own multi-device state per doc #5 Flow 9). This is stronger
evidence of functional success.

Recommendation for v1: emit on `COMPLETED` (Option 1). The
`device_announce` from the new device will arrive separately and is
already wired through doc #5 Flow 9 for other consumers. If the
critical event fires before `device_announce`, the user sees "a new
device paired" and the device list updates moments later — acceptable
UX. If `device_announce` never arrives (claimant crashed
post-decrypt), the critical event has already fired with the
device's new ID; ops can investigate.

---

## 7. Failure modes

### 7.1 Network failures

Any frame may fail to transmit. Behavior:

| Failing frame | Recovery |
|---------------|----------|
| `pairing_offer` | Retry up to 3x with backoff |
| `pairing_offer_ack` lost | Initiator times out; re-sends offer (creates a new pairing_id; old one stays in OFFERED until expiry) |
| `pairing_claim` | Claimant retries up to 3x |
| `pairing_claim_ack` lost | Claimant times out; can re-attempt claim (server returns `pairing_already_claimed` since session is now CLAIMED) — investigate UX; might need to make claim idempotent on `(pairing_id, claimant_eph_pubkey)` |
| `pairing_event` push lost | Initiator times out; cancellation flow |
| `pairing_complete` | Initiator retries; server's stored encrypted_master_key UPSERTs |
| `pairing_complete_event` push lost | Claimant times out; cancellation flow |
| `pairing_complete_ack` lost | Initiator times out; pairing is in a successful-but-unconfirmed state |

The last row is interesting: if the master_key was delivered
successfully to the claimant but the claimant_confirm never arrived
at the initiator, the initiator can't tell if the pairing succeeded
or was hijacked. Conservative recovery: treat as suspicious, emit a
critical event with "Wasn't me" prominently shown. The claimant
will also have completed self-registration via `device_announce`,
so the user can verify on the new device.

### 7.2 Cryptographic failures

| Detected at | Failure | Action |
|-------------|---------|--------|
| Initiator, step 5 | Proof mismatch | Abort with `pairing_proof_invalid`; warn user that OOB may be compromised |
| Claimant, step 5 | initiator_eph_pubkey from server != QR | Abort; suspect MitM chalkd |
| Claimant, step 8 | initiator_confirm HMAC mismatch | Abort; suspect MitM chalkd or OOB mismatch |
| Claimant, step 9 | AEAD decrypt fails | Abort (should have been caught above); defense in depth |
| Initiator, step 10 | claimant_confirm mismatch | Pairing already delivered master_key; emit critical event |

Every failure that suggests cryptographic mismatch (proof, confirm,
AEAD) treats the situation as **potentially adversarial** rather than
a transient bug. We do NOT silently retry on cryptographic mismatch
— the user gets a clear warning.

### 7.3 Race conditions

**Two claimants for the same pairing**: first one wins (server uses
atomic CAS on the in-memory session). Second one gets
`pairing_already_claimed`.

**Initiator cancels while claimant is mid-claim**: server returns
`pairing_not_found` or `pairing_expired` to the claimant; claimant's
UI shows "pairing cancelled by other device."

**Multiple tabs on initiator side**: BroadcastChannel coordination
(doc #5 §11.3) should prevent multiple offers concurrently from the
same user. If it doesn't (bug or race), the server has no protection
— both offers succeed independently with different pairing_ids and
the user sees two QR codes.

### 7.4 Hostile chalkd scenarios

**chalkd substitutes the initiator_eph_pubkey** (relays a different
pubkey to the claimant than what the QR contains):
- Caught at claimant step 5 (pubkey mismatch vs QR)

**chalkd substitutes the claimant_eph_pubkey** (relays a different
pubkey to the initiator):
- Caught at initiator step 5 (proof verification fails — chalkd
  doesn't know the OOB secret, so cannot forge a valid proof for a
  substituted pubkey)

**chalkd records the pairing and tries to replay later**:
- Replay fails because the pairing_id has expired (5 min); a fresh
  pairing has a fresh pairing_id, fresh ephemeral keys, fresh OOB
  secret, so a recorded session is useless for a new one.

**chalkd injects forged `pairing_event`** (sends a claim that didn't
come from a real claimant, attempting to receive the master_key):
- The forged claim's proof must be valid for an OOB secret chalkd
  doesn't have. Chalkd can't forge it. Proof verification at
  initiator step 5 catches this.

**chalkd holds the legitimate pairing while spoofing**:
- chalkd would need to simultaneously substitute pubkeys on both
  sides AND forge proofs/confirms on both sides — without ever
  learning the OOB secret. Mathematically equivalent to breaking
  HMAC with an unknown key. Computationally infeasible.

### 7.5 OOB secret compromise

If the QR is observed (camera shoulder-surf, screen recording), an
attacker who can also reach chalkd can complete the pairing
themselves before the legitimate user does:

1. Attacker reads QR off victim's screen
2. Attacker connects to chalkd as the user (requires the attacker to
   have valid chalk auth for the user — significant barrier)
3. Attacker submits a `pairing_claim` with their own ephemeral keys
   and a proof using the observed OOB secret
4. Initiator's proof verification succeeds (the OOB is real)
5. Initiator encrypts master_key under session_key
6. Attacker decrypts master_key

**Critical**: this requires the attacker to be authenticated to
chalk as the user. Just stealing the QR is not enough. They need
the user's chalk login credentials too.

For users whose QR was observed AND whose chalk auth is compromised
(or who could be compromised by a malicious chrome extension reading
the QR via the DOM), the D9 critical event mechanism is the last
defense: the user sees "Wasn't me" on their other devices and can
revoke.

v2's PAKE flow (§10) closes this gap by making the OOB low-entropy
(a 6-digit PIN) but resistant to offline brute-force — even an
attacker with the PIN cannot derive the session key without an
online interaction.

---

## 8. Security properties summary

| Property | Mechanism | Defense level |
|----------|-----------|---------------|
| chalkd cannot derive session_key | OOB secret never sent over network | Strong |
| Passive network observer cannot derive session_key | Same as above | Strong |
| Chalkd cannot MitM substitute pubkeys | Proof binds session to specific pubkeys; chalkd cannot forge proof | Strong |
| Replay of recorded pairing fails | Per-session pairing_id, ephemeral keys, OOB secret | Strong |
| Observed QR enables attack | Attacker also needs chalk auth + ability to race the legitimate flow | Medium (mitigated by D9 critical event) |
| Compromised initiator device leaks master_key | master_key is on the device; pairing exports it | Out of scope |
| Compromised claimant device after pairing | master_key cached in localStorage; LOC compromise | Out of scope |

---

## 9. Server frame implementations

Brief notes on chalkd's implementation requirements. Full handler
code goes into landing PRs.

### 9.1 In-memory session store

Per doc #4 §6.1. Atomic state transitions via `sync.RWMutex` + CAS
checks. Background reaper purges sessions past `expires_at`.

### 9.2 Rate limits

Per doc #4 §8:
- `pairing_offer`: ≤ 10/hour per user (defense against flood)
- `pairing_claim`: ≤ 5/hour per user (failed attempts shouldn't
  enable attacker probing)

Failed `pairing_claim` with valid `pairing_id` but bad proof should
NOT count against the rate limit for legitimate retries — but doc #4's
rate limit applies per-IP/per-user-id, so an attacker would need to
authenticate as the user to even hit `pairing_claim`. Already a high
bar.

### 9.3 Audit logging

Every state transition on a pairing session logs:
- `pairing_id`, `user_id`, `old_device_id`, `new_device_id` (if known)
- Old state → new state
- Timestamp
- Triggering frame type

This is invaluable for investigating "wasn't me" critical-event
reports. Retain logs for 90 days (typical chalk policy).

### 9.4 Cross-WS-connection routing

The initiator and claimant are on DIFFERENT WS connections. Server
must route:
- `pairing_event` to the initiator's connection (looked up by
  `old_device_id` ↔ active WS sessions)
- `pairing_complete_event` to the claimant's connection
- `pairing_cancel_event` to whichever party didn't send the cancel

If the target party is disconnected, queue the push (with TTL) and
deliver on reconnect. If TTL expires (1 minute), cancel the pairing.

---

## 10. v2 sketch — SPAKE2+ with 6-digit PIN

This section is a SKETCH only. Detailed v2 specification is deferred
to a future doc revision after a security review of SPAKE2+
candidates.

### 10.1 Motivation

v1's 128-bit QR-encoded OOB secret requires the user to scan from
screen to camera. Some user environments (no camera on either side,
accessibility constraints, low-resolution screens) make this
impractical. A 6-digit PIN — displayed on the initiator, typed on
the claimant — is a more flexible OOB channel.

But: 6 digits = ~20 bits of entropy = brute-forceable in milliseconds
offline. We CANNOT use the v1 protocol with a 6-digit PIN as
"oob_secret" — an attacker who records the pairing exchange could
offline-brute-force the PIN against the AEAD decryption.

A real PAKE primitive resists offline brute-force: the protocol
doesn't reveal enough information for an attacker to test guesses
without an online interaction.

### 10.2 Candidate primitives

| Primitive | Maturity | Library availability |
|-----------|----------|---------------------|
| SPAKE2+ (RFC 9383) | Standardized 2023 | `@noble/curves` may not yet expose; possibly hand-rolled on X25519 |
| CPace | IRTF CFRG draft | Limited JS implementations |
| OPAQUE (RFC 9807) | More complex; for password authentication, not symmetric pairing | Heavier than needed |

**Initial preference**: SPAKE2+ for symmetric pairing. Two devices
authenticate to each other via a shared low-entropy password (PIN).

### 10.3 Differences from v1

- **OOB secret**: 6 ASCII digits (~20 bits) instead of 128 bits
- **Protocol**: 2-pass SPAKE2+ exchange instead of ECDH+OOB-MAC
- **Computational cost**: SPAKE2+ requires a constant-time
  password-to-scalar mapping; slightly heavier than X25519 ECDH
- **Security against offline guess**: provided by SPAKE2+ design

### 10.4 Wire format changes

The 8 frames stay the same. Payloads change:

- `pairing_offer.kind` becomes `"pin"`
- `pairing_offer_ack` returns a server-assisted `pin_display`
  (the digits the initiator should show)
- `pairing_claim` payload carries SPAKE2+ message instead of plain
  pubkey + proof
- Subsequent frames carry SPAKE2+ messages
- Final session_key derivation per SPAKE2+ spec

### 10.5 v2 is NOT in scope for v1 ship

v2 implementation is deferred. v1 explicitly does not support PIN
flow. Document the limitation in the chalk UI: "To pair a new
device, the device with chalk already installed must show a QR code
that the new device can scan."

---

## 11. Open questions

**Q29 (new)**: Should the QR code embed the chalkd server URL?

Pros: claimant doesn't need to be pre-configured to know which
chalkd to talk to.
Cons: makes the QR more fragile (URL changes invalidate cards),
slight phishing risk if attacker can choose the URL.

Recommendation: yes, embed server URL. Phishing risk is mitigated by
chalkd-side TLS (the claimant verifies the cert) and the fact that
the user is already logged in to chalk on the existing device. The
URL just confirms which chalk instance is hosting the user's account.

Updated QR format:

```
chalk-pair://v1/<server_url_b64>/<pairing_id>/<initiator_pubkey>/<oob_secret>
```

**Q30 (new)**: Should `pairing_complete_event` be a distinct frame
type from `pairing_complete_ack`?

Doc #2's family C lists `pairing_complete` and `pairing_complete_ack`
but not `pairing_complete_event`. This doc identified the need for a
distinct claimant-targeting push frame. Doc #2 should be updated to
include `pairing_complete_event` in its family C listing.

Same for `pairing_claimant_confirm` (a push from server to initiator
relaying the claimant_confirm). The total pairing frame count would
increase from 8 to 10.

Recommendation: yes, add both frames in the next pass over doc #2.
Naming convention: `_event` suffix for S→C pushes.

**Q31 (new)**: What if the claimant's chalk WS connection is on a
different chalkd shard than the initiator's?

If chalkd is sharded by user_id, both connections for the same user
land on the same shard. Pairing routing then doesn't need cross-shard
coordination. If sharding is by something else (random, geographic),
cross-shard routing is needed for `pairing_event` and
`pairing_complete_event`.

Recommendation: shard by user_id if not already. Phase-11d-compatible.

**Q32 (new)**: How long after `pairing_complete_ack` is received does
the server retain the session?

Recommendation: 60 seconds, then purge. Long enough to handle any
follow-up frames (none expected); short enough to free memory.

---

## 12. Summary

Doc #6 specifies:

- **v1 pairing protocol**: ECDH(X25519) + HKDF-SHA-256 + OOB-secret
  authentication via QR code (128-bit random)
- **All 8 (+2 newly identified) pairing wire frames** with
  field-by-field payloads
- **End-to-end pseudocode** for initiator and claimant sides
- **Security properties** against passive observers, honest-but-curious
  chalkd, and hostile chalkd
- **OOB-secret-compromise scenarios** and the D9 critical event
  fallback
- **v2 sketch** for SPAKE2+ with PIN (deferred to future)

The v1 design is implementable with chalk's existing crypto
dependencies. Two doc-#2 updates are needed:
1. Add `pairing_complete_event` push frame (S→C, claimant)
2. Add `pairing_claimant_confirm_event` push frame (S→C, initiator)

Total pairing frame count: 10 (was 8), total phase-11d frame count:
34 (was 32).

After doc #6 lands, Flow 4 (pairing-based restore) per doc #5 is
fully implementable.

End of doc #6. Vienna 2026-05-28.

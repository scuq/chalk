# Phase 21+ crypto rebuild — AMENDMENT (recovery model + speculative aging layer)

This amends `chalk-phase-21plus-crypto-rebuild-plan.md`. It captures two
decisions made after the phase-21-7 cleanup (the full removal of the
encryption concept) and before phase 22 begins:

1. **The identity recovery / rotation model** — load-bearing for phase 22,
   because it changes the `identity_keys` schema.
2. **An optional per-channel aging picture-layer** — speculative,
   phase 26+, recorded so it isn't lost and so its tension with (1) is
   flagged before anyone builds it.

It also records small corrections the 21-7 cleanup forced on the original
plan text.

---

## 0. Corrections to the original plan text (post 21-7)

- **`messages.mls_epoch` no longer exists.** Phase 21-7e (migration 0028)
  dropped it. The original plan (Phase 23 bullet) said "repurpose
  messages.mls_epoch as key_version." That is void. Phase 23 introduces a
  **fresh** `key_version` column with no MLS-era semantics carried forward.
  This was always the intent ("clean slate, no MLS-era columns to
  repurpose"); the plan text simply predated the drop.
- **`messages.ciphertext` is now `messages.body`** (migration 0029), and
  **`channels.is_mls` is gone** (migration 0030). Phase 23 reintroduces any
  encrypted-channel concept from scratch; it does not reuse these names.
- Schema as of phase 21-7 end: `messages(id, channel_id, thread_id,
  parent_id, sender_device_id, seq, ts, delivered_at, body, meta)`,
  partitioned by RANGE(ts); `channels` with no `is_mls`. Plaintext only.

---

## 1. Identity recovery & rotation model (load-bearing for phase 22)

### 1.1 The problem this resolves

The original plan treats the 24-word BIP-39 phrase as a single, immutable
identity seed and is silent on two things the user actually wants:

- a way to **reset the passkey** (auth) that is *not* usable to log in to
  chat directly, and
- the ability to **rotate the phrase** while still **decrypting old
  messages** afterward.

These collide. The phrase seeds the identity keypair (X25519/Ed25519), and
the identity key is the root of decryption (it unwraps the per-space keys).
**A secret cannot be freely rotatable AND be the thing that decrypts old
data — unless something holding the old secret re-encrypts the data to the
new secret at rotation time.** This is the same constraint behind wallet
seeds and Signal PIN resets; it is physics, not a chalk bug.

> **REVISED — see §1.7.** The strict Design-B framing below (old key
> recoverable ONLY from a device or the user's external backup) was
> superseded by a decision to store retired identity keys server-side,
> re-wrapped under the current identity, with a per-rotation opt-out. The
> text in §1.2–1.4 is kept as the reasoning trail; §1.7 is authoritative.

### 1.2 Decision: two independent secrets, with Design-B rotation + an
external-backup escape hatch

**Secret 1 — recovery codes (auth-recovery).** Reuse the existing
`recovery_codes` table (migration 0014). These reset / re-register the
passkey. They are rotatable and regenerable, and are **completely
decoupled** from decryption. Resetting the passkey touches no message keys.
This is the common path (lost device, lost passkey).
*Recovery codes are not a chat login credential — they only authorize
registering a new passkey.*

**Secret 2 — the 24-word phrase (decryption root).** Seeds the identity
keypair. It is the root of message decryption. It **may rotate** ("I want a
new phrase"), but rotation follows **Design B**: a device that still holds
the *current* identity key re-wraps every space key the user can see, from
the old identity to the new identity. After re-wrap, the new phrase
decrypts everything (old + new).

**The escape hatch (the part that makes Design B humane).** If rotation or
recovery happens with **no device holding the old key** (total device
loss), the user may **manually enter the old 24 words** they saved
externally. Entering them re-derives the old identity key locally, which
unwraps the old space keys, which are then re-wrapped to the new identity.
So the requirement is not "the old key must be *online*" but "the old key
must be *available* — from a device OR from the user's external backup."

### 1.3 The two flows, explicitly

**Flow 1 — passkey reset (auth only).**
recovery code (0014) → register new passkey (WebAuthn) → back in. The
identity / decryption key is never involved.

**Flow 2 — identity rotation / recovery (decryption root).**
Decision point: *is the OLD identity key available?*
- **On a device** (key already in IndexedDB), OR
- **Entered manually** (old 24 words from external backup re-derive it).
Then: for each space the user belongs to, unwrap with the old key → wrap to
the new key → upload the new wrap. New phrase now decrypts all messages.

### 1.4 The one hard limit (document it)

If a rotation/recovery happens with **neither** a device holding the old
key **nor** an external backup of the old phrase, the old space-key wraps
are **unrecoverable**. The external-backup hatch raises the floor as high
as it can go; it cannot eliminate this floor. Record this in a sibling doc
`chalk-identity-rotation-limitation.md`, in the same spirit as
`chalk-creator-lost-state-limitation.md`.

### 1.5 Schema / build implications (carry into phase 22 + 23)

- **`identity_keys` gets a generation column from the start.** A user can
  have multiple historical identities across rotations. Suggested shape:
  `identity_keys(user_id, generation INT, x25519_pub, ed25519_pub,
  ed25519_sig, created_at, retired_at NULL, PK(user_id, generation))`.
  Phase 22 builds this with `generation` present even though rotation isn't
  wired until later — so rotation is not a painful retrofit.
- **Space-key wraps are per-(member, identity-generation).** Phase 23's
  `space_key_wraps` records which identity generation a wrap targets, so
  re-wrap can find the right set and retire the old one. This composes with
  the existing `key_version` (the space-key rotation version) — they are
  orthogonal axes: `key_version` = which space key; `generation` = which
  recipient identity.
- **A re-wrap operation** (client-side): runs from a device, or after
  manual phrase entry. For each space: unwrap(old identity) →
  wrap(new identity) → upload. Optimistic-locked, same discipline as the
  phase-25 weekly rotation and the old 11c-6 split-brain guard.
- **Manual phrase entry is a first-class recovery UI**, not an afterthought
  — lands near the phase-24 verification UI work.

### 1.7 REVISION — server-stored old keys (Model A) with per-rotation opt-in

Decision (supersedes the strict Design-B parts of §1.2–1.4): chalk stores
each retired identity generation's PRIVATE key on the server, encrypted to
the user's CURRENT identity public key. A user on a fresh browser with only
their current 24-word phrase can therefore recover ALL history — no device
and no manual old-phrase entry required in the common case.

**Mechanism.** At rotation (old generation g → new generation g+1), the
client — which at that moment holds the old private key — wraps the old
identity private key to the new identity public key (ECDH → HKDF → AES-GCM,
same primitive as space-key wraps) and uploads it. On recovery, the current
phrase derives the current identity, fetches the wrapped old-key blobs,
unwraps them, and walks back the generation chain to decrypt old space-key
wraps and thus old messages.

**Per-rotation opt-in (the safety valve).** Rotation offers a choice:
  * **Keep history recoverable (default).** Re-wrap + upload the old key.
    Convenient: current phrase alone recovers everything, forever.
  * **Drop the old key.** Do NOT upload. Used when rotating BECAUSE the old
    phrase leaked — the leaked phrase then unlocks nothing going forward,
    and pre-rotation history becomes recoverable only via a device or the
    user's own external backup of the old phrase (the §1.4 floor still
    applies to that history).

**The security tradeoff, stated honestly.** With the default (keep), a leak
of the CURRENT phrase exposes all history across all generations, and
rotation stops being a boundary that re-secures the past. This is
consistent with chalk's already-stated posture — the phrase is a
wallet-seed-grade secret, and forward secrecy is an explicit non-goal — so
Model A does not introduce a new class of risk; it makes rotation a
key-management convenience rather than a security reset. The opt-out exists
precisely for the one case (leaked phrase) where that distinction matters.

**Schema (phase 23-ish, NOT phase 22).** A new table, roughly:
  `identity_key_archive(user_id, generation, wrapped_private BYTEA,
   wrapped_under_generation INT, created_at)` — the retired generation's
private key, encrypted to `wrapped_under_generation`'s public key. Fetch
returns the chain a current identity can unwrap. Phase 22 does NOT build
this; it only must not preclude it, which it doesn't (`identity_keys`
already carries `generation`).

**Net:** phase 22 (identity derivation) is UNCHANGED by this decision — the
keypair derivation is identical. This affects phase 23+ (the archive table
+ the re-wrap-on-rotation flow + the rotation opt-in UI).

### 1.6 Net effect on the phase plan

- **Phase 22** builds `identity.ts` + `identity_keys` **with the
  `generation` column**. No rotation logic yet, but the schema is
  rotation-ready.
- **Phase 23** adds `generation` awareness to `space_key_wraps`.
- **Phase 25** (or a dedicated sub-phase) wires the rotation + re-wrap
  operation and the manual-phrase-entry recovery UI.
- Recovery codes (0014) are explicitly designated the passkey-reset path.

---

## 2. Speculative: optional per-channel aging picture-layer (phase 26+)

**Status: speculative. Explicitly gated on "if everything works with
encryption as we designed." Do NOT build during phases 22–25.** Recorded
here so the intent and its design forks survive.

### 2.1 The idea

An *optional, per-channel* second symmetric layer on top of phase-23
space-key encryption. When the mode is ON for a channel:

- Members see a sequence of **pictures** (chicken, egg, dog, …) — reusing
  the phase-24 picture vocabulary as a key-derivation input.
- **One member triggers adding a new picture per month**, so the sequence
  grows by one each month. (Read as: advances *at most monthly*, performed
  by a *member action*, not a server cron — server stays a blind relay.)
- The current picture sequence derives a **symmetric layer key** that
  encrypts the channel's messages *in addition to* the space key.
- **Rolling 12-month window**: once the sequence reaches 12 pictures,
  adding a new one **ages out the oldest**, so the layer key is always
  derived from the trailing 12 monthly pictures.

A message from month M is wrapped under the layer key derived from M's
trailing-12 window; that key naturally retires as months roll past — a
coarse-grained, human-memorable forward-secrecy-ish ratchet on top of the
deliberately non-forward-secret space key.

### 2.2 The rejoin / reset recovery story (per the user's clarification)

The picture sequence is a **channel-level shared secret that a fresh device
cannot reconstruct from the identity key alone** (it advances by member
action, not derivation). So a user who **resets or rejoins** must obtain
the trailing picture sequence by one of:

- **asking another current member** (who holds the channel's recent picture
  sequence), or
- **having noted it externally themselves** — specifically the **picture
  sequence of the last month** (i.e. the trailing window needed to derive
  the current layer key).

This mirrors the space-key recovery shape but for the extra layer: the
pictures act as a shared channel secret; recovery is peer-assisted or
self-backed-up. There is no identity-key path to it.

### 2.3 The tension that MUST be resolved before building (flag)

This **directly contradicts** the §1 promise that old messages stay
decryptable after rotation. The aging layer *deliberately* makes messages
older than the 12-month window undecryptable once the window slides past
them — unless every retired monthly layer key is archived. The two
features want opposite things.

Resolution options (decide at phase-26 design time, not now):
- keep an archive of past window keys for members who want full history
  (defeats the ratchet's point but preserves §1's guarantee), or
- scope the aging layer only to channels where ephemerality is the
  explicit intent (the ratchet is the feature; §1's "decrypt forever"
  guarantee is intentionally waived for those channels).

### 2.4 Open design forks (record, don't resolve)

- **Vocabulary coupling.** Same 256-icon set as phase-24 verification, or a
  separate one? Reuse couples MITM-verification entropy to channel-layer
  entropy — tempting but not free.
- **Derivation.** The picture *indices* (not rendered images) feed a KDF →
  symmetric layer key. Define the KDF + how the trailing-12 ordering is
  canonicalized.
- **Authority + sync.** Who may advance the month? Two members advancing
  near-simultaneously is the same optimistic-lock problem already solved
  for rotation — reuse that machinery. Offline members fetch the picture
  history to reconstruct the trailing-12 key.
- **Server role.** Advancing is a member action; the server relays the new
  picture-sequence state but does not derive or hold the layer key — keeps
  the blind-relay property.

---

## 3. Summary of what changes vs the original plan

| Area | Original plan | After this amendment |
|---|---|---|
| Passkey reset | not addressed | recovery codes (migration 0014) |
| Phrase role | immutable identity seed | rotatable decryption root (Design B) |
| Rotation w/o device | not addressed | manual entry of externally-saved 24 words |
| `identity_keys` | `(user_id PK, pubs, sig, created_at)` | add `generation` + `retired_at` from phase 22 |
| `key_version` source | "repurpose mls_epoch" | fresh column (mls_epoch was dropped in 21-7e) |
| Aging picture-layer | not present | speculative phase 26+, with history-vs-ephemerality fork flagged |

Everything else in the original plan (the §Honest caveats: no forward
secrecy, not post-quantum, don't skip phase-24 verification, hard rip-out)
stands unchanged.

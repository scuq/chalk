# Phase 83 — ALTERNATIVES: envelope fanout, or first-responder rotation

**Status: alternative proposals, not started, not reviewed.** Competing
designs to `PHASE-83-MSGSIG.md` (sixth revision, Gate 0 pending), written
7–8 August 2026 after a usability audit of that plan found three costs a
user would feel — the departure freeze above all. This document carries the
two candidates worth building, **concretely enough to implement**:

- **Option A — envelope fanout**: a different architecture. No group key
  exists at all; every message wraps its own key once per member over
  pairwise-derived secrets, and authenticity is a per-recipient MAC —
  deniable, rotation-free, freeze-free.
- **Option B — first-responder rotation**: a surgical delta to the main
  plan. Keep everything the five reviews hardened; change *who may rotate*
  from "the creator" to "any current member", which shrinks the departure
  freeze from creator-bounded (hours–days–forever) to seconds.

An earlier draft of this file (commit `fd9d0b6`) carried a third design —
per-sender streams, the Signal/WhatsApp/Megolm sender-keys model — kept
below in compressed form as the recorded middle option.

The same Gate 0 applies to whichever is chosen: **independent protocol
review before any code.** Choosing between this document and the main plan
is itself a decision that review should weigh in on.

**Tag:** `#msgsig`.

---

## The problem being re-solved (recap)

The main plan's shared-key architecture pays for global membership
consistency with three user-visible costs: the **departure freeze** (a
removal or leave locks every remaining composer until the *creator*
rotates the channel key — unbounded when the creator is offline, permanent
when the creator's account is gone), the **sender-clock timestamp change**,
and **retained edit history**. All three trace to one architectural fact:
every member shares one symmetric key, so any membership change is a
channel-global cryptographic event needing a coordinator.

---

# Option A — envelope fanout

*Every message is its own sealed envelope, one flap per member.* The
iMessage-family shape, radically simplified by a chalk-specific asset:
identities are **per-user** X25519/Ed25519 pairs (every device derives the
same keys from the phrase), so a standing pairwise secret between any two
users is *computable offline from keys both already hold* — no sessions,
no distribution messages, no ratchet state. Signal needs pairwise
double-ratchet sessions per device pair to get this; chalk gets it from
`deriveIdentity` for free.

## A.1 Key derivation (all existing WebCrypto primitives)

```
ss        = X25519(my_x25519_priv, peer_x25519_pub)        // static-static DH
K_pair    = HKDF-SHA256(ss,  salt = "chalk-pair-salt-v1",
                        info = "chalk-pair-root-v1:" ||
                               uuid16(min(A,B)) || uuid16(max(A,B)))
K_mac(A→B)  = HKDF-SHA256(K_pair, info = "chalk-pair-mac-v1:"  || uuid16(A) || uuid16(B))
K_wrap(A→B) = HKDF-SHA256(K_pair, info = "chalk-pair-wrap-v1:" || uuid16(A) || uuid16(B))
```

- Sorted-UUID `info` makes `K_pair` symmetric (both sides derive the same
  root); the directional `info` strings split it into per-direction MAC
  and wrap keys, so Alice→Bob and Bob→Alice tags can never be confused.
- The peer's X25519 public key is anchored exactly as today: `trust.ts`
  pins the Ed25519 key, `verifyIdentitySelfSig` binds the X25519 key to it
  (`identity.ts`), and the picture-word comparison verifies the pin. **The
  verification a user performs is now directly the verification of the
  message-authentication root** — no signature key in between.
- Per-message forward secrecy on the sender side: each message mints one
  ephemeral X25519 pair; each flap key is
  `HKDF(X25519(eph_priv, member_pub), info = "chalk-fan-flap-v1:" || uuid16(member))`.
  One ephemeral (32 bytes on the wire) per message, one DH per member.
  The MAC stays on the *static* directional key so verification does not
  depend on the ephemeral. (Static-static wrap without the ephemeral is
  the rejected variant: deterministic and never forward-secret.)

## A.2 Wire format — message suite 2, fanout

The `messages.body` column stays one opaque blob (no schema change):

```
body = u8(suite = 2)
    || eph_pub(32)
    || u16be(flap_count) || flap*
    || nonce(12) || body_ct                    // AES-256-GCM under msg_key

flap = uuid16(recipient_user)
    || nonce(12) || wrapped_msg_key(48)        // AES-256-GCM under the flap key:
                                               //   32-byte msg_key + 16 tag
    || mac_tag(32)                             // HMAC-SHA256 under K_mac(sender→recipient)

msg_key  = 32 random bytes, fresh per message
body AAD = "chalk-fan-s2:" || channel_id
flap AAD = "chalk-fan-flap-s2:" || channel_id || uuid16(recipient) || sha256(body_ct)
```

- A recipient finds its flap by `uuid16` prefix scan. The flap list names
  channel members — information the server already has.
- The body plaintext is the **same canonical envelope as the main plan's
  §3/§5** (uuid16/h32 forms, typed objects `0x01/0x02/0x03`, `client_msg_id`,
  `sender_ts`, parent binding, attachment bindings), minus the signature
  field. Everything Half A designed for relocation and replay resistance
  carries over verbatim — the MAC replaces the Ed25519 signature as the
  authenticity layer over the same canonical bytes.
- `mac_tag = HMAC-SHA256(K_mac(sender→recipient),
  utf8("chalk-fan-mac-v1") || canonical || sha256(body_ct))` — binding the
  canonical fields *and* the exact ciphertext, per recipient.
- `object_hash` (chains: reply `par_env_hash`, edit `prev_rev_hash`,
  reaction `prev_set_hash`) becomes `SHA-256(canonical)` — there is no
  signature to fold in, and MAC tags are per-recipient so they cannot be
  part of a shared identity. Canonical-only is sound here because a forged
  canonical cannot be *authenticated* to anyone (no valid tag), so a chain
  link to it dangles harmlessly.
- `key_version` is meaningless for suite-2 fanout messages; the wire field
  is sent as 0 and the server's `key_version >= 1` check learns a
  suite-2 exemption (`handleSend`, `ws.go`).

## A.3 What each party does

**Send** (`onSend`, reordered as in the main plan): mint `client_msg_id` →
upload attachments → build canonical envelope → mint `msg_key` + ephemeral
→ one DH + one AES wrap + one HMAC per member (including **a self-flap**,
so the sender's other devices — same identity — can read it) → send.
Cost at N members: N DHs, N AES-GCM wraps of 32 bytes, N HMACs —
single-digit milliseconds at chalk's mesh-voice room sizes.

**Receive:** find own flap → `X25519(my_priv, eph_pub)` → unwrap
`msg_key` → decrypt body → parse canonical → derive
`K_mac(claimed_sender→me)` from the **pinned** sender identity → recompute
the tag. Typed results as in the main plan (`verified` / `mismatch` /
`forged` / `unpinned` / `unsigned`-legacy), same `MemberTrust` mapping,
same fail-closed-attribution-not-availability rule.

**Attachments:** each attachment gets its own random key; blob encrypted
once under it; the key rides *inside* the canonical envelope's attachment
binding (alongside the existing ciphertext digests). No channel-key
dependency; receivers verify digests before decrypting, as in the main
plan. The `att_key_version` field dies.

**Edits / reactions:** the same typed objects, fanned out the same way.
Only-the-sender-edits stays server-enforced and is now also
cryptographically enforced per recipient (an edit's tags must verify under
the *original sender's* pairwise key). Revision recency: as in the main
plan's "narrow" option — per-target `prev` chains over
`object_hash(canonical)`, classification limited to observed ancestry; the
`message_revisions` table is **not** load-bearing and 0044's overwrite
stands.

**Voice signals:** simplify — `SdpSignal`/`IceSignal` seal directly to the
one peer under `K_wrap(me→peer)` instead of the channel key
(`signal-crypto.ts` already has the structural interface; the fingerprint
signatures under `chalk-voice-fp.v1` stay exactly as they are).

**Guests:** a guest derives a full identity from the link secret
(`guest-link.ts`), so guests get flaps like members and produce them like
members. The owner's admission is the existing fragment anchor; members
verify guest tags against the guest identity fetched at join (80-9).

## A.4 Membership: what remains, what dissolves

**Dissolves structurally:** the C-01 auto-reshare vector. There is no
durable channel key to hand to an injected principal — `rewrapForMissing`,
key versions, rotation, `key_epoch`, wrap suites, the committed-event-first
machine, genesis, the transcript chain, checkpoints: none of it exists for
new traffic. A server-injected roster entry gets *nothing* until real
senders individually start adding a flap for it.

**Remains (architecture-independent):** deciding *who deserves a flap*.
Same signed **membership certificates** as the streams design: `admission`
(adder signs channel + target user + target Ed25519 fingerprint +
authority arm, with the main plan's per-mode authority table and
`gov_record` shape; democratic outcomes stay the accepted residual) and
`removal`/`leave` counterparts; unordered, latest-signed-wins per user;
clients add flaps only for principals with a valid admission and no newer
removal. The server cannot mint a member without a member's signature.
Stated residual: a withheld removal certificate keeps *one unwitting
sender* flapping to the removed user — view-local, eventual, blast radius
one sender's future messages, never a channel key.

**Removal/leave — the usability win:** nothing to rotate, nobody to wait
for, no freeze of any kind. Each sender excludes the removed member from
its next envelope the moment its client sees the removal; an offline
sender's exposure window is its own absence, affecting only its own
messages.

## A.5 History for new members — now an explicit grant

The one real product change. Today an added member reads scrollback
because the current space key opens it. Under fanout, old messages have no
flap for the new member. **History becomes a deliberate grant:**

- `history_grant`: a member re-wraps past `msg_key`s (32 bytes each +
  message locator) into a pairwise-sealed blob for the new member —
  1,000 messages ≈ 50 KB sealed, chunked. Attachments come along free
  (their keys live inside the granted envelopes).
- Default policy, preserving today's UX: **the admitting member's client
  auto-grants the recent window** (the fetch-history depth) at admission,
  and serves older ranges on demand as the new member scrolls. A
  per-channel setting can turn auto-grant off — "new members see history"
  becomes a real, deliberate product knob instead of an accident of key
  versions.
- Legacy (pre-cutover) history stays under the old space keys: readable by
  whoever holds them, rendered with the uniform unauthenticated legacy
  mark, and — important — **legacy key auto-reshare is retired at the same
  cutover**; a new member gets legacy scrollback only via a member-driven
  grant of the old space key, gated on the same admission certificates.

## A.6 Deniability, and the honest cost list

HMAC authentication is **deniable**: Alice verifies Bob wrote it, but the
tag proves nothing to a third party — Alice could have computed it
herself. Signal's pairwise channels chose MACs partly for this; group
signatures (the main plan, the streams design) gave it up. For a private
group chat this is arguably the *right* default and it is unavailable in
any signature design.

Costs, plainly: per-message overhead `34 + N×108` bytes (~1.1 KB at
N = 10, ~5.5 KB at N = 50) and N DHs per send — wrong for 500-member
rooms, fine for chalk's; **assurance is per-verifier** (no transferable
proof — the flip side of deniability; a user cannot show a moderator a
cryptographic proof of who said what); history grants are O(history) work
for the granter; and the membership-certificate residuals above. Forward
secrecy: per-message ephemerals give the flap layer sender-side freshness,
but this design, like every other on the table, does not claim FS — an
identity-key compromise still derives every `K_pair`.

## A.7 Migration and enforcement

Per-sender, no ceremony: from the cutover build, clients send suite 2
fanout; legacy history stays suite 1 (uniform legacy mark). Enforcement =
`CHALK_FAN_REQUIRED`, the exact 82-3/82-10 flag shape (config → welcome →
one-way client latch; server rejects suite-1 bodies by leading byte;
`chalkctl fanout status` reads the suite byte, content-free). Space-key
machinery remains only to decrypt legacy history; `CHALK_WRAP_SIG_REQUIRED`
keeps governing that legacy path.

## A.8 Slices (shape, not final)

| Slice | Content |
|---|---|
| A-1 | Pairwise derivation (`chalk-pair-*` HKDF tree) + flap wrap/unwrap + HMAC tag; pure crypto, vectors + mutation tests |
| A-2 | Canonical envelope reuse from the main plan's 83-1 (typed objects, `object_hash` = SHA-256(canonical)); verify policy + typed results anchored on pins |
| A-3 | Suite-2 fanout send/receive end to end (send reorder, self-flap, `key_version` exemption), enforcement off |
| A-4 | Edits + reactions as fanout objects; sealed signed clear; skip-the-checks branch deletion |
| A-5 | Attachment keys in-envelope; digest verification on every fetch path; voice-signal pairwise sealing; guests |
| A-6 | Membership certificates (admission/removal/leave, authority table, `gov_record`), flap gating, legacy-reshare retirement |
| A-7 | History grants (auto-grant window + on-demand paging + the per-channel knob) |
| A-8 | Assurance UI; `CHALK_FAN_REQUIRED` + `chalkctl fanout`; threat-model staging |

---

# Option B — first-responder rotation

The freeze exists because rotation is **creator-only** — a product rule
enforced in one SQL predicate, not a cryptographic necessity. MLS's answer
to the coordinator bottleneck is that *any member may commit a removal*.
Apply exactly that, and only that, to the sixth-revision plan: **any
current member may rotate after a departure; first mover wins.** Every
member already holds the channel key, so widening rotation authority
grants no capability an insider didn't have — a malicious member rotating
achieves nothing they couldn't do by leaking the key they hold.

The freeze then lasts *until the first remaining member is online* — and
the member who performed the removal, or witnessed the leave, is online at
that moment, so in practice the lockout is seconds and a user rarely sees
it. Creator-offline pain gone; creator-deleted channels heal.

## B.1 The exact delta to the sixth-revision plan

1. **Authority table** (§7): `key_epoch` row — `creator only` → **any
   current transcript member**, both modes. (Rotation is mechanical
   hygiene, not governance; it stays proposal-free in democratic mode.)
2. **Schema validation** (§7 table): `key_epoch` — "actor = creator" →
   "actor in replayed membership".
3. **SQL** (`internal/store/channels.go`, `RotateChannelKey`): the
   `WHERE created_by = $2` arm becomes a membership check
   (`EXISTS (SELECT 1 FROM channel_members …)`); the real serializer —
   `AND current_key_version = $3 - 1`, atomic and exactly +1 — is
   untouched.
4. **Handler** (`ws.go`, `handleRotateChannelKey`): the
   `not_channel_creator` disambiguation becomes `not_a_member`.
5. **`rotate_needed` fanout**: today addressed to `ch.CreatedBy` only, at
   both call sites (`ws.go` unilateral removal; `governance_dispatch.go`
   resolved proposals) → addressed to **every remaining member**. The
   client's durable catch-up (`App.tsx`, the `rotation_pending` effect)
   drops its `ch.createdBy === myID` gate: any member whose `keyStatus`
   is ready attempts the rotation, with a deterministic jitter (rank by
   sorted member-ID position × ~2 s) so one client usually acts and the
   rest stand down.
6. **Races**: already designed. The committed-event-first machine and the
   R5-01 losing rule were built for two racing *creator devices*; they
   extend verbatim to two racing *members* — the epoch append is atomic
   with the committer's self-wrap, the server's unique `(channel, index)`
   picks one winner, the loser abandons its candidate and receives the
   winner's member wrap in step 4 like everyone else.
7. **One genuinely new sub-rule — epoch supersession.** Under
   creator-only rotation, a committed-but-unfilled epoch was recoverable
   by the creator's other devices (the self-wrap). Under any-member
   rotation, if member M commits `key_epoch(v+1)` and vanishes before
   publishing member wraps, *only M's account* can fill it — the channel
   would wait on M. So: **after a timeout with `v+1` unfilled, any other
   member may append `key_epoch(v+2)`** (the schema already permits it —
   next = replayed + 1 = v+2), and the server's wrap-publish gate widens
   from `current_key_version + 1` to *"≤ the highest committed
   `key_epoch` version in the events table"* — the transcript, which the
   server stores, becomes the gate's source of truth. Unfreeze requires
   the **latest** committed epoch, so a superseded `v+1` can never
   resurrect. This sub-rule is the whole new review surface of option B.
8. **Rate limit**: rotations per channel per interval, server-side —
   rotation spam by a hostile member is an annoyance (re-wrap churn), not
   a confidentiality loss, and the limiter caps the annoyance.
9. **Threat-model wording**: the removal-confidentiality claim improves
   from "after the *creator* rotates" to "after the *first remaining
   member* rotates"; everything else in the staging table stands.

## B.2 What B deliberately does not change

The other two usability findings stand as the main plan chose them:
sender-clock timestamps and retained edit history are orthogonal to
rotation authority (though the main plan could adopt the alternative's
lighter choices on both independently — display receipt time, and drop
`message_revisions` in exchange for the narrower fresh-reader claim —
each is a one-section amendment if wanted). B is the option for "the
sixth revision was five reviews' worth of hardening; change the one row
that hurts users and re-review a delta, not a new protocol."

---

# The recorded middle option — per-sender streams (superseded draft)

Commit `fd9d0b6` carried the Signal/WhatsApp/Megolm sender-keys shape in
full: one hash-ratcheted, identity-signed outbound stream per
(member, device, channel), distributed via the phase-82 wrap machinery;
removal handled by unilateral per-sender stream resets (no freeze); dense
per-stream indices giving exact ordering and duplicate detection; the
same membership-certificate layer as option A. It sits between A and B:
more moving parts than A (streams, announcements, per-sender waiting
states), better history semantics than A (ratchet handover), non-deniable
(signatures), and — unlike B — an architecture pivot. Retrieve the full
text from git history if it comes back into consideration.

---

# Choosing

| | Main plan (6th rev) | B: first-responder | Streams (`fd9d0b6`) | A: envelope fanout |
|---|---|---|---|---|
| Departure freeze | until creator acts | seconds | none | none |
| Creator crypto role | load-bearing | none | none | none |
| Review surface | already 5 rounds | delta only | new protocol | new protocol |
| Membership consistency | transcript (fork proofs) | transcript (fork proofs) | certificates | certificates |
| Deniability | no | no | no | **yes** |
| New-member history | as today | as today | ratchet handover | explicit grant |
| Per-message cost | 1 sign / 1 verify | 1 sign / 1 verify | 1 sign / 1 verify | N DH+HMAC / 1 DH+1 HMAC |
| Timestamp display | sender clock | sender clock | receipt time | receipt time |
| Edit history | retained | retained | not needed | not needed |
| Room-size ceiling | high | high | moderate | ~50 |

Recommendation unchanged from the audit that spawned this file: **B** to
kill the user-facing pain quickly inside the already-hardened design;
**A** if chalk is willing to make history-on-join explicit in exchange
for the simplest and most private system on the table — no group keys, no
rotation, deniable authentication, and the picture-word verification
anchoring message authenticity *directly*. Either way, Gate 0 reviews the
chosen document before slice 1.

## Prior-art sources

- WhatsApp Encryption Overview (Sender Keys; reset on member leave):
  <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys overview: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay — *Analysis and Improvements of the Sender
  Keys Protocol for Group Messaging*: <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec: <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Nebuchadnezzar — Matrix vulnerabilities (verify keys from the secure
  channel, not server labels): <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420 (any-member removal commits; TreeKEM):
  <https://datatracker.ietf.org/doc/html/rfc9420>
- Chase, Perrin, Zaverucha — *The Signal Private Group System*:
  <https://eprint.iacr.org/2019/1416.pdf>
- iMessage security overview (per-recipient message-key wrapping):
  <https://support.apple.com/guide/security/imessage-security-overview-secd9764312f/web>

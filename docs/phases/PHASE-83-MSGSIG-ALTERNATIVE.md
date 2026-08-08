# Phase 83 — ALTERNATIVES: envelope fanout, or first-responder rotation

**Status: alternative proposals, not started. Option A reviewed once and
under focused revision (this text); Option B not yet reviewed.** Competing
designs to `PHASE-83-MSGSIG.md` (sixth revision, Gate 0 pending), born from
the usability audit that found the main plan's three user-felt costs — the
departure freeze above all.

- **Option A — envelope fanout**: no group key exists at all; every message
  wraps its own key once per member over pairwise-derived secrets, and
  authenticity is a per-recipient MAC — deniable, rotation-free,
  freeze-free. **Externally reviewed 2026-08-08** (commit `177d14c`):
  *"retain as a viable candidate"*, four blocking findings P83-A-01 … 04
  and two required corrections A-05/A-06, all with usability-preserving
  resolutions — **this revision incorporates all six.** The reviewer's
  framing is adopted as a design principle here: *a design that protects a
  conversation only by repeatedly preventing people from using it is not a
  successful secure-messaging design.*
- **Option B — first-responder rotation**: a surgical delta to the main
  plan — any current member may rotate after a departure, shrinking the
  freeze from creator-bounded to seconds. Unreviewed; unchanged in this
  revision.

An earlier draft (commit `fd9d0b6`) carried a third design — per-sender
streams, the Signal/WhatsApp/Megolm shape — kept below in compressed form.

**Gate 0 applies:** independent re-review of this revision before any code.

**Tag:** `#msgsig`.

---

## Option A review dispositions (2026-08-08 review, all answered here)

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-01 (Critical) | "Latest-signed-wins" membership had no authenticated definition of *latest*; rollback and split views undetectable | §A.4 (per-target certificate chains: predecessor hash + monotonic transition number + local rollback latch; target-local forks, never a channel freeze) |
| P83-A-02 (High) | History grants moved keys but not per-recipient authenticity; original senders can't retroactively MAC | §A.6 (grantor-attested history: authenticated grant format, hash verification, one channel-level provenance line, `granted` assurance state) |
| P83-A-03 (Critical) | The migration latch derived from a server-controlled welcome signal; fresh devices downgradeable | §A.7 (server-independent adoption: fanout-only creation by build, local per-channel adoption records, read-only legacy rule, backup-carried adoption, stated fresh-device residual) |
| P83-A-04 (High) | Slice order let intermediate builds fan out to the raw server roster | §A.9 (dark development; one atomic release gate; defined rollback) |
| P83-A-05 (Medium) | "Forward secrecy" wording contradicted the no-FS residual | §A.2, §A.8 (renamed *fresh per-message encapsulation*; self-flap recovery spelled out; no-FS/no-PCS explicit) |
| P83-A-06 (High) | Wire/parser and cross-layer migration underspecified | §A.3 (frozen limits, parsing, point/nonce rules, hashed ranges, vectors), §A.7 (the `key_version = 0` cross-layer inventory) |

---

# Option A — envelope fanout, in full

*Every message is its own sealed envelope, one flap per member.* The
iMessage-family shape, radically simplified by a chalk-specific asset:
identities are **per-user** X25519/Ed25519 pairs (every device derives the
same keys from the phrase), so a standing pairwise secret between any two
users is computable offline from keys both already hold — no sessions, no
distribution messages, no ratchet state.

## A.1 Design principles (from the review, adopted)

- Common sends are one action and never wait for a coordinator.
- Removals never freeze the channel.
- Security state advances automatically and **never silently rolls back on
  the same device**.
- Exceptional ambiguity affects only the disputed recipient, never every
  member.
- History is available immediately, explained once at channel level — not
  a warning on every message.
- Picture-word verification stays an **optional upgrade**; it is never
  required to add or message someone. Malicious-first-fetch protection is
  scoped to manually verified identities, and the UI says so.
- Assurance language is **"authenticated for you"** — never "cryptographic
  proof Bob wrote this". Deniability is the product choice, not a defect:
  strictly, a tag proves *Bob or the recipient* produced it, and the
  recipient trusts their own uncompromised client.

## A.2 Key derivation

```
ss          = X25519(my_x25519_priv, peer_x25519_pub)      // static-static DH
K_pair      = HKDF-SHA256(ss,  salt = utf8("chalk-pair-salt-v1"),
                          info = utf8("chalk-pair-root-v1:") ||
                                 uuid16(min(A,B)) || uuid16(max(A,B)))   // 32 B
K_mac(A→B)  = HKDF-SHA256(K_pair, salt = zeros(32),
                          info = utf8("chalk-pair-mac-v1:")  || uuid16(A) || uuid16(B))
K_wrap(A→B) = HKDF-SHA256(K_pair, salt = zeros(32),
                          info = utf8("chalk-pair-wrap-v1:") || uuid16(A) || uuid16(B))
flap_key(m) = HKDF-SHA256(X25519(eph_priv_m, member_pub),
                          salt = utf8("chalk-fan-flap-salt-v1"),
                          info = utf8("chalk-fan-flap-v1:") || uuid16(member))
```

All outputs 32 bytes; all hashes SHA-256; `uuid16` is the raw 16-byte UUID
(strict parse, as in the main plan). The sorted-UUID root is symmetric;
the directional `info` strings split MAC and wrap keys so A→B and B→A can
never be confused.

- Trust anchoring is unchanged from today: `trust.ts` pins the peer's
  Ed25519 key (TOFU on first sight, picture-word upgrade), and
  `verifyIdentitySelfSig` binds the X25519 key to it. **The verification a
  user performs is directly the verification of the message-authentication
  root.**
- Each message mints one ephemeral X25519 pair; each flap key derives from
  the ephemeral-static DH. This is **fresh per-message encapsulation**
  (per-message key isolation), *not* forward secrecy — see §A.8: because
  every message carries a self-flap, later compromise of a static private
  key plus recorded ciphertexts recovers old message keys. The Double
  Ratchet earns FS by evolving and deleting state; this design
  deliberately does not, and claims accordingly.
- **Shared-secret validation:** reject an all-zero X25519 output (the
  RFC 7748 low-order-point guard) before any HKDF; reject any public key
  that is not exactly 32 bytes. The ephemeral private key is zeroized
  after the last flap derivation (the `deriveIdentity` scratch pattern).

## A.3 Wire format — message suite 2, fanout (frozen)

`messages.body` stays one opaque blob; no message-table schema change:

```
body = u8(suite = 2)
    || eph_pub(32)
    || u16be(flap_count)                       // 1 ≤ count ≤ MAX_FLAPS = 64
    || flap[flap_count]                        // sorted by uuid16(recipient) bytes;
                                               // duplicate recipient = malformed;
                                               // exactly one self-flap (sender's own
                                               // uuid16) required
    || nonce(12) || body_ct                    // AES-256-GCM under msg_key;
                                               // body_ct = ct || tag, nonce excluded

flap = uuid16(recipient_user)
    || nonce(12) || wrapped_msg_key(48)        // AES-256-GCM(flap_key, msg_key):
                                               //   32-byte key + 16-byte tag
    || mac_tag(32)                             // HMAC-SHA256(K_mac(sender→recipient),
                                               //   utf8("chalk-fan-mac-v1")
                                               //   || canonical || sha256(body_ct))

msg_key   = 32 random bytes, fresh per message
body AAD  = utf8("chalk-fan-s2:") || uuid16(channel)
flap AAD  = utf8("chalk-fan-flap-s2:") || uuid16(channel)
            || uuid16(recipient) || sha256(body_ct)
```

**Parsing rules (total, never throws):** every read is length-checked;
`flap_count` bounds-checked before allocation; total body length must
equal `1 + 32 + 2 + count×108 + 12 + len(body_ct)` exactly; body size
capped at 256 KiB; any violation → typed `malformed` result. Nonces are
96-bit CSPRNG values, never reused (fresh per AEAD call).

- The body plaintext is the **main plan's canonical envelope** (§3/§5
  there: uuid16/h32 forms, typed objects `0x01/0x02/0x03`,
  `client_msg_id`, `sender_ts`, parent binding, attachment bindings) minus
  the signature field. `canonical` in the MAC is exactly those bytes.
  Everything Half A designed for relocation and replay resistance carries
  over; the MAC replaces the signature as the authenticity layer.
- `object_hash = SHA-256(canonical)` for all chain links (reply
  `par_env_hash`, edit `prev_rev_hash`, reaction `prev_set_hash`) — no
  signature exists to fold in, and tags are per-recipient. Sound because a
  forged canonical authenticates to nobody, so a link to it dangles.
- **Test vectors (A-1 slice, frozen here):** per-field canonical mutation;
  truncation at every boundary; cross-channel replay (AAD mismatch);
  cross-recipient flap swap; duplicate flap; missing/wrong self-flap; tag
  computed under the reversed direction key; all-zero DH output; oversize
  flap count; body-length mismatch.

**Verification result** (typed, as in the main plan): `authenticated-for-you`
/ `mismatch` (outer field disagrees with canonical — inner wins) /
`forged` (tag fails against the pinned sender) / `unpinned` (no pin, path
may not fetch) / `granted` (§A.6) / `legacy` (suite 1). Attribution fails
closed; availability does not — content renders under a warning.

## A.4 Membership: per-target certificate chains (P83-A-01)

The reviewer is right that "unordered, latest-signed-wins" has no
authenticated *latest* — server timestamps and arrival order belong to the
adversary. The fix is a **tiny authenticated state machine per member**,
not a global transcript: no channel epochs, no checkpoints, no composer
freeze, ambiguity scoped to one target.

### The certificate

```
canonical = utf8("chalk-member-cert.v1") || u8(kind)
         || uuid16(channel) || uuid16(target)
         || u64be(n)                            // transition number, starts 0
         || h32(prev_cert_hash)                 // zeros for n = 0
         || uuid16(actor)
         || h32(target_ed25519_fp)              // admit kinds only
         || u8(auth_arm) || gov_record?         // per the main plan's forms
cert_hash = SHA-256(canonical || lp(sig))       // sig = actor's Ed25519, 64 B
```

`kind`: `0x01` admit, `0x02` remove, `0x03` leave, `0x04` convert-admit
(migration only, §A.7). `auth_arm` and `gov_record` are the main plan's
encodings verbatim (unilateral / governance-proposer / owner-fallback,
plus `0x03` conversion).

### Transition rules (the frozen state machine)

- `n = 0` must be `admit` (or `convert-admit`): the **signed initial
  admission anchors the chain**, binding the admitted Ed25519 fingerprint.
- Each later cert links `prev_cert_hash` to its predecessor and increments
  `n` by exactly 1. Kinds must alternate membership polarity: admit →
  remove/leave → admit (re-admission) → …
- **Authorization is evaluated against the verifier's current verified
  view**, with the main plan's per-mode table: admit — any current member
  (dictator) / governance arm (democratic); remove — owner (dictator) /
  governance arm (democratic), target never the owner; leave — actor =
  target, never the owner.
- The server stores certs (one table, unique `(channel, target, n)` —
  identical-cert re-append is idempotent success, a *different* cert at a
  taken `(target, n)` is a race loser that refetches) and serves them with
  the roster; it can forge none.

### Client state and the rollback latch

Per `(channel, target)`, persisted in IndexedDB: the highest verified
`(n, cert_hash)`. Rules:

- Never accept a chain that ends below the persisted `n` — **a removal
  once observed on this device can never silently roll back.**
- Two different valid certs at one `(target, n)` = a **target-local
  fork**: omit that target's flap, keep sending to everyone else, surface
  a concise per-target status ("delivery to X paused: conflicting
  membership records"). The channel never freezes.
- A flap is added only for targets whose verified chain currently ends in
  an admit. No valid chain, no flap.
- Adoption/backup: chain heads ride the phase-84 encrypted prefs blob
  (§A.7), so a restored device resumes at its old high-water marks.

### Stated residuals (threat model wording, verbatim intent)

- **A withheld newer cert keeps a sender's view stale for an unbounded
  time — online or not.** The server cannot forge or roll back state this
  device has seen; it can starve this device of updates. View-local,
  eventual, blast radius one sender's future flaps.
- TOFU first-fetch: an admission binds the fingerprint the *admitter*
  resolved; if the admitter's own first fetch was poisoned, the poisoned
  key is what's admitted. Manual verification upgrades this per pair;
  it is never required.
- Democratic outcomes: an honest member can be induced to sign an
  admission by a fabricated server-reported tally. The cert records
  *authorized-member attestation to a server-reported outcome* — C-01
  closure is stated separately for creator/dictator authorization
  (cryptographic) and democratic authorization (attested, residual).

## A.5 Send, receive, objects, guests

**Send** (`onSend`, reordered as in the main plan): mint `client_msg_id` →
upload attachments → build canonical → mint `msg_key` + ephemeral → per
authorized target (per §A.4) + self: one DH, one AES wrap, one HMAC →
send. N ≤ 64 by the flap cap, which is also the **enforced and
communicated channel-size limit for fanout channels** (server-side member
cap at add time; no per-send performance warnings under the limit).

**Receive:** find own flap → DH → unwrap `msg_key` → decrypt body → parse
canonical → derive `K_mac(claimed_sender→me)` from the **pinned** identity
→ recompute the tag → typed result. Outer/inner comparison as in the main
plan; inner wins on mismatch.

**Attachments:** each attachment gets its own random key, carried inside
the canonical envelope's attachment binding next to the existing
ciphertext digests; blobs verified against digests before decryption. No
channel-key dependency.

**Edits / reactions:** the same typed objects, fanned out identically.
Server-side sender-only editing stays; cryptographically, an edit
authenticates only under the original sender's pairwise keys. Revision
recency is the narrow claim (observed-ancestry chains over
`object_hash`); 0044's overwrite stands; no `message_revisions` table.

**Voice signals:** seal directly to the one peer under `K_wrap(me→peer)`;
the `chalk-voice-fp.v1` fingerprint signatures stay untouched.

**Guests:** full identity from the link secret; guests get and produce
flaps like members; the owner's `guest_grant`-equivalent is a cert with
the owner as actor; the fragment anchor is unchanged.

## A.6 Grantor-attested history (P83-A-02)

An original sender never made a tag for the future member, and cannot be
required to come online to make one — *all-senders-online history* is
exactly the coordinator disease this option exists to cure. The grant
therefore carries the grantor's attestation, and the UI says so once:

### The grant format (frozen)

```
canonical = utf8("chalk-history-grant.v1")
         || uuid16(channel) || uuid16(grantor) || uuid16(grantee)
         || u64be(grantee_admit_n) || h32(grantee_admit_cert_hash)
         || u32be(chunk_index) || u32be(chunk_count)
         || u32be(entry_count) || entry*        // ≤ 256 entries, ≤ 64 KiB sealed
entry = uuid16(message_id) || u64be(message_ts_ms)      // server locator
     || h32(canonical_object_hash) || h32(sha256(body_ct))
     || msg_key(32)
```

Sealed to the grantee with AES-256-GCM under `K_wrap(grantor→grantee)`,
AAD = `utf8("chalk-grant-s1:") || uuid16(channel) || uuid16(grantee) ||
u32be(chunk_index)` — the pairwise-derived key authenticates the grantor
to the grantee by construction. The server stores grant blobs addressed
to the grantee (new frame + table) and forwards them on join; duplicates
suppressed by `(grantor, grantee, admit ref, chunk_index)`.

### Rules

- The grantee verifies the seal (grantor authentication), checks the
  membership-state reference against its own verified admission, and only
  then adopts keys; after decrypting each message it recomputes and
  compares both hashes. Any mismatch discards that entry only.
- Granted messages render with the `granted` assurance state and **one
  persistent, unobtrusive channel-level line**: *"History from before you
  joined was shared by <grantor>; original authorship is not independently
  verified for you."* No per-message warnings. Live messages after
  admission carry normal per-recipient assurance.
- **Default policy** (preserves today's UX): the admitting member's
  client auto-grants the recent fetch-history window at admission and
  serves older chunks on demand as the grantee scrolls, same format. A
  per-channel knob can disable auto-grant — history-on-join becomes a
  real product decision.
- **Legacy space keys** are all-or-nothing: a `legacy_key_grant` (the old
  space key, sealed pairwise) opens *everything that key era retained —
  no narrower window can be cryptographically enforced and none is
  claimed.* The knob is: grant the era, or don't.

## A.7 Migration — the full scenario (P83-A-03 + A-06 inventory)

The reviewer's core point: **the security boundary must not derive from a
server-controlled signal.** A welcome flag and server-side suite
rejection remain as *operational hygiene*, but adoption is decided and
remembered client-side, and carried by the encrypted backup.

### Stage 0 — today

Shared space keys, suite-1 bodies, `CHALK_WRAP_SIG_REQUIRED` governing
wrap signatures (its default flip to secure for legacy channels moves
with this plan's final slice, per the 2026-08-05 follow-up).

### Stage 1 — the fanout build (release gate F, §A.9)

**New channels are fanout-only by construction, no server input:** from
build F, `create_channel` on the client writes a local **adoption
record** `{channel, adopted_at, reason: born}` *before* the create
request, signs `n = 0` admit certs for itself and every initial member in
the same breath, and only ever emits suite 2 there. A build-F client
never consults any server preference to decide this.

**Existing channels convert per channel, first-writer-wins:**

1. Any member on build F may **convert**: it signs `convert-admit`
   (`kind 0x04`, `n = 0`, `auth_arm 0x03`) certs for the roster it
   currently sees — explicitly TOFU-adoption of the pre-cert roster,
   displayed as such ("membership as seen by <converter> on <date>") —
   and appends them. The server's unique `(channel, target, n)` makes
   racing converters converge (identical certs idempotent; losers
   refetch).
2. On verifying the conversion set **plus one valid suite-2 object** in
   the channel, every build-F client writes its local adoption record
   `{reason: converted, converter, at}` and switches its sends to
   suite 2.
3. **After adoption, suite 1 is never rendered as current traffic on
   this device**: legacy rows live in a read-only, uniformly-marked
   legacy history section; a *new* suite-1 arrival in an adopted channel
   is flagged hard, not displayed as a message. The adoption record is a
   one-way latch on this device — no server message can clear it.

**Adds after conversion** use normal `admit` certs; the admitting
member's client auto-grants history per §A.6.

### Stage 2 — adoption in the backup

Adoption records and cert-chain heads ride the **phase-84 encrypted
prefs blob** (the pin-backup construction: HKDF over the identity's
X25519 scalar, merge-only, pins-first capacity rule, overflow surfaced
via `PinSyncStatus`). A fresh device that restores its backup recovers
adoption and high-water marks automatically — **normal new devices get
downgrade protection with zero ceremony.**

**The stated fresh-device residual:** a genuinely fresh device with no
backup (or a server withholding the blob — withholding is all it can do;
the blob is unforgeable and the merge only adds) has no adoption memory
for *converted* channels: the server can present such a channel as
legacy, serve retained old space-key wraps, and receive that device's
suite-1 traffic and legacy reshares. Scope: converted channels only,
that device only, until it verifies a conversion set or restores a
backup. **Born-fanout channels are immune** — a build-F client treats a
channel with no cert set and no adoption record as *not sendable* rather
than legacy… unless the server claims it predates F, which is exactly
the residual. Mitigations, in order: backup restore (automatic),
recreation for high-assurance channels (offered in UI), and the
`CHALK_FAN_REQUIRED` server hygiene below. No user confirmation dialog
in any common path.

### Stage 3 — enforcement and legacy retirement

- `CHALK_FAN_REQUIRED` (config → `chalkctl fanout status/enable/disable`,
  the 82-9/82-10 operational pattern): the server rejects new suite-1
  writes by leading byte. Explicitly **not the security boundary** — the
  client adoption latch is — but it stops honest-server re-seeding and
  gives operators a readiness dial.
- `CHALK_WRAP_SIG_REQUIRED` default flips to secure for the remaining
  legacy paths once `wrapsig status` telemetry shows READY across
  supported deployments.
- Space-key machinery survives only as the legacy read path; legacy
  reshares are gated on cert-verified membership from Stage 1 on, and
  retire fully when the last pre-F build ages out.

### Rollback semantics (defined, loud)

Before gate F: nothing user-visible exists. After gate F, an emergency
rollback build may re-enable suite-1 sending, but it must **explicitly
un-adopt with a user-visible channel notice** ("this channel dropped
back to legacy encryption") — silent rollback is the one thing the latch
exists to prevent; a rollback that pretends nothing happened recreates
P83-A-03.

### The `key_version = 0` cross-layer inventory (A-06)

Suite-2 fanout traffic carries no channel key version. Every current
`key_version ≥ 1` validation and its disposition, so no handler is
discovered mid-implementation:

| Site | Today | Under fanout |
|---|---|---|
| `handleSend` (`ws.go:740`) | rejects `< 1` | suite-2 bodies exempt (leading byte); suite 1 keeps the check |
| key-version ceiling (`ws.go:803`) | `≤ current` | skipped for suite 2 |
| `handleEditMessage` (`ws.go:3762`) | requires `≥ 1` | same exemption |
| `handleSetReactions` (`ws.go:3924`) | requires `≥ 1` unless clearing | same exemption; the unencrypted-clear branch is deleted (sealed signed clear, as in the main plan) |
| guest send (`guest_ws.go`) | mirrors send | same exemption |
| attachments init (`attachments_http.go`, store `attachments.go:92–101` rejects `< 1`) | per-blob key version | column becomes nullable / 0-allowed for fanout uploads; the attachment key rides the envelope; migration relaxes the CHECK |
| `fetch_history` / thread / summary paths | pass `key_version` through | pass 0 through; clients dispatch on the body's suite byte, never on the field |
| `MessagePayload.key_version`, `SendPayload`, edit/reaction frames | required semantics | field stays for legacy, documented receipt-metadata-only for suite 2 |

## A.8 Costs and accepted residuals (claims table)

Per-message: `34 + N×108` bytes and N DHs at send, one DH + one HMAC at
receive (~1.1 KB at N = 10; ceiling enforced at N = 64). Assurance is
per-verifier ("authenticated for you") — no transferable proof, by
design. **No forward secrecy, no post-compromise security**: static-key
compromise plus recorded ciphertexts opens self-flaps and recipient
flaps alike, recovering old message keys; stated plainly, no ratchet
added unless the product changes its claims.

| Residual | Treatment |
|---|---|
| TOFU first fetch | Automatic TOFU default; optional picture-word upgrade; loud warning only on later key change |
| Withheld cert / stale view | No freeze; per-sender scope; unbounded-staleness stated |
| Democratic tallies | Authorized-member attestation to a server-reported outcome; never "proof of the vote" |
| Deniability | "Authenticated for you"; no moderator-verifiable evidence, said up front |
| No FS / PCS | Stated in threat model; accepted |
| Fresh device on converted channels | Backup restore automatic; recreation offered; residual documented |
| Room size | Hard cap 64, enforced at member-add, communicated once |

**Audit coverage under these scopes:** C-01 — substantially addressed for
fanout traffic (no server-substitutable group key; observed removals
cannot roll back), conditional by mode and identity assurance; H-01 —
addressed for live suite-2 objects received after admission, against a
pinned sender; granted and legacy history carry their own narrower,
labelled assurance. L-01 (recovery-flow account security) — out of scope
here, separate work, not hidden inside this phase.

## A.9 Dark development and the release gate (P83-A-04)

**No production client emits suite 2 until every load-bearing piece is
active in the same build**: certificate validation and flap gating
(§A.4), grantor-attested history (§A.6), the adoption latch and backup
carriage (§A.7), and the assurance UI (§A.1/§A.3 language). Slices A-1
… A-7 land dark (build-time flag, tests only; servers may accept suite 2
early — harmless while no client emits). **Gate F is one atomic client
release** that turns emission on. Rollback per §A.7 — loud, never
silent. An intermediate build that fanned out against the raw server
roster would rebuild C-01 without a channel key; the gate exists to make
that build impossible, and it is a deployment constraint, not a
user-visible roadblock.

## A.10 Slices

| Slice | Content (all dark until Gate F) |
|---|---|
| A-1 | Pairwise HKDF tree; flap wrap/unwrap; HMAC tags; frozen parser with the §A.3 limits; full vector set |
| A-2 | Certificate canonical + state machine (pure function); server cert table + frames with `(channel, target, n)` idempotency; rollback-latch store |
| A-3 | Canonical envelope reuse (typed objects, `object_hash`); verify policy; typed results incl. `granted` |
| A-4 | Suite-2 send/receive end to end behind the build flag; self-flap; `key_version` exemptions per the §A.7 inventory |
| A-5 | Edits, reactions (sealed clear, branch deletion), attachments-in-envelope, voice pairwise sealing, guests |
| A-6 | Grantor-attested history: grant format, server storage/forwarding, auto-grant window + on-demand paging + the channel knob, `granted` UI |
| A-7 | Adoption records + conversion flow + backup carriage (phase-84 blob) + read-only legacy rendering + assurance UI language |
| A-8 | **Gate F**: emission on; conversion rollout; `CHALK_FAN_REQUIRED` + `chalkctl fanout`; threat-model staging move |
| A-9 | Legacy retirement: `CHALK_WRAP_SIG_REQUIRED` secure default flip; legacy-reshare cert gating; pre-F build sunset |

---

# Option B — first-responder rotation (unchanged, unreviewed)

The freeze exists because rotation is **creator-only** — a product rule in
one SQL predicate, not a cryptographic necessity. MLS's answer to the
coordinator bottleneck is that *any member may commit a removal*. Apply
exactly that to the sixth-revision plan: **any current member may rotate
after a departure; first mover wins.** Every member already holds the
key, so widening rotation authority grants no capability an insider
lacked.

The exact delta to the sixth-revision plan:

1. Authority table: `key_epoch` — creator only → **any current transcript
   member**, both modes (mechanical hygiene, not governance).
2. Schema validation: "actor = creator" → "actor in replayed membership".
3. SQL (`store/channels.go`, `RotateChannelKey`): `WHERE created_by = $2`
   → membership `EXISTS`; the monotonic `current_key_version = $3 - 1`
   guard is untouched and remains the serializer.
4. `handleRotateChannelKey`: `not_channel_creator` → `not_a_member`.
5. `rotate_needed` fanout: to every remaining member (both call sites:
   `ws.go` removal, `governance_dispatch.go`); the client catch-up drops
   its `createdBy === myID` gate and adds deterministic jitter (sorted
   member-ID rank × ~2 s) so one client acts and the rest stand down.
6. Races: the committed-event-first machine and the R5-01 abandon rule
   were built for two creator devices; they extend verbatim to two
   members.
7. **Epoch supersession (the one new sub-rule):** if member M commits
   `key_epoch(v+1)` atomically with its self-wrap and vanishes before
   publishing member wraps, only M's account can fill it. After a
   timeout, any other member may append `key_epoch(v+2)` (schema already
   permits: next = replayed + 1), and the server's wrap-publish gate
   widens from `current + 1` to "≤ the highest committed `key_epoch`
   version in the events table". Unfreeze requires the **latest**
   committed epoch; superseded epochs never resurrect. This sub-rule is
   B's entire new review surface.
8. Rate-limit rotations per channel (spam = churn, not confidentiality
   loss).
9. Threat-model claim improves to "after the *first remaining member*
   rotates".

B deliberately changes nothing else: sender-clock timestamps and retained
edit history stand as the main plan chose them (each independently
amendable). B is the option for "five reviews of hardening, one row
changed, delta re-review".

---

# The recorded middle option — per-sender streams (superseded draft)

Commit `fd9d0b6` carried the sender-keys shape in full: one
hash-ratcheted, identity-signed outbound stream per (member, device,
channel), distributed via the phase-82 wrap machinery; removal by
unilateral per-sender stream resets (no freeze); dense per-stream indices
for exact ordering; the certificate membership layer. Between A and B:
more moving parts than A, better history semantics, non-deniable.
Retrieve from git history if reconsidered.

---

# Choosing

| | Main plan (6th rev) | B: first-responder | Streams (`fd9d0b6`) | A: envelope fanout (this revision) |
|---|---|---|---|---|
| Departure freeze | until creator acts | seconds | none | none |
| Creator crypto role | load-bearing | none | none | none |
| Review state | 5 rounds, Gate 0 pending | delta only, unreviewed | superseded | 1 round: "viable, revise" — revised here |
| Membership consistency | transcript (fork proofs) | transcript (fork proofs) | certificates | per-target cert chains + rollback latch |
| Deniability | no | no | no | **yes** ("authenticated for you") |
| New-member history | as today | as today | ratchet handover | grantor-attested grant (explicit, labelled) |
| Per-message cost | 1 sign / 1 verify | 1 sign / 1 verify | 1 sign / 1 verify | N DH+HMAC / 1 DH+1 HMAC, N ≤ 64 |
| Timestamp display | sender clock | sender clock | receipt time | receipt time |
| Edit history | retained | retained | not needed | not needed |
| Fresh-device downgrade | per-device adoption (converted) | per-device adoption (converted) | similar | backup-carried adoption; converted-channel residual stated |

Recommendation: **B** to kill the user-facing pain quickly inside the
already-hardened design; **A** — now revised to the reviewer's six points
— if chalk wants the simplest and only deniable system on the table, with
history-on-join as an explicit, honestly-labelled product decision.
Either way, Gate 0 reviews the chosen document before slice 1.

## Prior-art sources

- WhatsApp Encryption Overview: <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys overview: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay — *Analysis and Improvements of the Sender
  Keys Protocol*: <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec: <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Nebuchadnezzar — Matrix vulnerabilities: <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420: <https://datatracker.ietf.org/doc/html/rfc9420>
- Chase, Perrin, Zaverucha — *The Signal Private Group System*: <https://eprint.iacr.org/2019/1416.pdf>
- iMessage security overview: <https://support.apple.com/guide/security/imessage-security-overview-secd9764312f/web>
- Signal Double Ratchet specification (why this design does not claim FS):
  <https://signal.org/docs/specifications/doubleratchet/>

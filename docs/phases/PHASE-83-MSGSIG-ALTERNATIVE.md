# Phase 83 — ALTERNATIVES: envelope fanout, or first-responder rotation

**Status: alternative proposals, not started. Option A three times reviewed
and under third (narrow) focused revision (this text); Option B not yet
reviewed.**
Competing designs to `PHASE-83-MSGSIG.md` (sixth revision, Gate 0 pending),
born from the usability audit that found the main plan's three user-felt
costs — the departure freeze above all.

- **Option A — envelope fanout**: no group key exists at all; every message
  wraps its own key once per member over pairwise-derived secrets;
  authenticity is a per-recipient MAC — deniable, rotation-free,
  freeze-free. **Reviewed 2026-08-08 three times**: first (commit
  `177d14c`) — "viable, revise", P83-A-01 … 06; second (commit `e774247`)
  — A-04/A-05 resolved, seven blocking R2-01 … 07; third (commit
  `8a0931a`) — R2-03/06/07 resolved, *"close to reviewable completion"*,
  **five narrow blocking findings P83-A-R3-01 … 05** plus one claim
  correction and completion items. **This revision incorporates all of
  them.** The reviewer's principle stands: *a design that protects a
  conversation only by repeatedly preventing people from using it is not a
  successful secure-messaging design.*
- **Option B — first-responder rotation**: a surgical delta to the main
  plan — any current member may rotate after a departure. Unreviewed;
  unchanged in this revision (end of file).

An earlier draft (commit `fd9d0b6`) carried a third design — per-sender
streams — kept below in compressed form.

**Gate 0 applies:** independent re-review of this revision before any code.

**Tag:** `#msgsig`.

---

## Option A review dispositions

First review (2026-08-08, commit `177d14c`): A-01 → §A.4 (superseded by
R2-01/02 below); A-02 → §A.6; A-03 → §A.7; A-04 **resolved** (dark
development, Gate F); A-05 **resolved** (encapsulation wording); A-06 → §A.3
+ §A.7 inventory.

Second review (2026-08-08, commit `e774247`), all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R2-01 (Critical) | Per-target chains cannot authenticate channel-wide authority: owner, mode, initial root, actor authorization all unbound | §A.4 (signed channel/conversion **authority anchors**, the policy chain, `policy_head` + `actor_admit_ref` on every cert, non-retroactivity rules, anchored bootstrap) |
| P83-A-R2-02 (High) | Independent per-target conversion rows converge on a set no one signed | §A.4/§A.7 (**one atomic signed conversion manifest**, channel-level compare-and-set, whole-manifest forks) |
| P83-A-R2-03 (Critical) | "Born-fanout channels are immune … unless the server claims pre-F" — self-contradiction; fresh clients led back to suite 1 | §A.7 (**a build-F client never originates suite 1, ever**; restore → verify anchor → auto-convert → else read-only) |
| P83-A-R2-04 (Critical) | Guest fragments cannot express "fanout required"; guest certs unspecified | §A.5 (the `0x04` fanout fragment form; frozen `guest_admit`/`guest_revoke` encodings; fragment-anchored verification, no server fallback) |
| P83-A-R2-05 (High) | Adoption state does not fit the phase-84 pin blob's contract or budget | §A.7 (**`channel_security_enc`**: a separate, domain-separated compact backup — anchors + adoption only, chains refetched and re-verified; frozen merge/capacity/reporting) |
| P83-A-R2-06 (High) | History grants lacked nonce layout, grant identity, paging and their own key | §A.6 (`K_history` domain; `grant_id`; absolute ranges; exact blob bytes; idempotency, quotas, expiry) |
| P83-A-R2-07 (High) | Gate F undefined for mixed pre-F/cached clients | §A.9 (protocol-era capability in hello/welcome; `client_upgrade_required`; draft-preserving reload; conversion deferred until sessions capable; mixed-version test) |

Non-blocking corrections, also adopted: WebCrypto disposal wording (§A.2),
the over-limit-channel conversion outcome (§A.7), parser minimums (§A.3).

Third review (2026-08-08, commit `8a0931a`), all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R3-01 (Critical) | The conversion anchor put the converter in the owner slot — any-member conversion silently changed governance or produced an invalid manifest | §A.4 (converter and owner get **distinct anchor fields**; the manifest's one-owner rule matches the *owner* slot; the converter attests, never inherits) |
| P83-A-R3-02 (High) | Manifest members had no valid `actor_admit_ref`; policy certs lacked hash, signature validation, idempotency and fork behavior | §A.4 (`manifest_admit_ref` derivation; the complete policy artifact + the no-freeze policy-fork rule) |
| P83-A-R3-03 (High) | The backup's merge needed `policy_p` the record didn't carry; the size math and page framing were wrong/missing | §A.7 (record carries `policy_p`; corrected budget; frozen page envelope, ordering, conflicts, tombstones) |
| P83-A-R3-04 (High) | Guest certs typed the raw lookup as a UUID and left revoke/expiry bytes open | §A.5 (`lookup16` type; separate frozen admit/revoke field lists; expiry + clock-skew rules) |
| P83-A-R3-05 (High) | Born-fanout creation needed a client-known channel ID and atomic anchor commit — unspecified wire/idempotency | §A.7 (client-minted `channel_id`, one-transaction insert, idempotent retry, pending-op record, the DM rule) |
| Claim correction | "No-suite-1 bounds the damage" read as availability-only; a poisoned conversion manifest is content disclosure | §A.7/§A.8 (scoped four-line claim) |
| Completion items | History quota/subtype; display-only timestamps; multi-instance Gate F | §A.6, §A.9 |

---

# Option A — envelope fanout, in full

*Every message is its own sealed envelope, one flap per member.* No group
key exists, ever. chalk's per-user X25519/Ed25519 identities make the
pairwise layer free: a standing secret between any two users is computable
offline from keys both already hold.

## A.1 Design principles (from the reviews, adopted)

- Common sends are one action and never wait for a coordinator.
- Removals never freeze the channel; ambiguity is scoped to one target.
- Security state advances automatically and never silently rolls back on
  the same device.
- **A build-F client never originates suite 1, under any circumstance**
  (§A.7) — read-only is the worst case, silent fallback never happens.
- History is immediate, explained once at channel level.
- Picture-word verification stays optional; malicious-first-fetch
  protection is scoped to manually verified identities, and the UI says so.
- Assurance language is **"authenticated for you"** — a tag proves *the
  sender or the recipient* produced it; the recipient trusts their own
  uncompromised client. Deniability is the product choice.

## A.2 Key derivation

```
ss            = X25519(my_x25519_priv, peer_x25519_pub)    // static-static DH
K_pair        = HKDF-SHA256(ss,  salt = utf8("chalk-pair-salt-v1"),
                            info = utf8("chalk-pair-root-v1:") ||
                                   uuid16(min(A,B)) || uuid16(max(A,B)))
K_mac(A→B)    = HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-mac-v1:")     || uuid16(A) || uuid16(B))
K_wrap(A→B)   = HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-wrap-v1:")    || uuid16(A) || uuid16(B))
K_history(A→B)= HKDF-SHA256(K_pair, salt = zeros(32),
                            info = utf8("chalk-pair-history-v1:") || uuid16(A) || uuid16(B))
flap_key(m)   = HKDF-SHA256(X25519(eph_priv_m, member_pub),
                            salt = utf8("chalk-fan-flap-salt-v1"),
                            info = utf8("chalk-fan-flap-v1:") || uuid16(member))
```

All outputs 32 bytes; all hashes SHA-256; `uuid16` = raw 16-byte UUID,
strict parse. The sorted-UUID root is symmetric; directional infos split
the purposes — **`K_history` is its own derivation** so voice sealing and
history grants never share an AES-GCM nonce domain (P83-A-R2-06).

- Trust anchoring unchanged: `trust.ts` pins Ed25519 (TOFU, picture-word
  upgrade); `verifyIdentitySelfSig` binds X25519 to it.
- Each message mints one ephemeral X25519 pair — **fresh per-message
  encapsulation, not forward secrecy** (§A.8; the self-flap makes old
  message keys recoverable from a later static-key compromise).
- **Shared-secret validation:** reject an all-zero X25519 output before
  any HKDF; reject non-32-byte public keys.
- **Key disposal, corrected for WebCrypto:** ephemeral private keys are
  generated non-extractable, live for the duration of one send, and every
  reference is dropped immediately after the last flap derivation —
  WebCrypto has no destroy operation and no erasure guarantee, so
  explicit zeroization applies only to application-owned byte buffers
  (`msg_key`, chain scratch), which are `fill(0)`ed in a `finally`.

## A.3 Wire format — message suite 2, fanout (frozen)

```
body = u8(suite = 2)
    || eph_pub(32)
    || u16be(flap_count)                    // 1 ≤ count ≤ MAX_FLAPS = 64
    || flap[flap_count]                     // sorted by uuid16(recipient);
                                            // duplicates malformed; exactly one
                                            // self-flap required
    || nonce(12) || body_ct                 // AES-256-GCM under msg_key;
                                            // body_ct = ct || tag(16)

flap = uuid16(recipient_user)
    || nonce(12) || wrapped_msg_key(48)     // AES-256-GCM(flap_key, msg_key)
    || mac_tag(32)                          // HMAC-SHA256(K_mac(sender→recipient),
                                            //   utf8("chalk-fan-mac-v1")
                                            //   || canonical || sha256(body_ct))

body AAD = utf8("chalk-fan-s2:") || uuid16(channel)
flap AAD = utf8("chalk-fan-flap-s2:") || uuid16(channel)
           || uuid16(recipient) || sha256(body_ct)
```

**Parsing (total, never throws):** every read length-checked;
`flap_count` bounded before allocation; total length must equal
`1 + 32 + 2 + count×108 + 12 + len(body_ct)` exactly, **with
`len(body_ct) ≥ 16`** (the GCM tag is the floor); body capped at 256 KiB;
**decrypted canonical capped at 128 KiB**; violations → typed `malformed`.
Nonces: 96-bit CSPRNG, fresh per AEAD call.

The body plaintext is the main plan's canonical envelope (typed objects
`0x01/0x02/0x03`, `client_msg_id`, `sender_ts`, parent binding, attachment
bindings) minus the signature; `object_hash = SHA-256(canonical)`.
Verification results: `authenticated-for-you` / `mismatch` / `forged` /
`unpinned` / `granted` / `legacy`. Attribution fails closed; availability
does not.

**Vectors (A-1):** per-field mutation; truncation at every boundary
including a 15-byte `body_ct`; cross-channel; cross-recipient flap swap;
duplicate flap; missing/wrong self-flap; reversed-direction tag; all-zero
DH; oversize counts; length mismatch; oversize canonical.

## A.4 Membership: an authority root, a policy chain, per-target cert chains

The second review's central point: per-target chains authenticate a
*sequence* but not the **channel-wide facts** that authorize it — who the
owner is, which mode is active, what the initial roster root was, and
whether the actor was a member when it signed. Those become authenticated
by two additions that stay invisible on the normal UI path: **one signed
anchor per channel** and **a small signed policy chain**. No global key
epoch, no composer freeze, no serialization of messages.

### The anchors (the authority root)

```
channel_anchor    (born-fanout, signed by the creator; creator = owner):
  utf8("chalk-chan-anchor.v1") || u8(kind = 0x01)
  || uuid16(channel) || u8(era = 1)
  || uuid16(owner) || h32(owner_ed25519_fp)      // = the creator, locally known
  || u8(mode) || u8(chan_kind)
  || h32(member_manifest_hash)
anchor_hash = SHA-256(canonical || lp(sig))      // sig = signer's Ed25519, exactly 64 B

conversion_anchor (converted channels, signed by one converter — P83-A-R3-01:
                   the converter ATTESTS; it never inherits ownership):
  utf8("chalk-chan-anchor.v1") || u8(kind = 0x02)
  || uuid16(channel) || u8(era = 1)
  || uuid16(converter) || h32(converter_ed25519_fp)   // the signer/attester
  || uuid16(owner)     || h32(owner_ed25519_fp)       // asserted by the legacy roster
  || u8(mode) || u8(chan_kind)
  || h32(member_manifest_hash)
  || u64be(converted_at_ms)   // the converter's clock; DISPLAY ONLY — never
                              // ordering, expiry or conflict resolution
```

`member_manifest` (hashed into the anchor, stored alongside it):

```
utf8("chalk-chan-manifest.v1") || uuid16(channel)
|| u32be(n) || entry*            // entry = uuid16(user) || h32(ed25519_fp) || u8(role)
                                 // sorted by uuid16; duplicates invalid; n ≤ 64;
                                 // exactly one owner entry, and it must equal the
                                 // anchor's OWNER slot (never the converter);
                                 // the converter must appear as an admitted member
```

**The manifest admission reference** (P83-A-R3-02): manifest members have
no admission certificate, so their authority to act is named by a
deterministic derived artifact:

```
manifest_admit_ref(user) = SHA-256(
  utf8("chalk-manifest-member.v1") || anchor_hash
  || uuid16(user) || h32(ed25519_fp) || u8(role) )
```

`actor_admit_ref` (below) may name either a `manifest_admit_ref` or a
later admission `cert_hash`; a removal supersedes **the exact referenced
membership state**, whichever form it took. Cross-type vectors (manifest
actor admits, cert actor admits, removal superseding each) are A-2 test
material.

- The server stores **one anchor per channel** — compare-and-set, first
  writer wins, identical re-append idempotent. Racing converters produce
  competing *whole manifests*; a client shown two valid anchors for one
  channel reports a **channel-conversion fork** (evidence, surfaced like
  the identity-changed wall) — other channels unaffected (P83-A-R2-02).
- The anchor is the **root of all authority**: the owner's membership
  needs no admitter (the bootstrap problem dies here), and every manifest
  member's authority is its `manifest_admit_ref`. Owner-only validations
  (removals, guest admission, policy changes) check the anchor's **owner**
  slot — under a conversion anchor that is the attested legacy owner,
  which stays inside the stated conversion-TOFU residual; the converter's
  signature upgrades nothing about it.
- Signing a server-presented legacy roster remains the deliberately
  accepted TOFU conversion residual, displayed as *"membership as
  recorded by <converter> on <date>"* — now a claim one signature
  actually binds.

### The policy chain (mode and ownership facts)

Mode changes are channel-wide authority facts, so they get their own tiny
chain rather than freezing the mode forever:

```
policy_cert: utf8("chalk-policy-cert.v1")
  || uuid16(channel) || u64be(p)          // p starts 1; the anchor is p = 0
  || h32(prev_policy_hash)                // anchor_hash for p = 1
  || u8(old_mode) || u8(new_mode)
  || uuid16(actor) || h32(actor_admit_ref)   // zeros ONLY for the anchor owner
  || u8(auth_arm) || gov_record?
policy_hash = SHA-256(canonical || lp(sig))  // sig exactly 64 B, validated
                                             // against the actor's pinned key
                                             // before hashing
```

**The policy artifact is complete** (P83-A-R3-02): authorization mirrors
the product rules (owner unilateral → democratic; governance arm at
supermajority → dictator), the actor's membership is named by
`actor_admit_ref` (manifest-derived or cert), the server enforces unique
`(channel, p)` with identical-cert idempotency (race serialization, not
security), and clients persist the highest verified `(p, policy_hash)`
per channel as a rollback latch. Owner identity is fixed at the anchor
(chalk never transfers ownership today; if that changes it extends this
chain, not the cert format).

**Policy forks, without a freeze:** two valid policy certs at one
`(channel, p)` are kept as evidence and surfaced once at channel level.
The client then **retains the last common policy** for validating
existing memberships and for ordinary messaging — flaps to
already-authorized recipients continue — and refuses only *new
transitions* (membership or policy) that depend on either forked head.
Applying a server-chosen branch would recreate server-selected authority;
freezing the channel would betray the design principle. Neither happens.

### Membership certificates (revised)

```
canonical = utf8("chalk-member-cert.v1") || u8(kind)
         || uuid16(channel) || uuid16(target)
         || u64be(n) || h32(prev_cert_hash)     // n = 0 root: prev = anchor_hash
         || uuid16(actor)
         || h32(policy_head)                    // the policy state this cert
                                                //   was authorized under
         || h32(actor_admit_ref)                // the cert head that makes the
                                                //   actor a member; zeros when
                                                //   actor is the anchor owner
         || h32(target_ed25519_fp)              // admit kinds only
         || u8(auth_arm) || gov_record?
cert_hash = SHA-256(canonical || lp(sig))
```

Kinds: `0x01` admit, `0x02` remove, `0x03` leave, `0x05` guest_admit,
`0x06` guest_revoke (§A.5). (`0x04` convert-admit is retired — the
conversion manifest replaced it.)

**Validation, frozen:**

- Chain shape: `n` increments by 1; polarity alternates
  (admit → remove/leave → admit …); the `n = 0` root's `prev` is the
  channel's `anchor_hash`, and manifest members' roots are *implied by
  the anchor* (their chains begin at `n = 1`).
- **Authority is evaluated at the referenced heads, not retroactively**:
  the actor must be a member per its `actor_admit_ref` chain and the
  `auth_arm` must be valid under the referenced `policy_head`. Alice
  leaving *later* never invalidates admissions she made while a member.
- **The observed-removal rule**: once this device has verified Alice's
  removal, it rejects *new, previously unseen* certs whose
  `actor_admit_ref` is the admission that removal superseded. Target-local
  delivery consequence only — never a channel freeze.
- **Rollback latch**: highest verified `(n, cert_hash)` per
  `(channel, target)` persisted; chains ending below it are refused; two
  valid certs at one `(target, n)` = target-local fork → omit that flap,
  surface a per-target status, keep sending to everyone else.
- A flap is added only for targets whose verified chain currently ends in
  admit (or who are manifest members with no chain yet).
- Server storage: unique `(channel, target, n)`, idempotent identical
  re-append — race serialization, explicitly *not* a security mechanism.

**Stated residuals** (unchanged in substance): a withheld newer cert
keeps a sender's view stale for an unbounded time, online or not —
view-local, one sender's flaps; TOFU first-fetch scopes to the admitter's
pin; democratic certs record *authorized-member attestation to a
server-reported outcome* — C-01 closure stated separately for
dictator-authorized (cryptographic) and democratic (attested) transitions.

## A.5 Send, receive, objects, guests

**Send:** mint `client_msg_id` → upload attachments → build canonical →
mint `msg_key` + ephemeral → one DH + AES wrap + HMAC per authorized
target (§A.4) + self → send. `MAX_FLAPS = 64` is also the enforced
member cap for fanout channels (server-side at member-add).

**Receive:** own flap → DH → unwrap → decrypt → parse → derive
`K_mac(claimed_sender→me)` from the pinned identity → recompute tag →
typed result; inner wins on mismatch.

**Attachments:** per-attachment random keys inside the envelope's
attachment binding, digests verified before decryption. **Edits /
reactions:** same typed objects fanned out; sender-only editing enforced
by server and by pairwise keys; observed-ancestry recency (narrow claim);
0044 overwrite stands. **Voice:** signals seal pairwise under `K_wrap`;
`chalk-voice-fp.v1` untouched.

**Guests (P83-A-R2-04), the fanout era made explicit:**

- **A fourth fragment form**, length/tag-distinct:

  ```
  secret(32)                              32 bytes → suite-1 legacy wrap
  secret(32) || owner_pub(32)             64 bytes → suite-2 signed wrap
  0x04 || secret(32) || owner_pub(32)     65 bytes → fanout only
  ```

  `parseJoinFragment` accepts exactly these; a 65-byte fragment with any
  other leading byte is rejected. Existing links keep their semantics
  byte-identically; links minted on fanout channels emit the `0x04`
  form. (The main plan's `0x03` era byte belongs to that design; the
  tags are distinct so no ambiguity survives whichever ships.)
- **Guest certificates, actually frozen** (P83-A-R3-04). A new byte type:
  `lookup16(x)` = the link's raw 16-byte truncated-SHA-256 lookup value —
  it is *not* a UUID and is never parsed as one (it travels as base64 on
  the existing wire). Two separate canonical field lists, both signed by
  the owner only:

  ```
  guest_admit  (kind 0x05):
    utf8("chalk-member-cert.v1") || u8(0x05)
    || uuid16(channel) || uuid16(guest)
    || u64be(n) || h32(prev_cert_hash)       // chain rules as §A.4
    || uuid16(actor) || h32(policy_head) || h32(actor_admit_ref)
    || h32(guest_ed25519_fp)                 // derivable by the owner at mint —
                                             // the guest identity is a pure
                                             // function of the link secret
    || h32(owner_ed25519_fp)
    || u64be(expiry_ms) || lookup16(invite)

  guest_revoke (kind 0x06):
    utf8("chalk-member-cert.v1") || u8(0x06)
    || uuid16(channel) || uuid16(guest)
    || u64be(n) || h32(prev_cert_hash)       // MUST be the guest_admit's cert_hash
    || uuid16(actor) || h32(policy_head) || h32(actor_admit_ref)
    || lookup16(invite)                      // cross-checked against the admit
  ```

  **Rules:** `guest_admit`/`guest_revoke` occupy the admit/remove
  polarities of the §A.4 alternation rule. **Expiry is a lapse, not a
  cert**: clients enforce `now > expiry_ms` at flap time and at guest
  verification with a ±5-minute clock-skew allowance; an expired admit
  remains a *verifiable historical artifact* (old messages keep their
  assurance) but never validates a new flap. Vectors: admit→revoke
  transition, replay of a revoked admit, cross-invite substitution
  (lookup mismatch), cross-era substitution, expiry boundary ± skew.
- **The guest verifies the owner's signed `guest_admit` against the
  fragment key before sending or accepting anything** — never a
  server-state fallback. Members verify guest flaps against the admitted
  fingerprint. History for guests: grantor-attested (§A.6), grantor =
  the owner.

## A.6 Grantor-attested history (frozen wire)

The product decision stands: immediate scrollback, attested by the
granting member, labelled once at channel level. The wire is now exact:

```
grant canonical = utf8("chalk-history-grant.v1")
  || uuid16(channel) || uuid16(grantor) || uuid16(grantee)
  || uuid16(grant_id)                          // fresh random per grant
  || u64be(grantee_admit_n) || h32(grantee_admit_cert_hash)
  || u64be(range_from_ms) || u64be(range_to_ms)   // absolute, half-open
  || u32be(chunk_index) || u32be(chunk_count)     // fixed per grant_id
  || u32be(entry_count) || entry*                 // ≤ 256 entries
entry = uuid16(message_id) || u64be(message_ts_ms)
     || h32(canonical_object_hash) || h32(sha256(body_ct)) || msg_key(32)

sealed chunk = nonce(12) || AES-256-GCM(K_history(grantor→grantee),
                                        grant canonical) || tag(16)
       AAD   = utf8("chalk-grant-s1:") || uuid16(channel)
            || uuid16(grantee) || uuid16(grant_id) || u32be(chunk_index)
```

- **One grant = one `grant_id` + one absolute range, complete in itself**
  (`chunk_count` fixed at creation). Scrolling into older history creates
  a **new, independently complete grant** with its own id and range —
  paging never mutates a prior grant.
- Server storage/forwarding keyed by `(grantee, grant_id, chunk_index)`,
  idempotent; **quota: 32 stored chunks per (grantor, channel)** — a
  constant, not a knob; **expiry**: blobs deleted after fetch-ack or
  30 days, whichever first.
  Retry = re-send same id/chunk; replacement = new grant_id; an
  incomplete batch renders nothing until its chunks are present.
- Grantee rules: verify the seal (grantor-authenticated by the pairwise
  `K_history`), check the admit reference against its own verified
  admission, adopt keys, then verify both hashes per message after
  decrypting; mismatched entries are discarded individually.
- UI: the `granted` assurance state plus one persistent channel-level
  line — *"History from before you joined was shared by <grantor>;
  original authorship is not independently verified for you."* Live
  post-admission messages carry normal assurance.
- Default: the admitting member auto-grants the recent fetch-history
  window; older ranges on demand; per-channel knob to disable.
- **Legacy space keys are all-or-nothing**, and the subtype is frozen:

  ```
  legacy_key_grant canonical = utf8("chalk-legacy-grant.v1")
    || uuid16(channel) || uuid16(grantor) || uuid16(grantee)
    || uuid16(grant_id)
    || u64be(grantee_admit_n) || h32(grantee_admit_cert_hash)
    || u32be(key_version_era) || space_key(32)
  ```

  sealed under `K_history` with AAD
  `utf8("chalk-grant-s1:") || uuid16(channel) || uuid16(grantee) ||
  uuid16(grant_id) || u32be(0)`. A granted era opens everything that era
  retained; no narrower window is claimed.

## A.7 Migration — the full scenario

**The rule above all rules (P83-A-R2-03): a build-F client never
originates suite 1.** Not for a channel the server calls legacy, not on
rollback, not anywhere. With that rule, "the server relabels a
born-fanout channel as pre-F" stops being a downgrade: it is at most a
denial of convenience, and the contradiction the review caught is gone —
born-fanout and converted channels obey one state machine:

```
On open of / first send attempt in any channel without local adoption:
  1. restore  — a valid adoption/authority record from the encrypted
                backup (below)?  → adopted; proceed fanout-only.
  2. verify   — an existing channel/conversion anchor served for this
                channel verifies?  → write the adoption record; proceed.
  3. convert  — no anchor exists: the client CREATES the conversion
                anchor + manifest from the roster it can see, commits it
                (channel-level compare-and-set; loser adopts the winner
                after verifying it), writes adoption, proceeds.
  4. read-only — conversion cannot complete (offline, CAS unresolvable,
                fork evidence): the channel is readable, marked, and not
                sendable. Never suite 1.
```

Step 3 is automatic and uses the same roster the client would have used
anyway — no ceremony; the poisoned-roster TOFU residual is accepted and
stated. Legacy content stays readable in its marked read-only section.

### Stages

**Stage 0 — today.** Space keys, suite 1, `CHALK_WRAP_SIG_REQUIRED`
governing legacy wraps.

**Stage 1 — build F (Gate F, §A.9).** New channels are fanout-only from
birth, and the creation wire is frozen (P83-A-R3-05 — today
`CreateChannelPayload` carries no ID and Postgres assigns it via
`INSERT … RETURNING`, so the anchor could not name the channel; the same
client-minted-UUID move the main plan adopted for genesis applies here):

- `create_channel` gains `channel_id` (client-minted UUID), `anchor`
  (the signed `channel_anchor` bytes) and `manifest` (the full member
  manifest). The client durably persists a **pending-op record**
  (id + anchor + adoption intent) *before* sending.
- The server validates agreement before touching the database: caller =
  anchor owner; payload `channel_id` = the anchor's; manifest hash =
  the anchor's; manifest members/roles = the payload member list +
  creator-as-owner; `chan_kind`/mode consistent with the payload — then
  **one transaction** inserts channel row, member rows and anchor.
- **Idempotent retry**: re-creating the same client-minted `channel_id`
  with a byte-identical anchor acks success (returns the existing
  channel) — a lost ack is retried safely; the same ID with a
  *different* anchor is an error (the client re-mints everything). The
  pending-op record clears on ack.
- **The DM rule**: if a DM between the pair already exists, the server
  returns *it* (today's reuse path) and the submitted ID, anchor,
  manifest and key material are discarded — the client then runs the
  §A.7 adoption state machine on the returned channel (verify its
  anchor, or convert it) rather than silently attaching a new-channel
  anchor to a different ID.
Existing channels: converted by the state machine above, typically by the
first member to send on build F. After adoption, suite 1 renders only in
the read-only legacy section; a new suite-1 arrival is flagged, never
shown as current. Adoption is a one-way latch per device.

**Stage 2 — the security-state backup (P83-A-R2-05).** Adoption does
**not** ride the pin blob — wrong contract, wrong budget (the pin blob
holds `{v, pins}` in ~7,900 bytes, ~60 pins; one 64-member channel of
cert heads would swamp it, and pin merge semantics don't fit monotonic
heads). Instead, a second prefs key with its own domain:

```
keys    "channel_security_enc" (page 0), "channel_security_enc.1", …
KDF     HKDF over the identity X25519 scalar,
        salt "chalk-chansec-salt-v1", info "chalk-chansec-v1"

record  uuid16(channel) || u8(flags) || h32(anchor_hash)
        || h32(policy_head) || u64be(policy_p)
        = 89 bytes exactly (P83-A-R3-03: the merge needs policy_p IN the
        record — chain state refetched from the server can never feed the
        merge). flags bit0 = era-adopted; bit1 = conflict record (a second
        anchor for the same channel — both records survive, surfaced as
        fork evidence); bit2 = tombstone (channel left/deleted; dropped at
        the next repack after 30 days)

page    plaintext = u8(v = 1) || u8(page_index) || u8(page_count)
                 || u16be(record_count) || record*
        sealed   = nonce(12) || AES-256-GCM(K, plaintext) || tag(16)
        AAD      = utf8("chalk-chansec-s1:") || u8(page_index)
        Budget: sealed+base64 must fit the 7,900-byte prefs value —
        usable plaintext ≈ (7900 × 3/4) − 28 − 5 ≈ 5.8 KiB ⇒
        **≤ 64 records per page** (89 B each), NOT the previous ~100.
        Assignment: records sorted by uuid16(channel), packed in order,
        repacked wholesale on every change (deterministic; no stable
        residency). Upload order: pages written ascending, **page 0
        last** — page 0 carries page_count, and a reader that cannot
        fetch every named page keeps its previous state (a partial
        upload reads as the old consistent set, never as truncation).

merge   union by channel; a record is replaced only by one whose
        **policy_p is higher** (now verifiable from the record itself);
        equal-p different-anchor ⇒ keep both, set bit1, surface;
        tombstones win over absence, lose to any higher-p record
```

Cert-chain heads are deliberately **not** backed up: chains are
refetched from the server and re-verified against the anchor — the
anchor is what makes them verifiable, and it is 32 bytes. What a fresh
restore loses without head backup is only the rollback high-water marks,
which collapses into the already-accepted stale-view residual.
`PinSyncStatus` grows the second blob's counters; overflow reported, not
silent; **sending never waits on backup**.

**What no-suite-1 does and does not buy, scoped exactly** (the third
review's claim correction — the earlier "bounds the damage" wording read
as availability-only, and for C-01 it is not):

- no-suite-1 **eliminates legacy shared-key substitution** for build-F
  traffic — the server can never again recover a server-known space key
  for new messages;
- a backed-up or manually verified authority anchor **prevents silent
  anchor replacement** on that device;
- **without either, conversion is TOFU**: a malicious server can present
  a poisoned manifest whose converter or members include a
  server-controlled identity, and the fresh client will mint valid flaps
  for it — **content disclosure on that fresh view**, not merely an
  availability loss; and
- later anchor conflicts and membership rollback on the same device are
  detected and refused (the latches).

The channel/security settings surface states the protection level
plainly; mandatory verification remains deliberately off the table.

**Stage 3 — enforcement and retirement.** `CHALK_FAN_REQUIRED`
(`chalkctl fanout status/enable/disable`) rejects new suite-1 writes by
leading byte — operational hygiene, explicitly not the boundary.
**Over-limit channels** (> 64 members): `chalkctl fanout status` lists
them **before** Gate F; on build F they are read-only-legacy for sending
until deliberately split or recreated — a client never silently omits
valid members to fit the flap cap. `CHALK_WRAP_SIG_REQUIRED` flips to a
secure default once telemetry is READY; legacy reshares are cert-gated
from Stage 1 and retire with the last pre-F build.

**Rollback.** Before Gate F: nothing exists. After: an emergency build
may disable fanout **emission UI** (channels become read-only where not
yet converted) but never re-enables suite-1 origination — the
no-suite-1 rule is not conditional. A rollback that needs suite 1 back
is a decision to un-ship the phase, taken loudly with a user-visible
notice per channel, never silently.

### The `key_version = 0` cross-layer inventory (unchanged)

| Site | Today | Under fanout |
|---|---|---|
| `handleSend` (`ws.go:740`) | rejects `< 1` | suite-2 exempt (leading byte); suite 1 keeps the check |
| version ceiling (`ws.go:803`) | `≤ current` | skipped for suite 2 |
| `handleEditMessage` (`ws.go:3762`) | `≥ 1` | exempt |
| `handleSetReactions` (`ws.go:3924`) | `≥ 1` unless clearing | exempt; unencrypted-clear branch deleted |
| guest send (`guest_ws.go`) | mirrors send | exempt |
| attachments (`attachments_http.go`; store CHECK `≥ 1`) | per-blob version | 0-allowed via migration; key rides the envelope |
| history/thread/summary paths | pass version through | pass 0; clients dispatch on the suite byte |
| wire fields | required | retained for legacy; receipt-metadata-only for suite 2 |

## A.8 Costs and accepted residuals

Per-message `34 + N×108` bytes, N DHs at send, one DH + one HMAC at
receive; hard cap N = 64 communicated once. "Authenticated for you" —
no transferable proof. **No forward secrecy, no PCS** — static-key
compromise plus recorded ciphertexts recovers old message keys via any
flap, self-flap included.

| Residual | Treatment |
|---|---|
| TOFU first fetch | automatic default; optional picture-word upgrade; loud only on key change |
| Withheld cert / stale view | no freeze; per-sender scope; unbounded staleness stated |
| Conversion TOFU | one signed manifest binds the claim; poisoned-roster residual stated |
| Democratic tallies | authorized-member attestation to a server-reported outcome |
| Deniability | "authenticated for you"; no moderator-verifiable evidence |
| No FS / PCS | stated, accepted |
| Fresh device, no backup | no legacy-key substitution ever (no-suite-1); but conversion is TOFU — a poisoned manifest can include a decrypting principal on that fresh view; backup restores protection; recreation for high assurance |
| Room size | hard cap 64 at member-add; over-limit channels resolved at migration |

**Audit coverage:** C-01 — no server-substitutable group key for fanout
traffic; membership now validated against a signed authority root;
closure conditional by mode (dictator cryptographic / democratic
attested) and identity assurance; the stale-view, conversion-TOFU and
no-backup-fresh-device residuals stated. H-01 — live suite-2 objects
after admission, against a pinned sender; granted and legacy history
carry their own labelled scopes. L-01 — out of scope, separate work.

## A.9 Dark development, Gate F, and mixed clients (P83-A-R2-07)

Slices A-1 … A-8 land dark (build-time flag; servers may accept early).
**Gate F is one atomic client release** activating certs + gating +
anchors + history + adoption + assurance UI together.

**The mixed-client boundary, defined:** the hello frame gains the
client's protocol era; the welcome advertises the server's required era.
At Gate F: a pre-F session receives a controlled
`client_upgrade_required` before any fanout delivery or send attempt;
the SPA preserves the composer draft, reloads once, reconnects, and
resumes. **Conversion of a channel is not initiated while the server
reports active pre-F official sessions for its members** — they are
upgraded (the reload) or explicitly disconnected first — and that report
**aggregates across every `chalkd` instance** through the existing shared
presence/pubsub mechanism, never just the converting instance's own
connections; a stale aggregate may *delay* conversion but can never
permit mixed-era delivery. A two-client mixed-version acceptance test
(old tab + new tab, drafts surviving), including a two-instance variant,
is part of the gate. A brief software-update boundary, not an ongoing
roadblock.

## A.10 Slices

| Slice | Content (dark until Gate F) |
|---|---|
| A-1 | Pairwise HKDF tree (incl. `K_history`); flaps; HMAC tags; frozen parser + full vectors; WebCrypto disposal rules |
| A-2 | Anchors (converter/owner split) + manifest + `manifest_admit_ref` + complete policy artifacts + membership/guest certificates (`lookup16`, expiry rules): canonicals, pure state machine, server tables (per-channel anchor CAS; `(channel,target,n)` and `(channel,p)` idempotency), rollback latches, policy-fork behavior |
| A-3 | Canonical envelope reuse; verify policy; typed results incl. `granted` |
| A-4 | Suite-2 send/receive; self-flap; `key_version` exemptions per inventory |
| A-5 | Edits, reactions (sealed clear), attachments-in-envelope, voice pairwise sealing |
| A-6 | Guests: `0x04` fragment form, guest certs, fragment-anchored verification |
| A-7 | Grantor-attested history: grant wire, storage/quota/expiry, auto-grant + paging + knob, `granted` UI |
| A-8 | Adoption state machine (restore/verify/convert/read-only); the client-minted-ID creation wire (anchor + manifest in `create_channel`, one-transaction insert, idempotent retry, pending-op records, the DM rule); `channel_security_enc` backup (89-byte records, paged); read-only legacy rendering; era capability + `client_upgrade_required` |
| A-9 | **Gate F**: emission on; conversion rollout; over-limit handling; `CHALK_FAN_REQUIRED` + `chalkctl fanout`; threat-model staging move |
| A-10 | Legacy retirement: wrapsig secure default; cert-gated legacy reshares; pre-F sunset |

---

# Option B — first-responder rotation (unchanged, unreviewed)

Any current member may rotate after a departure; first mover wins. The
exact delta to the sixth-revision plan: (1) authority table `key_epoch` →
any current member, both modes; (2) schema validation "actor in replayed
membership"; (3) `RotateChannelKey` SQL: `created_by` check → membership
`EXISTS`, monotonic version guard untouched; (4) `not_channel_creator` →
`not_a_member`; (5) `rotate_needed` fanned to all remaining members (both
call sites) and the client catch-up drops its creator gate, with sorted
member-ID jitter; (6) races: the committed-event-first machine and R5-01
abandon rule extend verbatim from two creator devices to two members;
(7) **epoch supersession**: a committed-but-unfilled epoch from a
vanished member may be superseded at `v+2` after a timeout, the server's
wrap-publish gate re-anchored on the highest committed `key_epoch` in
the events table it stores — unfreeze requires the latest epoch;
(8) per-channel rotation rate limit; (9) the threat-model claim improves
to "after the first remaining member rotates". B changes nothing else;
it is the "five reviews of hardening, one row changed" option.

---

# The recorded middle option — per-sender streams (superseded draft)

Commit `fd9d0b6`: one hash-ratcheted, identity-signed outbound stream per
(member, device, channel), phase-82 wrap distribution, unilateral
per-sender resets (no freeze), dense per-stream indices, certificate
membership. Between A and B: more moving parts than A, better history
semantics, non-deniable. In git history if reconsidered.

---

# Choosing

| | Main plan (6th rev) | B: first-responder | A: envelope fanout (this revision) |
|---|---|---|---|
| Departure freeze | until creator acts | seconds | none |
| Creator crypto role | load-bearing | none | anchor signer only (once) |
| Review state | 5 rounds, Gate 0 pending | unreviewed delta | 2 rounds: "viable, revise" — revised here |
| Membership | transcript (fork proofs) | transcript (fork proofs) | anchors + policy chain + per-target chains, rollback latch |
| Deniability | no | no | **yes** ("authenticated for you") |
| New-member history | as today | as today | grantor-attested (explicit, labelled) |
| Per-message cost | 1 sign / 1 verify | 1 sign / 1 verify | N DH+HMAC / 1 DH+1 HMAC, N ≤ 64 |
| Timestamps / edit history | sender clock / retained | sender clock / retained | receipt time / not retained |
| Fresh-device downgrade | per-device adoption | per-device adoption | **no-suite-1 rule** + backup; residuals stated |

Recommendation: **B** for speed inside the hardened main plan; **A** —
now carrying an authority root, atomic conversion, the no-suite-1 rule,
era-tagged guest links, its own backup contract and a defined rollout —
for the simplest and only deniable system on the table. Gate 0 reviews
the chosen document before slice 1.

## Prior-art sources

- WhatsApp Encryption Overview: <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay: <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec: <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Nebuchadnezzar: <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420: <https://datatracker.ietf.org/doc/html/rfc9420>
- Signal Private Group System: <https://eprint.iacr.org/2019/1416.pdf>
- iMessage security overview: <https://support.apple.com/guide/security/imessage-security-overview-secd9764312f/web>
- Signal Double Ratchet (why no FS is claimed): <https://signal.org/docs/specifications/doubleratchet/>
- W3C WebCrypto (key-disposal limits): <https://www.w3.org/TR/WebCryptoAPI/#security-developers>

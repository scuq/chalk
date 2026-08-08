# Phase 83 — MSGSIG: envelope fanout

**Status: the phase-83 plan — planned, not started; fifth revision, five
review rounds, Gate 0 pending. Decided 2026-08-08: envelope fanout
(formerly "option A" of `PHASE-83-MSGSIG-ALTERNATIVE.md`, this file's
previous name) supersedes the original transcript design that lived at
this path. The rejected designs are recorded in "The decision" at the end
and preserved in git history.**

No group key exists at all: every message wraps its own key once per
member over pairwise-derived secrets, and authenticity is a per-recipient
MAC — deniable, rotation-free, freeze-free. Born from the usability audit
that found the transcript design's user-felt costs — the departure freeze
above all.

**Reviewed 2026-08-08 five times** (findings numbered `P83-A-*`; the
section letters below match): first (commit `177d14c`) — "viable,
revise", P83-A-01 … 06; second (commit `e774247`) — A-04/A-05 resolved,
seven blocking R2-01 … 07; third (commit `8a0931a`) — R2-03/06/07
resolved, *"close to reviewable completion"*, five narrow blocking
findings P83-A-R3-01 … 05; fourth (commit `eb1ee873`) — all R3 findings
answered in structure, **five blocking state-machine/commit-protocol
findings P83-A-R4-01 … 05**; fifth (same commit, independent re-review)
— all five R4 findings confirmed against source, plus **P83-A-R5-01**
(receive-side sender membership) and new completion items. **This
revision incorporates all of them.** The reviewer's principle stands: *a
design that protects a conversation only by repeatedly preventing people
from using it is not a successful secure-messaging design.*

**Gate 0 applies:** independent re-review of this revision before any code.

**Tag:** `#msgsig`.

---

## Review dispositions

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

Fourth review (2026-08-08, commit `eb1ee873`) and fifth review (2026-08-08,
same commit — an independent re-review that confirmed every fourth-review
finding against plan text and source, then added one of its own), all
answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-A-R4-01 (Critical) | The backup merge ordered competing trust roots by `policy_p` — a sequence meaningful only inside one anchor's chain (and, worse, one that advances only on mode changes) | §A.7 (merge keyed by `(channel, anchor_hash)`; a per-record `rev` orders within one root; different anchors are always a surfaced conflict; `policy_p` demoted to latch restoration) |
| P83-A-R4-02 (High) | "Page 0 last" over in-place page keys is not atomic — an authenticated mixture of generations can drop authority anchors | §A.7 (double-buffered page namespaces; a generation id in every page; one authenticated commit record written last as the atomic switch) |
| P83-A-R4-03 (High) | The owner could not sign the effective guest expiry: the mint flow clamps server-side and reveals `expires_at` only in the ack | §A.5 (client-chosen absolute `expiry_ms` inside advertised caps, signed before mint; one-transaction invite + admit storage; idempotent retry; atomic revoke; directional skew and the accepted-before-expiry rule) |
| P83-A-R4-04 (High) | Falling back to the last common policy after a fork could un-verify an observed removal and restore the target's flap | §A.4 (the monotonic omit latch: intersection for admissions, union for removals, across fork discovery) |
| P83-A-R4-05 (High) | Multi-instance Gate F asserted "never mixed-era delivery" over per-device, era-less presence rows that cannot represent it | §A.9 (the durable required-era epoch + per-instance ack barrier; hello, send and delivery gate on it; presence demoted to UI) |
| P83-A-R5-01 (High) | The receive pipeline never consulted the sender's chain, and pairwise MAC keys outlive removal — an ex-member plus the malicious server injects `authenticated-for-you` messages forever | §A.5 (the sender-acceptance rule; the `unauthorized-sender` typed result; directional historical assurance) |
| Completion items | `lp()`/`gov_record` bytes; history quota keying; tombstone retention vs dormant devices; guest flaps vs the flap cap; forks had no exit; one shared grant AAD shape | §A.3–§A.7 (canonical conventions, per-grantee quota, tombstones-as-UI rule, cap accounting, the era door, the grant subtype byte) |

---

# The design — envelope fanout, in full

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

The body plaintext is the canonical envelope inherited from the retired
transcript plan (typed objects `0x01/0x02/0x03`, `client_msg_id`,
`sender_ts`, parent binding, attachment bindings — exact bytes preserved
with that plan in git history; A-3 re-freezes them here) minus the
signature; `object_hash = SHA-256(canonical)`.
Verification results: `authenticated-for-you` / `mismatch` / `forged` /
`unpinned` / `granted` / `legacy` / `unauthorized-sender` (a valid tag
from a principal whose chain does not currently end in admit — §A.5's
acceptance rule). Attribution fails closed; availability does not.

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

**Canonical conventions (frozen):** `sig64` = the signer's raw Ed25519
signature, exactly 64 bytes, appended with **no length prefix**; any other
length is `malformed` before hashing, and every `*_hash` below is
`SHA-256(canonical || sig64)`. `gov_record` carries over the retired
transcript plan's frozen canonical, kept normative here:
`uuid16(proposal_id) || u8(proposal_type) || uuid16(target) ||
u8(mode_payload) || u32be(eligible) || u32be(yes) || u32be(no) ||
u32be(quorum_percent) || u32be(threshold_percent)`, with
`yes + no ≤ eligible`, every count `< 2^31`, percents `≤ 100`. It is
present **iff** `auth_arm ≠ 0x00` — presence is a function of
`auth_arm` alone, a mismatch in either direction is `malformed`, and
trailing bytes after the last field are `malformed`. Mutation vectors
cover missing, duplicate and trailing optional fields (A-2).

### The anchors (the authority root)

```
channel_anchor    (born-fanout, signed by the creator; creator = owner):
  utf8("chalk-chan-anchor.v1") || u8(kind = 0x01)
  || uuid16(channel) || u8(era = 1)
  || uuid16(owner) || h32(owner_ed25519_fp)      // = the creator, locally known
  || u8(mode) || u8(chan_kind)
  || h32(member_manifest_hash)
anchor_hash = SHA-256(canonical || sig64)        // conventions above

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
- **A fork has a door (the fifth review's exit item)**: the anchor's
  `era` byte is the recovery path. The **owner** (the anchor's owner
  slot, never the converter) may sign a successor anchor at `era + 1`
  whose canonical embeds the hashes of **both** fork heads it resolves
  (conversion fork: both anchor hashes; policy fork: both policy heads)
  plus a fresh manifest. A client accepts an era successor only when it
  is owner-signed *and* references exactly the fork evidence that client
  holds; acceptance is surfaced like the fork itself and re-runs the
  §A.7 adoption machine — never silent. Without one, "recreate the
  channel" remains the documented fallback. This is the one canonical
  deliberately left at sketch level: it only exists downstream of
  already-surfaced fork evidence, and A-2 freezes its exact bytes.

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
policy_hash = SHA-256(canonical || sig64)    // validated against the actor's
                                             // pinned key before hashing
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

**The removal latch is monotonic across fork discovery (P83-A-R4-04).**
Falling back to the last common policy must never *un-verify* a removal:
under fork fallback the effective roster is computed as **intersection
for admissions, union for removals** —

- a removal, once fully verified under a policy state that was valid when
  observed, keeps its target-local **omit latch** even if that policy
  head is later found forked; the flap never comes back on ambiguity;
- no recipient admitted only on either forked branch is included;
- recipients whose admitted state predates and is common to the fork
  continue receiving flaps normally; and
- the latch clears only the legitimate way — a *new* admit at the
  target's next `n`, chained past the removal, valid under the retained
  common policy or under a post-resolution (`era + 1`, above) state.

A policy ambiguity is surfaced per affected target/transition; it never
re-discloses content to a departed member, and ordinary messages to the
common safe roster continue.

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
cert_hash = SHA-256(canonical || sig64)
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
target (§A.4) + self → send. **Cap accounting (the fifth review's
guest-flap item):** `MAX_FLAPS = 64` bounds *flaps*, so it is enforced
over **members plus active guest admissions** (unexpired, unrevoked) —
an admit or guest mint that would take the sum past 64 is refused
**client-side**, where the certificates are minted; the parser's flap
bound and the manifest's `n ≤ 64` already refuse the result; the
server's member-add check is convenience, never the boundary (a
malicious server enforces nothing). A full 64-member channel therefore
has no guest slot until someone leaves or a guest lapses — stated in the
invite UI, not discovered at send time.

**Receive:** own flap → DH → unwrap → decrypt → parse → derive
`K_mac(claimed_sender→me)` from the pinned identity → recompute tag →
**sender acceptance (below)** → typed result; inner wins on mismatch.

**The sender-acceptance rule (P83-A-R5-01) — a valid tag is necessary,
never sufficient.** The pairwise secrets are static-static: removal
revokes *nothing an ex-member holds*, so an ex-member can compute valid
flaps and MACs for every current member forever. Membership must
therefore be checked where messages are **accepted**, not only where
flaps are emitted:

- a suite-2 object renders as current with full assurance only when the
  claimed sender is a manifest member or a target whose verified chain
  **currently ends in admit** — evaluated under §A.4's rollback,
  observed-removal and fork latches, at the moment of first local
  acceptance;
- anything else is the typed result **`unauthorized-sender`**:
  attribution fails closed — surfaced and flagged as evidence, never
  silently rendered as a member's words and never silently dropped;
- **assurance is directional**: an object accepted *before* the removal
  was observed keeps its assurance permanently; one first fetched
  *after* cannot prove it predates the removal (`sender_ts` is display
  only) and takes the flagged state. Fresh devices lose nothing real:
  their pre-join scrollback arrives grantor-attested as `granted`
  (§A.6) rather than through this path;
- a recipient whose view is stale (the removal cert withheld) accepts —
  that is the already-stated withheld-cert residual, unchanged in scope;
- voice: a pairwise-sealed signal from a principal failing the same
  check is refused identically; and
- vectors (A-4): post-removal injection; a pre-removal message
  re-fetched after the removal is observed; removal observed
  mid-session; a revoked guest re-using its admitted key.

This is a client-local check against chains the client already fetches
and verifies — no round trip, no coordinator, no freeze; the stale-view
residual bounds it exactly as it bounds send-side flap emission.

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
  form. (The retired transcript design's `0x03` era byte died with it;
  the tags were kept distinct regardless, so no ambiguity survives.)
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
  cert**, and the skew rule is **directional** (P83-A-R4-03): an admit
  validates *new* traffic only while
  `local_now ≤ expiry_ms + 5 minutes` — there is no grace in the other
  direction, and **"historical assurance" means an object this device
  already locally accepted** before the lapse. A guest object first
  fetched after expiry cannot prove it predates it (`sender_ts` is
  display only) and takes §A.5's flagged state. Vectors: admit→revoke
  transition, replay of a revoked admit, cross-invite substitution
  (lookup mismatch), cross-era substitution, expiry boundary at the skew
  edge in both directions, first-fetch-after-expiry.
- **The mint is atomic, or it does not happen (P83-A-R4-03).** Today's
  flow cannot produce the signed expiry — the client sends `ttl_secs`,
  the server clamps to its ceiling and the channel's remaining life, and
  only the ack reveals `expires_at` — so the fanout mint wire changes:

  - the server **advertises** its invite ceiling and the channel's
    remaining life (welcome/summary), the client computes
    `expiry_ms = min(user choice, ceiling, channel expiry)` as an
    **absolute** time, signs the `guest_admit` over exactly that value,
    and sends invite material + `expiry_ms` + the certificate in one
    request;
  - the server **never clamps**: it accepts iff the submitted
    `expiry_ms` is within both caps *at commit time*, and stores invite
    and admit certificate in **one transaction** — an invite without its
    certificate never exists, in no interval;
  - a race that moved a cap rejects with the current cap; the client
    re-signs and retries transparently — an internal round trip, still
    one "create link" action;
  - retry is idempotent by `(lookup16, cert_hash)`: byte-identical
    resubmission acks success (a lost ack never costs the user a second
    link); the same lookup with a different certificate is an error; and
  - **revoke is the same shape**: one transaction stores the signed
    `guest_revoke` and marks the lookup unusable — a revoked lookup
    without its revoke certificate never exists either.
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
            || u8(subtype = 0x01)          // 0x01 history, 0x02 legacy key
                                           // — the subtypes never share an
                                           // AAD, not only a type string
```

- **One grant = one `grant_id` + one absolute range, complete in itself**
  (`chunk_count` fixed at creation). Scrolling into older history creates
  a **new, independently complete grant** with its own id and range —
  paging never mutates a prior grant.
- Server storage/forwarding keyed by `(grantee, grant_id, chunk_index)`,
  idempotent; **quota keyed per grantee** (the fourth review's collision
  item): **32 stored chunks per `(grantor, channel, grantee)`**, so
  normal automatic grants to different new members never exhaust one
  another, under an overall abuse ceiling of **256 chunks per
  `(grantor, channel)`** with oldest-expired eviction — constants, not
  knobs; **expiry**: blobs deleted after fetch-ack or 30 days, whichever
  first.
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
  uuid16(grant_id) || u32be(0) || u8(subtype = 0x02)`. A granted era
  opens everything that era retained; no narrower window is claimed.

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
client-minted-UUID move the retired transcript plan adopted for genesis
applies here):

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
keys    "channel_security_enc.a.<i>" / "channel_security_enc.b.<i>"
        (double-buffered page namespaces) + "channel_security_commit"
KDF     HKDF over the identity X25519 scalar,
        salt "chalk-chansec-salt-v1", info "chalk-chansec-v1"

record  uuid16(channel) || u8(flags) || h32(anchor_hash)
        || h32(policy_head) || u64be(policy_p) || u32be(rev)
        = 93 bytes exactly. flags bit0 = era-adopted; bit1 = conflict
        record (a second anchor for the same channel — both records
        survive, surfaced as fork evidence); bit2 = tombstone (channel
        left/deleted; dropped at the next repack after 30 days).
        rev (P83-A-R4-01) = a per-(channel, anchor_hash), identity-local
        revision counter, bumped by every state change the record
        encodes (adoption, latch advance, conflict flag, leave, rejoin).
        It exists because policy_p CANNOT order the merge even inside
        one anchor: p advances only on mode changes, while adoption,
        leaves and latch updates never touch it. policy_p stays in the
        record purely to restore the rollback-latch floor.

pages   double-buffered namespaces (P83-A-R4-02):
        "channel_security_enc.a.0" … and "channel_security_enc.b.0" …,
        plus one commit key "channel_security_commit".
        page plaintext = u8(v = 1) || gen16 || u8(page_index)
                      || u8(page_count) || u16be(record_count) || record*
        sealed        = nonce(12) || AES-256-GCM(K, plaintext) || tag(16)
        page AAD      = utf8("chalk-chansec-s1:") || u8(page_index)
        commit plaintext = u8(v = 1) || gen16 || u8(ns: 0x00 a / 0x01 b)
                      || u8(page_count) || h32(sha256(sealed_page))*
        commit AAD    = utf8("chalk-chansec-commit-s1:")
        gen16 = 16 CSPRNG bytes minted per repack.
        Budget: sealed+base64 must fit the 7,900-byte prefs value —
        usable plaintext ≈ (7900 × 3/4) − 28 − 21 ≈ 5.7 KiB ⇒
        **≤ 63 records per page** (93 B each).
        Writer: repack wholesale (records sorted by uuid16(channel),
        then anchor_hash — two surviving records for one channel need
        the tiebreak), write EVERY page of the new generation into the
        INACTIVE namespace, then write the commit record last. The
        commit is one prefs value — its overwrite is the atomic switch.
        Reader: fetch commit → fetch the named namespace's pages →
        accept only when every page's gen16 and sealed-bytes hash match
        the commit; anything else (torn write, crashed writer, withheld
        page) keeps the previous local state — and a fresh device
        treats the backup as absent and retries, because a crash before
        commit leaves the OLD generation fully intact in the other
        namespace. The losing namespace is garbage: the next repack
        overwrites it.

merge   keyed by (channel, anchor_hash) — NEVER by channel alone, and
        policy sequence never orders competing roots (P83-A-R4-01):
        - same (channel, anchor_hash): higher rev wins; equal rev,
          identical bytes: one record; equal rev, different bytes: keep
          both and surface (a genuine same-identity write race), with a
          tombstone winning an equal-rev tie — hiding a channel is
          reversible, re-disclosure is not;
        - one channel, live records under different anchor_hashes: BOTH
          are retained with bit1 set and surfaced as a channel-conversion
          fork — regardless of either record's policy_p or rev. A device
          with a locally trusted anchor keeps using it and refuses
          transitions rooted in the competitor; a fresh device with no
          prior local basis makes only that channel read-only until the
          conflict resolves (§A.4's era door, or recreation). Other
          channels are untouched;
        - policy_p is consulted only after the refetched policy chain
          validates under the record's own anchor, as the restored
          latch floor — never as merge order; and
        - tombstones order by rev like any record. Dropping one after
          30 days is safe because the backup is never authority: chains
          are refetched and re-verified, so a dormant device's
          resurrected live record renders the channel in its true
          post-leave state (the verified leave cert suppresses it
          again) — the tombstone only hides UI.
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
traffic; membership validated against a signed authority root **at both
flap emission and message acceptance** (§A.5 — removal is two-sided:
the omit latch stops disclosure *to* a departed member, the
sender-acceptance rule stops authenticated speech *from* one); closure
conditional by mode (dictator cryptographic / democratic attested) and
identity assurance; the stale-view, conversion-TOFU and
no-backup-fresh-device residuals stated. H-01 — live suite-2 objects
after admission, against a pinned sender whose membership is re-checked
at acceptance; granted and legacy history carry their own labelled
scopes. L-01 — out of scope, separate work.

## A.9 Dark development, Gate F, and mixed clients (P83-A-R2-07)

Slices A-1 … A-8 land dark (build-time flag; servers may accept early).
**Gate F is one atomic client release** activating certs + gating +
anchors + history + adoption + assurance UI together.

**The mixed-client boundary, defined:** the hello frame gains the
client's protocol era; the welcome advertises the server's required era.
At Gate F: a pre-F session receives a controlled
`client_upgrade_required` before any fanout delivery or send attempt;
the SPA preserves the composer draft, reloads once, reconnects, and
resumes.

**The cutover is a durable epoch with an instance-ack barrier
(P83-A-R4-05)** — presence rows are per-device, era-less and overwritten
on reconnect, so they cannot represent an old and a new tab on one
device; presence stays UI-only and is **never load-bearing here**:

- **one durable row** holds the required era (flipped once, deliberately,
  by `chalkctl fanout gate-f` — a database row, not a `CHALK_*` env var,
  precisely because it must be one value for the whole cluster and
  survive every restart);
- every `chalkd` instance records each connection's era at hello **in
  its own connection table** and enforces the epoch at all three gates —
  hello admission, send accept, fanout delivery — per frame, from its
  own memory: no cross-instance query is on any hot path;
- instances learn a flip by pubsub *and* re-read the epoch on their
  existing instance-heartbeat interval, so a dropped notification delays
  enforcement by at most one heartbeat, never indefinitely;
- the instance row (already heartbeat-maintained, already reaped when
  stale) gains an `acked_era` column, bumped when the instance has
  observed the epoch and upgraded or disconnected every pre-F session it
  owns. **The barrier: the epoch is *enforced* only when every live
  instance row carries `acked_era ≥` the epoch** — computed in one
  transaction over rows with fresh heartbeats. A dead row leaves the
  barrier by expiring; an instance wedged enough to stop heartbeating is
  wedged enough to deliver nothing new (delivery and heartbeat share the
  process), and its sockets die with their reaped row;
- **conversion and fanout emission begin only behind the barrier**: the
  welcome advertises `era` plus `era_enforced`, and a build-F client
  neither converts nor emits suite 2 until the latter is true — staleness
  can therefore only *delay* the cutover, never admit a mixed-era
  delivery, because the instance that would deliver to a pre-F tab has,
  by acking, already upgraded or disconnected that tab; and
- the acceptance test is explicitly hostile: two instances, an old and a
  new tab on one device (drafts surviving), a **dropped pubsub
  notification**, and an **instance crash and reclaim** mid-cutover.

A brief software-update boundary, not an ongoing roadblock.

## A.10 Slices

| Slice | Content (dark until Gate F) |
|---|---|
| A-1 | Pairwise HKDF tree (incl. `K_history`); flaps; HMAC tags; frozen parser + full vectors; WebCrypto disposal rules |
| A-2 | Anchors (converter/owner split) + manifest + `manifest_admit_ref` + complete policy artifacts + membership/guest certificates (`lookup16`, expiry rules): canonicals (`sig64`/`gov_record` conventions + mutation vectors), pure state machine, server tables (per-channel anchor CAS; `(channel,target,n)` and `(channel,p)` idempotency), rollback latches, policy-fork behavior + the monotonic removal latch, the era-door re-anchor bytes |
| A-3 | Canonical envelope reuse; verify policy; typed results incl. `granted` |
| A-4 | Suite-2 send/receive; self-flap; the sender-acceptance rule (`unauthorized-sender`, directional assurance) + its vectors; `key_version` exemptions per inventory |
| A-5 | Edits, reactions (sealed clear), attachments-in-envelope, voice pairwise sealing |
| A-6 | Guests: `0x04` fragment form, guest certs, fragment-anchored verification; the atomic mint/revoke wire (advertised caps, absolute signed expiry, one-transaction storage, idempotent retry); cap accounting at mint |
| A-7 | Grantor-attested history: grant wire, storage/quota/expiry, auto-grant + paging + knob, `granted` UI |
| A-8 | Adoption state machine (restore/verify/convert/read-only); the client-minted-ID creation wire (anchor + manifest in `create_channel`, one-transaction insert, idempotent retry, pending-op records, the DM rule); `channel_security_enc` backup (93-byte records, generation-committed double-buffered pages, anchor-keyed merge); read-only legacy rendering; era capability + `client_upgrade_required` |
| A-9 | **Gate F**: the required-era epoch + instance-ack barrier (`chalkctl fanout gate-f`, `acked_era`, the hostile two-instance test); emission on; conversion rollout; over-limit handling; `CHALK_FAN_REQUIRED` + `chalkctl fanout`; threat-model staging move |
| A-10 | Legacy retirement: wrapsig secure default; cert-gated legacy reshares; pre-F sunset |

---

# The decision (2026-08-08)

Envelope fanout is the phase-83 plan. Three designs were rejected, all
preserved in git history — the transcript plan is this path's content
before this date; the other two lived in `PHASE-83-MSGSIG-ALTERNATIVE.md`
(this file's previous name) until the decision:

- **The transcript design** (six revisions, Gate 0 never passed): a
  signed message envelope plus an authenticated channel-state transcript
  with a creator-anchored key epoch. Rejected for its user-felt costs —
  the departure freeze above all — which five hardening reviews reduced
  but could not remove while the creator's crypto role stayed
  load-bearing.
- **Option B — first-responder rotation** (never reviewed): a nine-point
  surgical delta to the transcript design letting any current member
  rotate after a departure — "five reviews of hardening, one row
  changed". Its premise retired with that plan.
- **Per-sender streams** (commit `fd9d0b6`, superseded draft): one
  hash-ratcheted, identity-signed outbound stream per (member, device,
  channel). More moving parts than fanout, non-deniable; in git history
  if reconsidered.

The comparison that decided it:

| | Transcript (retired) | B: first-responder (rejected) | Envelope fanout (this plan) |
|---|---|---|---|
| Departure freeze | until creator acts | seconds | none |
| Creator crypto role | load-bearing | none | anchor signer only (once) |
| Review state | 6 revisions, Gate 0 pending | unreviewed delta | 5 rounds, all findings answered |
| Membership | transcript (fork proofs) | transcript (fork proofs) | anchors + policy chain + per-target chains, rollback latch |
| Deniability | no | no | **yes** ("authenticated for you") |
| New-member history | as today | as today | grantor-attested (explicit, labelled) |
| Per-message cost | 1 sign / 1 verify | 1 sign / 1 verify | N DH+HMAC / 1 DH+1 HMAC, N ≤ 64 |
| Timestamps / edit history | sender clock / retained | sender clock / retained | receipt time / not retained |
| Fresh-device downgrade | per-device adoption | per-device adoption | **no-suite-1 rule** + backup; residuals stated |

The costs in the last three rows are accepted deliberately (§A.8): they
buy the only deniable, freeze-free, coordinator-free design on the
table. Gate 0 reviews this document before slice 1.

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

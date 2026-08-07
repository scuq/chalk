# Phase 83 — signed message envelopes and an authenticated channel-state transcript

The two cryptographic findings phase 81 confirmed and deliberately deferred,
and the one the 2026-08-05 audit follow-up put at the top of its
remaining-work list. **NOT IMPLEMENTED — no code exists.** This document is
the plan and nothing below it has been built.

**Status: design, third revision.**

- First revision, 6 August 2026: exploratory design. Reviewed 7 August 2026;
  six findings, P83-01 … P83-06, verdict *"accept as an exploratory design
  record, request major revision."*
- Second revision, 7 August 2026 (commit `9890571`): answered those six.
  Re-reviewed the same day: P83-02 and P83-04 **resolved**, the rest partial;
  **Gate 0 not passed**; seven new findings, P83-R2-01 … R2-07.
- This third revision answers the re-review. Both review documents are
  external, like the phase-81 audits; this doc is the in-repo record of what
  they found and how each finding was resolved.

**Gate 0: nothing in the slice table may start until this revision passes
independent protocol review.** Two review rounds have each found blocking
protocol errors on paper — which is the gate doing its job, and the reason
the canonical encoder still must not be implemented first.

**Tag:** `#msgsig` → `tools/where.sh -g msgsig` (which today finds this plan
and the documents that point at it, and no code, because none exists).

**Depends on phase 82.** The expensive half of both findings — an identity
anchor a signature can be checked against — was already paid for there:
`web/src/crypto/trust.ts` pins peer Ed25519 keys, and `channel-crypto.ts`
already verifies-then-decrypts against a pinned signer. This phase spends
that anchor twice more.

---

## Review dispositions

First review (of revision 1):

| Finding | Was | Resolved in |
|---|---|---|
| P83-01 | Option A claimed to close H-01 but left re-dating, reordering and replay open | §1 (staged claims), §4 (dedup model) |
| P83-02 | Format was circular: signature inside the plaintext *and* a ciphertext hash inside the signed envelope | §3 — **resolved per the re-review** |
| P83-03 | Half B deferred its central security decisions | §7 |
| P83-04 | Envelope claimed a device the per-user identity cannot prove | §2 — **resolved per the re-review** |
| P83-05 | Edits/reactions/attachments given message semantics implicitly | §5 |
| P83-06 | Migration, downgrade resistance, acceptance criteria incomplete | §6 |

Re-review (of revision 2), all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-R2-01 (Critical) | Transcript authority table contradicted chalk's real governance rules; server-tallied votes treated as authorization | §7 (per-mode authority; democratic exclusion) |
| P83-R2-02 (Critical) | Genesis could be suppressed into the legacy path — the server mints the channel ID, so a creation-time genesis was impossible as written | §7 (client-minted channel ID; adoption ratchet) |
| P83-R2-03 (High) | Transcript event contents not canonically specified; no admitted-key binding; no key commitment | §7 (frozen event fields; fingerprints; epoch commitments) |
| P83-R2-04 (High) | `chain_head` was a bare hash; the fork/staleness rules needed an index | §3, §7 (structured checkpoints; eventual detection) |
| P83-R2-05 (High) | The scalar replay watermark misclassified ordinary paginated history as replay | §4 (exact-identity dedup; evictions become unknown) |
| P83-R2-06 (High) | `edit_seq`/`rx_seq` were unsafe across a user's devices; edit targets bound only the untrusted server row | §5 (revision chains; content-identity targets) |
| P83-R2-07 (Medium) | Legacy vs downgrade cannot be distinguished without a trusted write-time boundary | §6 (classification withdrawn) |

---

## The two problems (unchanged since the first revision)

### H-01 — messages carry no sender signature

The AEAD associated data on a message is `msgAAD`
(`web/src/crypto/spacekey.ts`): `chalk-msg-s{suite}:{channelID}:{keyVersion}`
and nothing else. Sender, device, message ID, timestamp, thread and parent
are plaintext metadata the server attaches *outside* what is authenticated.

- A server can replay a ciphertext under a different sender, timestamp or
  thread and decryption still succeeds.
- Every member holds the same symmetric key, so ciphertext alone never
  proves which member authored anything. A key holder can forge a message
  from any other member without the server's help at all.

The same applies to everything whose meaning depends on server-supplied
context: edits, reactions and attachment references.

### C-01's residue — membership is server-asserted

Phase 82 made a wrap prove *who sent a key*. It cannot prove *who deserved
one*. The candidate list `openWrap` verifies against comes straight from the
server's roster, and an honest client auto-reshares the channel key to
whoever appears in it. A server that adds a principal it controls is handed
the key by a legitimate member. 82-8 makes this visible (join notice,
provenance line) — visibility, not prevention.

---

## §1 — Security goal, and explicit non-goals

**Guaranteed, once enforcement is on (§6):**

- **User-level authorship.** A message, edit, reaction set or attachment
  binding verifiably originates from the user it names, where "verifiably"
  means: checked against *this client's* pinned or manually-verified belief
  about that user's Ed25519 identity key (`trust.ts`). No other key holder —
  member or server — can produce an object that verifies as that user.
- **Relocation resistance.** A signed object cannot be presented in a
  different channel, against a different target, at a different key version,
  or under a parent the sender did not name. Every one of those is inside
  the signature.
- **Membership integrity in dictator-mode channels**, once Half B is
  enforced: keys are shared only with principals the replayed transcript
  authorizes. In **democratic-mode** channels this is **conditional** — see
  the exclusion in §7; the tally is server-trusted and the guarantee there
  is detection, not prevention.

**Detectable, not prevented:**

- **Duplication** of a genuine object the client currently holds identity
  state for, via the exact-identity dedup of §4. (Broader replay claims were
  withdrawn per P83-R2-05 — the client asserts only what it can prove.)
- **Re-dating.** The envelope carries the sender's own clock (`sender_ts`);
  the server's timestamp is demoted to *receipt metadata*. A server that
  re-dates a message produces a visible skew between the two, not a silent
  rewrite of history.
- **Stale or forked channel state**, once Half B ships, via checkpoint
  cross-attestation (§7) — and detection there is **eventual**, when
  evidence from the separated views meets, never immediate.

**Explicit non-goals — stated so nobody rounds up:**

- **Server-minted `id`, `ts` and `seq` are untrusted receipt metadata.**
  They order storage, drive paging and partitioning, and nothing more. The
  UI's authenticated notion of "when" is `sender_ts`; the authenticated
  notion of "which message" is the signed `(sender, writer_scope,
  client_msg_id)` triple.
- **Completeness.** A server can still withhold messages or events. Half B
  bounds this for channel state (§7); for messages it remains open.
- **Democratic tallies.** Votes are deliberately secret and unsigned;
  governance outcomes are enacted on the server's word. §7 states exactly
  what is and is not claimed there.
- **Denial of service.** Out of scope, as everywhere else in the threat
  model.
- **TOFU first-fetch.** Unchanged from phase 82: a server that lies from
  the very first identity fetch gets its key pinned, and only the
  out-of-band picture-word comparison detects it. Signatures verify against
  the pin, so they inherit exactly that limit.
- **Device attribution.** See §2. The guarantee is scoped to the user.
- **Forward secrecy / post-quantum.** Unchanged non-goals of the whole
  design.

**A fresh device (or cleared local state) starts with no dedup state, no
revision heads, no transcript head, and no pins beyond what the phase-84
backup restores.** Its detection guarantees begin at zero and grow. Stated
as a limitation, not hidden.

## §2 — Identity: user-only authorship, on the anchor we already have

*(Resolved in the re-review; unchanged in substance.)*

chalk's identity is per-user by design (`migrations/0031_identity_keys.sql`):
every device signed into an account derives the same X25519/Ed25519 pair
from the same phrase. A device ID is a random UUID in localStorage with no
key material behind it. A signature made with the identity key therefore
proves *the user*, and the envelope's `writer_scope` — an opaque UUID whose
**only** role is to namespace per-device sender state (§4, §5) — is
documented everywhere as an unauthenticated label. It is never rendered as
"sent from device X".

**Rejected: per-device signing subkeys** certified by the user identity —
a whole new sub-protocol (certificate format, revocation, storage, sync)
with no existing machinery and no product requirement. If a need appears it
layers on top without changing the envelope.

**The verification anchor is `trust.ts`, unchanged:** `resolveSigner` from
local pins on unattended paths; `fetchTrustedIdentity` (TOFU-pins) only
where `openWrap` allows the network today; `markManuallyVerified` (the
picture-word flow) upgrades the same pin, and a `changed` pin repudiates it;
the phase-84 backup carries the pins across devices. Message assurance maps
onto the existing `MemberTrust` vocabulary rather than inventing a parallel
one.

**Key rotation.** Not implemented today — nothing sets
`identity_keys.retired_at`. Verification is against the *pinned* key, full
stop. When rotation is built, it inherits a constraint recorded here: old
signatures must remain verifiable against a verified historical key or a
signed transition record, never silently re-checked against the current
key.

## §3 — Construction: sign-then-encrypt, and nothing circular

*(Resolved in the re-review; carried forward with one field change:
the chain reference is now a structured checkpoint, per P83-R2-04.)*

**Sign a canonical plaintext object; encrypt the object and its signature
together.** There is no ciphertext hash anywhere. The two layers divide the
work:

- The **AEAD** (AAD = `chalk-msg-s{suite}:{channelID}:{keyVersion}`)
  authenticates the ciphertext and binds it to channel and key version.
- The **inner Ed25519 signature** authenticates every sender-meaningful
  field, including channel and key version *again*, so the signature is
  self-contained even if a future suite changes the AAD.

The server never sees the signature and cannot strip it without breaking
the AEAD. Precedents: phase 82's wrap signature inside the opaque
`wrap_blob`; `signal-crypto.ts`'s `fp_sig` inside the sealed `SdpSignal`.
No schema change; `messages.meta` stays unused.

### The wire format

`CURRENT_MSG_SUITE` goes 1 → 2. A suite-2 body is, as today,
`suite(1) || nonce(12) || ct || tag(16)`; the plaintext becomes UTF-8 JSON:

```
{ "e": { ...typed envelope fields... }, "sig": "<base64 Ed25519 signature>" }
```

JSON is the transport shape only. **The signature is never computed over
JSON.** The verifier rebuilds the canonical byte string from the parsed
fields and verifies against that.

### The canonical encoding

```
lp(x)     = u32be(len(x)) || x
canonical = utf8("chalk-msg-sig.v1") || u8(objType) || <fields per class, §5>
```

- Domain `chalk-msg-sig.v1`, sibling of `chalk-wrap-sig.v1` and
  `chalk-voice-fp.v1`. Half B's transcript events use their own domain
  (`chalk-chan-sig.v1`, §7).
- `objType`: `0x01` message, `0x02` edit, `0x03` reaction set. Attachment
  bindings ride inside types 1 and 2.
- Every variable-length field is `lp()`-prefixed; fixed-width integers are
  fixed-width big-endian; lists are `u32be(count)` followed by each
  element's encoding; absent optionals encode as `lp("")` (absent and empty
  are deliberately the same: "no value").
- The **chain checkpoint** is a structured pair, not a bare hash:
  `u64be(chain_index) || lp(chain_hash)` — `(0, lp(""))` until the channel
  has a transcript (§7 defines the receiver's state machine).
- 83-1 **exports** the private helpers from `spacekey.ts` (`writeU32BE`,
  `lengthPrefixed`, `concat`, `bytesEqual`, `utf8`); both
  `canonicalWrapMessage` and the new encoders use them. Two canonical
  encoders that drift apart is the failure mode this phase exists to avoid.

### Sign and verify behaviour

The repo's established asymmetry: **signing throws** on degenerate input
(programmer errors); **verification never throws** and returns a typed
result on every path (attacker-reachable, must be total). Results:

| Result | Meaning |
|---|---|
| `verified` | Signature valid against the pinned/verified key for the signed sender, and every server-supplied outer field matches its signed inner counterpart |
| `mismatch` | Signature valid, but an outer field (sender, parent, thread, target…) disagrees with the signed value — the server's framing is forged; the inner values are authoritative |
| `forged` | Signature invalid against our belief about the signed sender's key |
| `unpinned` | No local pin for the signed sender and the path may not fetch — decided later, not trusted now |
| `unsigned` | Suite-1 object — rendered unauthenticated, uniformly (§6) |

**On `mismatch`, the signed inner fields win, always.** **Content is
displayed even when attribution fails**, under an unmistakable warning:
only channel-key holders can produce decryptable content at all, so hiding
it would hand a hostile server a censorship lever (corrupt an envelope,
suppress a message). Attribution fails closed; availability does not.

## §4 — Deduplication and ordering: exactly what the client can prove

**P83-R2-05's fix.** The second revision's scalar watermark ("`wseq` at or
below the high-water mark ⇒ replay") is deleted: chalk loads history,
thread previews, search results and channel summaries out of order by
design, so a newest-first page followed by a scroll into older messages
would have flagged ordinary rows as replays. False security warnings train
users to ignore real ones. The replacement claims only what is provable:

### Sender side

Every plain message envelope carries:

- `client_msg_id` — a fresh UUID, minted **before** anything else in the
  send flow (§5).
- `sender_ts` — the sender's clock, unix millis. The authenticated "when".
- `writer_scope` — an opaque UUID naming this device's sender-state store.
  **One scope per device counter-store, never shared across devices.** If
  the store is lost while the localStorage device ID survives, the client
  mints a **new** scope rather than restarting an old one — a scope whose
  state you do not hold is never reused.
- `wseq` — strictly increasing per `(channel, writer_scope)`, persisted in
  the sender's IndexedDB. **In this phase `wseq` is an ordering claim
  only**: it feeds display and future completeness-range work, and
  generates **no security warnings**. (A future revision may add
  completeness-aware range tracking on top; the field is already there.)

### Receiver side

One bounded IndexedDB store (a new store; `idb.ts` takes its first
`DB_VERSION` bump since v4 — mechanical):

- **Exact-identity dedup**: signed `(sender_user_id, writer_scope,
  client_msg_id)` → first-seen `server_id`, bounded LRU. The same triple
  arriving under a **different** server row is a duplicate — the second
  presentation is dropped and the event flagged (a server replay or a
  resend race; either way not a second message).
- **Eviction produces "unknown", never "replay".** Once an entry has aged
  out of the LRU, the client makes no claim about later presentations of
  that identity. No arrival order, page order, or gap is ever classified
  as suspicious by itself.

**What this buys, honestly:** duplicates within the dedup window are
eliminated; re-dating is visible as `sender_ts` / server-`ts` skew
(surfaced in the message's info affordance past a threshold); ordering
within one writer's scope is displayable from signed data. **What it does
not buy:** replay detection beyond the window, a fresh device auditing
history it never held, or detection of withholding. All stated in §1.

### Rejected alternatives (recorded)

- **Option B, the client-minted message ID** (first review): `messages` is
  partitioned by range on `ts` with PK `(ts, id)`, and Postgres unique
  indexes on a partitioned table must include the partition key — global
  uniqueness of a client-supplied ID is unenforceable without redesigning
  the partitioning, and without it a hostile client gets an equivocation
  primitive for free.
- **The scalar watermark** (second revision): misclassifies paginated
  history; see above.

## §5 — Typed object protocols, and the flows that make them possible

**P83-05's and P83-R2-06's fixes.** One envelope per object class; message
semantics are applied to nothing else — voice signals (already signed under
`chalk-voice-fp.v1`), prefs blobs, the parking lot, and link previews
(embedded in the body before encryption) keep their existing shapes.

### The send-flow reorder (prerequisite)

Today `onSend` runs *encrypt → upload attachments → mint `client_msg_id` →
send*. New order:

```
mint client_msg_id
→ upload attachments (ids + ciphertext digests come back)
→ build envelope (all fields known) → sign → encrypt → send
```

The optimistic append moves with the mint. Guest sends in `GuestRoom.tsx`
get the same order.

### `0x01` — message

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(writer_scope) || lp(client_msg_id) || u64be(sender_ts)
|| u64be(wseq) || lp(parent_id)            // lp("") when not a reply
|| u64be(chain_index) || lp(chain_hash)    // (0, lp("")) pre-transcript
|| lp(utf8(body_text))
|| u32be(att_count) || att_binding*
```

Each `att_binding`:

```
lp(attachment_id) || u32be(att_key_version) || u64be(byte_len)
|| lp(sha256(full_ciphertext)) || lp(sha256(enc_meta))
|| lp(sha256(enc_preview))                 // lp("") when no preview
```

- `parent_id` is what the *sender* names; the server's derived `thread_id`
  is receipt metadata, checked against the signed parent on display
  (`mismatch` if the server moved the message into a thread the sender did
  not reply into).
- Attachment digests are over the *ciphertexts*, which exist before the
  message is built (blobs are encrypted before `initUpload`; the IDs
  arrive with the upload; both precede the envelope). Receivers verify
  every fetched or inline blob against the signed digest before
  decrypting; a mismatch renders the attachment as tampered. An attachment
  ref not covered by its parent's envelope renders unauthenticated.
- `att_key_version` is per attachment because an upload pins its own key
  version, which can lag the message's across a rotation.

### The signed content identity, and target binding

A suite-2 message's durable, signed identity is the triple
`(sender_user_id, writer_scope, client_msg_id)` from its envelope. **Edits
and reactions bind their target by this content identity, taken from the
decrypted original envelope — not by the server row locator.** The wire
frames still carry `(channel_id, message_id, ts)` for row lookup; inside
the envelope those are receipt metadata. A **legacy suite-1 target** has no
content identity: the binding encodes as three `lp("")` fields and the
edit/reaction renders with an unauthenticated-target mark. Stated plainly:
operations on legacy rows cannot be strongly bound, ever.

### Revision chains (shared by edits and reactions)

`edit_seq` and `rx_seq` from the second revision are **deleted** — a
user's devices share one signing key and cannot coordinate counters, so
two devices could honestly sign the same "next" number and the server
could show different valid objects to different recipients (P83-R2-06).
The replacement is a per-object hash chain:

- Each revision signs `prev_rev_hash` — the SHA-256 of the canonical
  envelope it replaces (`lp("")` for the first revision of an object).
- The receiver keeps, per target, the hash of the **latest verified
  revision**. A revision extending that head advances it. A revision whose
  `prev` matches an *older* point is **stale**: it can no longer displace
  what the client holds — the old-edit-replay attack dies here.
- Two revisions with the **same** `prev` are a **concurrent fork**: both
  signatures genuine, both preserved, presentation order is the server's
  and is labelled unauthenticated; the UI surfaces "edited concurrently on
  two devices" rather than pretending an order.
- **Fresh-reader honesty:** a client that never held prior revisions
  verifies the current revision's signature and target binding, and can
  audit nothing about chain depth. What it can prove: *this user produced
  this content for this target*. What it cannot: *this is the latest
  revision*. Stated, not papered over.

### `0x02` — edit

An edit **replaces the row's body** (`UPDATE messages SET body = …`), so
the edit envelope is self-sufficient *given a verified target identity*:

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(tgt_sender) || lp(tgt_scope) || lp(tgt_client_msg_id)  // content identity
|| lp(prev_rev_hash)
|| u64be(sender_ts) || u64be(chain_index) || lp(chain_hash)
|| lp(utf8(body_text))
|| u32be(att_count) || att_binding*        // re-stated from the original
```

- Only the original sender may edit (server-enforced today; the signature
  now enforces it cryptographically — `sender_user_id` must equal
  `tgt_sender`).
- Attachment bindings are re-stated verbatim because the UPDATE destroys
  the original envelope; attachments must not become unauthenticated by
  editing a caption.
- Wire gap closed in the same slice: `message_edited` gains the editor's
  user ID (display-before-decrypt convenience, checked like any outer
  field).

### `0x03` — reaction set

Whole-set replacement per `(actor, target)`, chained like edits:

```
lp(channel_id) || u32be(key_version) || lp(actor_user_id)
|| lp(tgt_sender) || lp(tgt_scope) || lp(tgt_client_msg_id)
|| lp(prev_set_hash)                       // lp("") for the actor's first set
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*        // zero-count = cleared
```

- **Clearing stays a signed, sealed empty set** (`emoji_count = 0`) — the
  current bare `body: ""` special case, which skips the key-version
  requirement and the ceiling check server-side and produces an
  unauthenticated, unencrypted push, is retired; the server stores and
  pushes a clear as a normal value and its skip-the-checks branches are
  deleted.
- Stale sets cannot displace newer held ones (chain rule); concurrent
  device sets surface as a fork with server-order presentation, flagged
  not authenticated.
- Any member may react (unchanged); the signature binds the actor.

### Guests

Guests derive a full Ed25519 identity from the link secret and can sign
(`GuestRoom.tsx` holds a `DerivedIdentity`); guest identities are served by
`fetch_identity` since 80-9. Guests sign like members; members verify a
guest like any peer. A guest verifies members best-effort with in-session
TOFU pins (no durable pin store, no phase-84 backup) — the guest-path
limitation, stated. Links minted before 82-7 remain unsigned-wrap territory
until expiry — unchanged, out of scope here.

### Previews (thread inbox, search, channel summaries)

A preview renders outer `sender` and `ts` beside decrypted text; until the
underlying row is verified those are receipt metadata, and the preview
carries the same assurance mark as a full row — a preview must never look
*more* trustworthy than the message it previews. Wire gap closed so
previews are verifiable at all: `ThreadInboxEntry` gains the head and
last-reply **message IDs** (the server already holds
`thread_activity.last_reply_id`; it just never sent it).

## §6 — Migration, downgrade resistance, enforcement

**P83-06's and P83-R2-07's fixes.**

**The legacy-vs-downgrade classification is withdrawn.** The second
revision claimed suite-1 rows before a per-sender ratchet point would
render as quiet legacy and later ones as flagged downgrades. The re-review
is right that no trusted write-time boundary exists: server `id`/`ts`/`seq`
are untrusted by §1, history arrives out of order by design, and
observation order is not creation order. The claim goes. What replaces it
is smaller and provable:

- **All suite-1 content is one class: unauthenticated.** A quiet mark, no
  attribution checkmark, ever — and **identically** in history, previews,
  search results and live pushes (the re-review's consistency demand).
  Suite-1 content never gains authenticated attribution under any
  circumstance; that property is preserved in full.
- **The enforcement flag**, `CHALK_MSG_SIG_REQUIRED` (the exact
  `CHALK_WRAP_SIG_REQUIRED` shape: config default + `--flag` + env parse +
  welcome field + one-way client latch + chalkctl generate/preserve per the
  `init.go` pattern), keeps both halves:
  - *Server-side:* `handleSend`, `handleEditMessage` and
    `handleSetReactions` reject suite-1 bodies — the leading byte after
    base64 decode is the suite; no content access needed. Old builds
    cannot re-seed unsigned traffic after the flip, on honest deployments.
  - *Client-side (the security boundary):* the latch is one-way per
    session, and under it **live** suite-1 arrivals are flagged hard — on
    a latched client they cannot be legitimate, because an honest server
    no longer accepts them. History rows stay in the uniform
    unauthenticated class; no claim is made about when they were written.
- The per-`(channel, sender)` "seen signing" memo survives **only as UI
  copy input** ("this member's messages are normally signed"), explicitly
  not a security classification and never a rejection rule.
- Defaults **off** through the migration; a later slice flips the default
  to **on** once released builds all sign (the 82-10 precedent, including
  `chalkctl update` preserving an explicit operator choice).
- **Readiness** (pattern 82-9): `chalkctl msgsig status` reports the share
  of recent messages at suite 2 per channel by the leading suite byte —
  content-free. `enable` refuses while active senders still produce
  suite 1 (`--force` overrides and says so); `disable` exists for the same
  reason `wrapsig disable` does. Migration in one line: ship it, let
  clients upgrade, wait for READY, `chalkctl msgsig enable`.

**The threat-model staging table** — which claim moves at which point, and
*only* then:

| Ships | `threat-model.md` movement |
|---|---|
| 83-1 … 83-2 (helpers, policy) | Nothing. Helpers are not guarantees. |
| 83-3 … 83-5 (objects signed end-to-end, enforcement off) | Sender-authenticity gains a "phase 83 partially deployed" paragraph; **status stays NOT met**. |
| 83-6 (enforcement) | Sender authenticity becomes **conditionally met** — user-authorship and relocation, where `CHALK_MSG_SIG_REQUIRED` is on, with §1's non-goals stated. Never unconditional. |
| Half B complete + enforced | The membership paragraph moves — **closed in dictator-mode channels; conditional in democratic-mode channels** (the tally exclusion, §7), each with its enforcement condition. Not before, and never on the strength of Half A. |

**Acceptance tests** (extended per the re-review's item 11), all as
hostile-server / hostile-member cases in `*.test.ts` against the real
verify path — and attacking with the *accepted* suite, not one the old
code rejects anyway (phase 82's hard lesson):

sender substitution (outer ≠ inner); signature forged by another key
holder; a held message re-presented under a new server id (dedup window);
LRU eviction never producing a replay claim; out-of-order history loading
producing **zero** warnings; re-dating skew surfaced; relocation across
channel, thread, parent and target; an older edit re-presented (stale by
chain rule); a multi-device edit fork (same `prev`, both valid — surfaced,
neither dropped); the same for reaction sets; a stale reaction set
re-presented; an attachment blob swapped under a signed digest; a reaction
clear forged without the actor's key; an edit targeting a legacy row
(unauthenticated-target mark); suite downgrade under a latched client;
`unpinned` never upgrading to `verified` without a pin; and for Half B:
concurrent transcript appends racing at one index; suppressed genesis on a
fresh recipient (fail closed, no legacy fallback); a democratic-outcome
event whose bound proposal record contradicts the witnessed lifecycle; a
unilateral event in democratic-mode replayed state (invalid, chain stops);
transcript fork at one index (both signed — proof); rollback below a held
head; an unserveable checkpoint suffix (stale, key ops frozen); a wrap
opening to a key that mismatches the epoch commitment.

## §7 — Half B: the authenticated channel-state transcript

**P83-03's and P83-R2-01/02/03/04's fixes.** Membership becomes a
hash-linked, signed event sequence replayed by every member; key handling
trusts the replayed state, not the roster. This revision corrects the
authority rules to match chalk's real authorization model, makes genesis
downgrade-safe, freezes every event's canonical contents, and structures
the checkpoints.

### The event chain

```
event     = { channel_id, index, prev_hash, type, actor_user_id,
              subjects[], details, sig }
canonical = utf8("chalk-chan-sig.v1") || u8(event_type)
            || lp(channel_id) || u64be(index) || lp(prev_hash)
            || lp(actor_user_id) || u32be(subject_count) || lp(subject)*
            || <details fields, per type, frozen below>
event_hash = SHA-256(canonical || lp(sig))
```

Types: `genesis`, `genesis_migration`, `add_member`, `remove_member`,
`self_leave`, `set_mode`, `key_epoch`, `guest_grant`, `guest_revoke`.

The server stores and relays events (one new table, `(channel_id, index)`
unique — concurrent appends race and the loser refetches and re-appends on
the new head; new fetch/append frames) and can forge none of them. What it
*can* do — fork, roll back, withhold — is what the client rules below
detect, **eventually**.

### Authority, per event type and per governance mode

Corrected against the actual product rules (each verified in the tree:
democratic mode hard-rejects unilateral adds and removes; self-leave is
`remove_member` on self, allowed in both modes, never proposal-gated, and
is the only leave path; the owner can never be removed or leave; rotation
is creator-only in SQL in both modes; guest invite mint/revoke is
owner-only; `dictator→democratic` is owner-unilateral while
`democratic→dictator` is proposal-only at supermajority):

| Event | dictator mode | democratic mode |
|---|---|---|
| `genesis` | creator | creator |
| `genesis_migration` | owner | owner |
| `add_member` | any current transcript member | governance-resolution form only |
| `remove_member` (actor ≠ subject) | owner (subject never the owner) | governance-resolution form only |
| `self_leave` (actor = subject) | the member; never the owner | same — never proposal-gated |
| `set_mode` → democratic | owner, unilateral | — |
| `set_mode` → dictator | — | governance-resolution form only |
| `key_epoch` | creator only | creator only |
| `guest_grant` / `guest_revoke` | owner only | owner only |

The verifier's authority check is **mode-dependent on the replayed
state**: a unilateral `add_member` in a channel whose replayed mode is
democratic is invalid and the chain stops there for every honest client —
the same fail-closed rule as an invalid wrap signature.

**The governance-resolution form, and the democratic exclusion.** chalk's
ballots are deliberately secret — per-voter votes are never broadcast, only
aggregates — and nothing in governance is client-signed. Any verifiable
quorum certificate would necessarily reveal at least the endorsing voters
to every transcript verifier, permanently. The decision (scuq, 2026-08-07):
**ballot secrecy wins; democratic tallies are excluded from the
cryptographic guarantee.** Concretely:

- A democratic outcome is enacted in the transcript by an event signed by
  the **enacting proposer** (or, if the proposer never returns, the owner,
  as a named fallback arm), whose `details` bind the full proposal record:
  proposal id, type, target, mode payload, frozen eligibility count, final
  yes/no/turnout, and the thresholds applied.
- What that signature proves: a named member enacted a specific, fully
  stated claimed outcome. What it does not prove: that the tally was
  honest. Every member witnessed the proposal lifecycle live
  (`governance_event` fan-out), so a fabricated outcome contradicts what
  voters saw — **detection, not prevention**, and the threat model says so
  (§6 staging table: C-01 closed in dictator channels, conditional in
  democratic ones).
- **Recorded future hardening:** signed ballots / quorum certificates,
  with the privacy cost named — endorsers become permanently visible in
  the channel transcript. If chalk ever wants cryptographic democracy, it
  buys it with ballot secrecy, and that trade belongs to a future phase.
- **Enactment lag is a feature, not a bug:** the server executes a passed
  proposal immediately (rows change), but the transcript event waits for
  the enacting client to sign it. Until it lands, replayed state and
  server roster disagree — and the reshare gate below therefore refuses to
  hand the key to a newly added member until the *authenticated* admission
  exists. The lag window is exactly the window in which the addition is
  not yet proven.

### Genesis: downgrade-safe by construction

The re-review's P83-R2-02 killed the second revision's "creator signs
genesis in the same client transaction" — impossible as written, because
the client never had the channel ID (the server mints it via
`gen_random_uuid()` and returns it in the ack), and an after-the-fact
genesis is suppressible: hide it from a fresh member and the channel
demotes to legacy, server-asserted membership. Chosen fix (the review's
option 1; option 2 — a pending channel activated only after the creator
appends genesis — rejected as a second round-trip plus a partial-failure
state machine for no additional guarantee):

- **The client mints the channel ID.** `create_channel` gains `channel_id`
  (a client-generated UUID) and `genesis` (the signed event). The
  `channels` table is a plain, unpartitioned UUID PK, so a client-supplied
  ID is enforceable; a collision is an insert error and the client
  re-mints. Genesis is bound to the channel **before the channel exists**;
  there is no genesis-less window to suppress.
- Since `genesis` commits to key version 1 (below), **the creator's client
  mints the space key at creation time** rather than lazily on first open
  — the commitment is a hash, so the key is held locally and the wraps are
  published after the ack exactly as today; `ensureChannelKeyInner`'s
  no-key-anywhere mint branch is superseded for transcript channels (its
  82-4 read-back guard remains).
- **DM idempotency**: the existing-DM short-circuit returns the existing
  channel; the submitted ID, genesis and freshly minted key are discarded
  — the existing channel keeps its own transcript state.
- **Old clients** omit both fields; the server mints the ID and the
  channel is **legacy**, inside the migration soft window. Once
  `CHALK_TRANSCRIPT_REQUIRED` (Half B's enforcement flag, same
  config → welcome → one-way-latch shape as the other two) is on, the
  server rejects creates without a genesis.
- **The transcript-adoption ratchet** (client, IndexedDB, the 82-5
  pattern): once a client holds a valid `genesis` or `genesis_migration`
  for a channel, it never again treats that channel as legacy — key
  adoption and auto-resharing run only off replayed state from then on,
  permanently. And on a transcript-required deployment, a channel with
  **no** held genesis gets **no key adoption and no resharing** —
  fail-closed `waiting`, never a legacy fallback.
- **Existing channels** migrate by an owner-signed `genesis_migration`
  asserting the roster as it stands, displayed to every member as an
  adoption: *"roster as asserted by \<owner\> on \<date\>"* — TOFU for
  membership, documented as such; guarantees begin at the migration event
  and retroactively prove nothing.
- **Channels that cannot migrate, scoped out explicitly:** the lobby
  channel (`created_by` NULL by design, no members, membership checks
  skipped) is permanently outside transcript scope. Orphaned channels
  (creator's account deleted; `created_by` went NULL and is never
  reassigned) cannot migrate — and cannot rotate keys today either, for
  the same reason; they stay legacy, and the honest recommendation is to
  recreate them. Both documented in the threat model when Half B's claims
  move.

### Canonical event contents, frozen (P83-R2-03)

Common rules: every variable field `lp()`-prefixed; member lists
count-prefixed, sorted by user-ID bytes, duplicates invalid; explicit
bounds on every list; absent optionals `lp("")`; `ed25519_fp` is the
SHA-256 of the raw 32-byte public key. `details` per type:

- `genesis`: creator `(user_id, ed25519_fp)`; initial members as
  `(user_id, ed25519_fp, role)` sorted; governance mode; channel type +
  is_dm; **key commitment** for version 1 (below).
- `genesis_migration`: asserted roster `(user_id, ed25519_fp, role)`
  sorted; mode; current key version + commitment; a prior-state marker
  (`legacy`).
- `add_member`: target `(user_id, ed25519_fp)`; role (always `member`);
  authorization arm — `unilateral` or the governance record above.
- `remove_member`: target `(user_id)`; authorization arm.
- `self_leave`: no details; actor = subject, enforced by the verifier.
- `set_mode`: old mode, new mode, authorization arm.
- `key_epoch`: key version; **key commitment**
  `SHA-256(utf8("chalk-key-commit.v1") || spaceKey)`; the membership head
  `(index, event_hash)` it was minted under; rotator = creator, enforced
  by the verifier.
- `guest_grant`: guest `(user_id, ed25519_fp)` — derivable by the owner at
  mint time, because the guest identity is a pure function of the link
  secret; owner fp; expiry; key version granted. `guest_revoke`: the
  grant's `(index, event_hash)`.

**Admission binds the admitted key.** The authorizer resolves the target's
Ed25519 key (pin, or fetch-then-pin) *at admission time* and signs its
fingerprint. Every member therefore converges on one admitted key; a later
different key for that user is the existing changed-pin flow, never a
silent re-resolution. This does not eliminate TOFU's first fetch — the
authorizer's own pin may have been poisoned at its first sight — it
prevents *divergent* resolution after the admission. Stated in both
directions.

**The key commitment closes the last substitution seam.** Without it the
transcript proves a version number and a roster while every actual key
still arrives by wrap. With it, on transcript channels `openWrap` gains a
final check: the unwrapped key's commitment must equal the current epoch's
(genesis's, for v1). A wrap that verifies but opens to a key the epoch
never authorized is refused regardless of its signature. Rotation ordering
follows from the head binding: a `key_epoch` minted under a membership
head that still contains a removed member is visibly pre-removal, and
clients refuse to wrap that epoch's key to anyone absent from the epoch's
bound membership.

**The state-transition function is part of the spec**: for each event
type, (replayed state × event) → new state or `invalid`, deterministic,
with `invalid` stopping the chain. 83-7 implements it as a pure function
with the event list as input — testable without a server.

### Checkpoints: fork, rollback, staleness (P83-R2-04)

The envelope's chain reference is the structured checkpoint
`(chain_index, chain_hash)` — a bare hash cannot express "different at the
same index" or "names an event the server will not serve". Receiver state
machine, comparing a peer's checkpoint `P` against the local verified head
`L` (both persisted per channel in IndexedDB):

| Comparison | Meaning | Action |
|---|---|---|
| `P.index == L.index && P.hash == L.hash` | agreement | none |
| `P.index < L.index` and `P.hash` matches our chain at that index | peer is older | none — old messages carry old heads |
| `P.index < L.index` and `P.hash` does **not** match our chain there | **fork proof** | permanent evidence; surface like the identity-changed wall; freeze key ops |
| `P.index > L.index` | peer is ahead | fetch the suffix `(L.index, P.index]`; verify; advance `L`. If the server cannot serve it → channel **stale** |
| `P.index == L.index && P.hash != L.hash` | **fork proof** | as above |
| No local transcript at all | unknown | legacy channel: ignore. Transcript-required: **stale** |

- **Rollback:** any served prefix ending below `L` is refused outright —
  `L` is monotonic.
- **Freeze rules:** *stale* or *forked* ⇒ no key adoption, no resharing;
  messaging continues under a banner (availability again does not fail
  closed; key material does).
- **Resume rules:** *stale* clears when the missing suffix arrives and
  verifies. A **proven fork never clears** — two validly signed events at
  one index is permanent cryptographic evidence of equivocation, kept and
  displayed, like a repudiated pin.
- **Detection is eventual, stated as such:** cross-attestation catches
  equivocation only when evidence from the separated views meets — via
  envelopes crossing the partition, or catch-up fetches. A server that
  partitions two members perfectly and forever is caught by neither; what
  it can no longer do is heal the partition without the fork becoming
  provable.

### Catch-up, multi-device, guests

- **Offline catch-up** is replay: fetch events past `L`, verify each
  (signature + prev-hash + mode-dependent authority + state transition),
  advance. Self-contained; nothing interactive.
- **Multi-device:** each device replays independently and keeps its own
  head; the chain is refetchable and verification deterministic, so honest
  devices converge by construction. (The phase-84 backup is deliberately
  unused here.)
- **Guests** do not verify the transcript in v1 — scoped out, documented.
  Their admission is authenticated *for members* via `guest_grant` /
  `guest_revoke`; their key access rides 82-7's fragment anchor; a guest
  trusts the member who handed it the link, which was already the guest
  trust model.

## §8 — Slices

**Gate 0 — independent protocol review of this third revision. Nothing
below starts before it passes.** Then, Half A first:

| Slice | Content |
|---|---|
| 83-1 | Export the canonical helpers from `spacekey.ts`; `chalk-msg-sig.v1` typed encoders for objTypes 1–3; sign (throws) and verify (total, typed result). Pure crypto, nothing produces it yet. Tests modelled on 82-1's. |
| 83-2 | Public trusted-signer accessor on `ChannelCrypto`; the verify policy copied from `openWrap` including the offline warm path; the dedup and revision-head stores (idb version bump). |
| 83-3 | The `onSend` reorder; message envelope (`0x01`); `CURRENT_MSG_SUITE = 2` + `describeSuites()` arm; plain sends signed and verified end to end, enforcement off. |
| 83-4 | Edits (`0x02`: content-identity targets, revision chains, re-stated attachment bindings, the `message_edited` editor-ID wire field) and reactions (`0x03`: chained sets, the sealed signed clear, deletion of the server's skip-the-checks branches). |
| 83-5 | Attachment digest verification on every fetch path; guest signing in `GuestRoom.tsx`; `ThreadInboxEntry` head/last-reply IDs and preview assurance marks. |
| 83-6 | Assurance UI (§3's five results on the `MemberTrust` vocabulary; uniform suite-1 rendering); `CHALK_MSG_SIG_REQUIRED` end to end; `chalkctl msgsig status/enable/disable`. Threat model moves per §6's staging table. |
| 83-7 … | Half B, its own slice run once Gate 0 has covered §7: the state-transition function (pure, event-list-in); event table + fetch/append frames; `create_channel` wire change (client-minted ID + genesis, creation-time key mint); client replay/verify + checkpoint heads; envelope checkpoint production and cross-attestation; the reshare/adoption gate + transcript-adoption ratchet; `genesis_migration` rollout; `CHALK_TRANSCRIPT_REQUIRED`. Each slice names its threat-model movement. |

## Before this ships

Gate 0 sits before code, not before release — two paper reviews have each
caught blocking protocol errors, which is the cheapest possible place to
catch them. Phase 81 gave the standing reason: a signature verified
inconsistently, or a transcript that does not actually bind membership,
produces the *appearance* of the guarantee, which is worse than the
current state, where `threat-model.md` says plainly that neither guarantee
is met.

`docs/threat-model.md` moves per §6's staging table and at no other time —
and when Half B's membership claim moves, it moves **split**: closed in
dictator-mode channels, conditional in democratic-mode channels (the tally
exclusion), each under its enforcement flag.

Phase 88 (federation, declined) treats this phase as a hard prerequisite;
if federation is ever reconsidered it is gated on **both** halves,
enforced, not on Half A.

# Phase 83 — signed message envelopes and an authenticated channel-state transcript

The two cryptographic findings phase 81 confirmed and deliberately deferred,
and the one the 2026-08-05 audit follow-up put at the top of its
remaining-work list. **NOT IMPLEMENTED — no code exists.** This document is
the plan and nothing below it has been built.

**Status:** design, second revision. The first revision (6 August 2026) was
sent for independent review and came back 7 August 2026 with six findings,
P83-01 … P83-06, and the verdict *"accept as an exploratory design record,
request major revision before accepting it as the plan that closes C-01 and
H-01."* This revision is that rework. It is intended to be
**decision-complete**: the signed field sets, the construction, the replay
model, the identity semantics, the per-object protocols, the transcript
protocol and the migration behaviour are all settled below, and the rejected
alternatives are recorded next to each decision.

**Gate 0: nothing in the slice table may start until this revision passes a
second independent protocol review.** The reviewer was explicit that the
canonical encoder (83-1) must not be implemented before its signed field set
and surrounding protocol are final. That is the standing order.

**Tag:** `#msgsig` → `tools/where.sh -g msgsig` (which today finds this plan
and the documents that point at it, and no code, because none exists).

**Depends on phase 82.** The expensive half of both findings — an identity
anchor a signature can be checked against — was already paid for there:
`web/src/crypto/trust.ts` pins peer Ed25519 keys, and `channel-crypto.ts`
already verifies-then-decrypts against a pinned signer. This phase spends
that anchor twice more.

---

## The review, and where each finding is answered

The 2026-08-07 review is not in the repo (like the phase-81 audits, it
arrived from outside; this doc is the record). Its findings, and the section
of this revision that resolves each:

| Finding | Was | Resolved in |
|---|---|---|
| P83-01 | Option A claimed to close H-01 but left re-dating, reordering and replay open | §1 (staged claims), §4 (replay model) |
| P83-02 | Format was circular: signature inside the plaintext *and* a ciphertext hash inside the signed envelope | §3 (sign-then-encrypt, no ciphertext hash) |
| P83-03 | Half B deferred its central security decisions | §7 (decision-complete transcript) |
| P83-04 | Envelope claimed a device the per-user identity cannot prove | §2 (user-only authorship) |
| P83-05 | Edits/reactions/attachments given message semantics implicitly; send flow contradicts the inventory | §5 (typed protocols, flow reorder) |
| P83-06 | Migration, downgrade resistance and acceptance criteria incomplete | §6 (ratchet, enforcement, staging table) |

---

## The two problems (unchanged from the first revision)

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

The review's first requirement: say precisely what is guaranteed, what is
merely detectable, and what is out of scope — and never let a slice claim
more than its half delivers.

**Guaranteed, once enforcement is on (§6):**

- **User-level authorship.** A message, edit, reaction set or attachment
  binding verifiably originates from the user it names, where "verifiably"
  means: checked against *this client's* pinned or manually-verified belief
  about that user's Ed25519 identity key (`trust.ts`). No other key holder —
  member or server — can produce an object that verifies as that user.
- **Relocation resistance.** A signed object cannot be presented in a
  different channel, against a different target message, at a different key
  version, or (for wraps of context like parent/thread) under a parent the
  sender did not name. Every one of those is inside the signature.

**Detectable, not prevented:**

- **Replay and duplication** of a genuine object, within the history a
  client holds, via the per-writer counter and `client_msg_id` rules of §4.
- **Re-dating.** The envelope carries the sender's own clock (`sender_ts`);
  the server's timestamp is demoted to *receipt metadata*. A server that
  re-dates a message produces a visible skew between the two, not a silent
  rewrite of history.
- **Stale or forked channel state**, once Half B ships, via the
  `chain_head` cross-attestation of §7.

**Explicit non-goals — stated so nobody rounds up:**

- **Server-minted `id`, `ts` and `seq` are untrusted receipt metadata.**
  They order storage, drive paging and partitioning, and nothing more. The
  UI's authenticated notion of "when" is `sender_ts`; the authenticated
  notion of "which message" is the signed `(sender, writer_scope,
  client_msg_id)` triple. This is the review's sanctioned disposition for
  the fields a send-time signature cannot cover, and it is a *narrowing* of
  the first revision's claim: H-01's authorship and relocation portions
  close; its server-ordering portion is documented open and partly
  compensated by detection.
- **Completeness.** A server can still withhold messages or events. Half B
  bounds this for channel state (§7); for messages it remains open.
- **Denial of service.** A server can refuse to relay anything. Out of
  scope, as everywhere else in the threat model.
- **TOFU first-fetch.** Unchanged from phase 82: a server that lies from
  the very first identity fetch gets its key pinned, and only the
  out-of-band picture-word comparison detects it. Signatures verify against
  the pin, so they inherit exactly that limit — no better, no worse.
- **Device attribution.** See §2. The guarantee is scoped to the user.
- **Forward secrecy / post-quantum.** Unchanged non-goals of the whole
  design.

**A fresh device (or cleared local state) starts with no replay watermarks
and no pins beyond what the phase-84 backup restores.** Its detection
guarantees begin at zero and grow. Stated as a limitation, not hidden.

## §2 — Identity: user-only authorship, on the anchor we already have

**P83-04's fix: the signed sender is the user, and only the user.**

chalk's identity is per-user by design (`migrations/0031_identity_keys.sql`
says so in its header): every device signed into an account derives the same
X25519/Ed25519 pair from the same phrase. A device ID is a random UUID in
localStorage (`web/src/ws-client.ts`) with no key material behind it. A
signature made with the identity key therefore proves *the user*, and a
"device" field inside it would be an unverifiable claim wearing a signed
costume — exactly what this phase exists to eliminate.

So the envelope names `sender_user_id` and, separately, a `writer_scope` —
an opaque UUID whose **only** role is to namespace the replay counter of §4.
The doc, the code comments and the UI must all describe `writer_scope` as an
unauthenticated label. It is never rendered as "sent from device X".

**Rejected: per-device signing subkeys** certified by the user identity.
It is the only way to true device attribution, and it is a whole new
sub-protocol — certificate format, revocation, per-device storage,
cross-device sync — with no existing machinery behind it and no product
requirement asking for it. If a need appears, it layers on top of this
design without changing the envelope (a certified subkey signs the same
canonical bytes).

**The verification anchor is `trust.ts`, unchanged.** This was the standing
question — *can the existing obtained/verified identity mechanisms be
reused?* — and the answer is yes, wholesale:

- `resolveSigner` answers "whose key is this?" from local pins only, and is
  the *only* resolver allowed on unattended paths (history decrypt, preview
  warm-up), exactly as `openWrap` uses it.
- `fetchTrustedIdentity` is the network path that TOFU-pins on first sight,
  allowed only where `openWrap` allows it today: interactive paths.
- `markManuallyVerified` (the picture-word flow) upgrades the same pin, and
  a `changed` pin repudiates it — a sender whose pin is `changed` renders
  as unverifiable until the user re-verifies, same as the members panel.
- The phase-84 pin backup carries all of it across devices, so a restored
  device verifies history with the pins it had, not a fresh TOFU pass.

Message assurance therefore maps onto the existing `MemberTrust` vocabulary
(verified / recognised / unverified / changed) rather than inventing a
parallel one. §6 gives the rendering.

**Key rotation.** Not implemented today — nothing sets
`identity_keys.retired_at`. Verification is against the *pinned* key, full
stop. When rotation is eventually built, it inherits a constraint recorded
here: old signatures must remain verifiable against a verified historical
key or a signed transition record, never silently re-checked against the
current key. That design belongs to the rotation phase; this phase only
forbids it from breaking history.

## §3 — Construction: sign-then-encrypt, and nothing circular

**P83-02's fix.** The first revision said the signature lives inside the
plaintext *and* that the signed envelope contains a ciphertext hash. Those
cannot both be true. The resolution is the review's construction (1),
chosen and fully specified:

**Sign a canonical plaintext object; encrypt the object and its signature
together.** There is no ciphertext hash anywhere. The two layers divide the
work cleanly:

- The **AEAD** (AAD = `chalk-msg-s{suite}:{channelID}:{keyVersion}`)
  authenticates the ciphertext and binds it to channel and key version, as
  today.
- The **inner Ed25519 signature** authenticates every sender-meaningful
  field, including channel and key version *again* (so the signature is
  self-contained even if a future suite changes the AAD).

The server never sees the signature and cannot strip it without breaking
the AEAD. Precedents in the repo: phase 82 put the wrap signature inside
the opaque `wrap_blob`; `signal-crypto.ts` puts `fp_sig` inside the sealed
`SdpSignal`. No schema change; `messages.meta` stays unused.

### The wire format, frozen

`CURRENT_MSG_SUITE` goes 1 → 2. A suite-2 message body is, as today,
`suite(1) || nonce(12) || ct || tag(16)`; what changes is the plaintext.
Suite-1 plaintext was the bare body text. **Suite-2 plaintext is UTF-8
JSON:**

```
{ "e": { ...typed envelope fields... }, "sig": "<base64 Ed25519 signature>" }
```

JSON is the transport shape only. **The signature is never computed over
JSON.** The verifier rebuilds the canonical byte string below from the
parsed fields and verifies against that — the same
rebuild-locally-never-trust-transport rule as `verifyFingerprints` and
`canonicalWrapMessage`.

### The canonical encoding, frozen

One domain, one type byte per object class, everything length-prefixed:

```
lp(x)     = u32be(len(x)) || x
canonical = utf8("chalk-msg-sig.v1") || u8(objType) || <fields per class, §5>
```

- Domain string `chalk-msg-sig.v1`, sibling of `chalk-wrap-sig.v1` and
  `chalk-voice-fp.v1`.
- `objType`: `0x01` message, `0x02` edit, `0x03` reaction set. (Attachment
  bindings ride *inside* types 1 and 2 — an attachment has no independent
  signed object; see §5.) Half B's transcript events use their own domain
  (`chalk-chan-sig.v1`, §7), not an objType here.
- Every variable-length field is `lp()`-prefixed; fixed-width integers are
  written as fixed-width big-endian. This is the injective form phase 82
  chose, **not** `signal-crypto.ts`'s newline join, because envelope fields
  carry binary (digests) and arbitrary text.
- Lists are encoded as `u32be(count)` followed by each element's encoding —
  count-prefixed so adjacent lists cannot bleed into each other.
- Absent optional fields encode as `lp("")`. Present-but-empty and absent
  are deliberately identical: the semantic is "no value".
- 83-1 **exports** the existing private helpers from `spacekey.ts`
  (`writeU32BE`, `lengthPrefixed`, `concat`, `bytesEqual`, `utf8`) and both
  `canonicalWrapMessage` and the new encoders use them. Two canonical
  encoders that drift apart is the failure mode this phase exists to avoid.

### Sign and verify behaviour, frozen

Copied from the repo's established asymmetry (`signFingerprints` /
`verifyFingerprints`, `wrapSpaceKeySigned` / `unwrapSpaceKeySigned`):

- **Signing throws** on degenerate input — empty channel, malformed field,
  out-of-range counter. Programmer errors, not attacker input.
- **Verification never throws** and returns a typed result on every path.
  It is attacker-reachable and must be total.

A verifier's result is one of:

| Result | Meaning |
|---|---|
| `verified` | Signature valid against the pinned/verified key for the signed sender, and every server-supplied outer field matches its signed inner counterpart |
| `mismatch` | Signature valid, but an outer field (sender, parent, thread, target…) disagrees with the signed value — the server's framing of this object is forged, the inner values are authoritative |
| `forged` | Signature invalid against our belief about the signed sender's key |
| `unpinned` | No local pin for the signed sender and the path may not fetch — decided later, not trusted now |
| `unsigned` | Suite-1 object (legacy, or downgrade — §6 decides which) |

**On `mismatch`, the signed inner fields win, always** — the UI displays
the sender, parent, thread and time the *signature* attests, flags the
disagreement, and never renders the server's version as fact.

**Content is displayed even when attribution fails** (`forged`,
`mismatch`, ratchet-flagged `unsigned`), under an unmistakable warning.
Rationale: only channel-key holders can produce decryptable content at all,
so hiding it outright would let a hostile server (or member) suppress
messages by corrupting their envelopes — a censorship lever this design
must not hand out. Attribution fails closed; availability does not.

## §4 — Replay and ordering: what the counter buys, exactly

**The rest of P83-01.** The server mints `id`, `ts` and `seq`
(`handleSend`: `uuid.New()`, `INSERT … RETURNING ts`, `channel_seq`), so a
send-time signature cannot cover them, and `client_msg_id` is never
persisted server-side (wire, ack and pubsub only — confirmed in
`proto.go`'s own comments). Durable replay protection therefore lives in
**client state**, specified here.

### Sender side

Every plain message envelope carries:

- `client_msg_id` — a fresh UUID, minted **before** anything else in the
  send flow (§5 reorders `onSend` accordingly).
- `sender_ts` — the sender's clock, unix millis. The authenticated "when".
- `writer_scope` — the opaque counter namespace from §2.
- `wseq` — a strictly-increasing counter per `(channel, writer_scope)`,
  persisted in IndexedDB on the sending device.

**A scope whose counter you do not hold is never reused.** If the IDB
counter store is lost (cleared storage, new browser profile) while the
localStorage device ID survives, the client mints a **new** `writer_scope`
rather than restarting an existing one at 1 — a counter regression from a
genuine writer would be indistinguishable from a replay, so the rule makes
it impossible to produce one honestly. Scopes are cheap; watermarks attach
to the scope.

### Receiver side

A new, small, bounded IndexedDB store (the phase-84 "optional fields, no
DB_VERSION bump" trick does not apply — this is a new store, so `idb.ts`
takes its first version bump since v4; mechanical):

- Per `(channel, sender_user_id, writer_scope)`: the high-watermark `wseq`
  seen, plus a bounded window of recent `(wseq → server_id,
  client_msg_id)` entries (size cap, LRU by wseq; the cap is a constant
  with a comment, not a knob).

Rules, in order, applied on decrypt of a suite-2 message:

1. **Same signed identity, different server row** — the signed
   `(sender, writer_scope, client_msg_id)` triple already seen under a
   different server `id`: this is the same message presented twice. The
   second presentation is dropped as a duplicate and the event is flagged
   (it is either a server replay or a resend race; either way it is not a
   second message).
2. **Counter regression** — `wseq` at or below the watermark, and not in
   the recent window as this exact message: flagged as a replay of
   something this client no longer holds. Flag, not drop — the client
   cannot prove it never held it (scrollback paging means holes are
   normal).
3. **Gaps are tolerated silently.** The user's other devices consume the
   same scope-space independently, and unheld history means missing
   ranges. A gap is not evidence of anything.

**What this buys, honestly:** duplicates of held messages are eliminated;
replays into held history are flagged; re-dating is visible as
`sender_ts` / server-`ts` skew (surfaced in the message's info affordance
when it exceeds a threshold, not hidden). **What it does not buy:** a
fresh device auditing history it never held, or detection of wholesale
withholding. Both stated in §1.

### Rejected: Option B, the client-minted message ID

The first revision kept it as a follow-on; the rework kills it with the
reason found in the schema: `messages` is partitioned by range on `ts` with
primary key `(ts, id)`, and Postgres requires unique indexes on a
partitioned table to include the partition key — so **global uniqueness of
a client-supplied ID is not enforceable** without redesigning the
partitioning, and without enforced uniqueness a hostile client gets an
equivocation primitive (two rows, one signed identity) for free.
`client_msg_id` inside the signature plus rule 1 above delivers the
detection half of Option B's value at none of its schema cost. If the
partitioning is ever redesigned, revisit; not before.

## §5 — Typed object protocols, and the send flow that makes them possible

**P83-05's fix.** One envelope per object class, each with its own
`objType`, its own field list, and its own flow notes. A generic "context
parameter on the seven `ChannelCrypto` wrappers" is *how the code will
thread it*, but the protocol is defined per class here, and message
semantics are applied to nothing else — voice signals (already signed under
`chalk-voice-fp.v1`), prefs blobs, the parking lot, and link previews
(embedded in the body before encryption, so covered by the message
envelope) keep their existing shapes.

### The send-flow reorder (prerequisite for everything below)

Today `onSend` runs *encrypt → upload attachments → mint `client_msg_id` →
send*, which makes the envelope impossible: the identity and the attachment
results must exist before signing. New order:

```
mint client_msg_id
→ upload attachments (ids + ciphertext digests come back)
→ build envelope (all fields known) → sign → encrypt → send
```

The optimistic append moves with the mint; nothing else about optimistic
rendering changes. Guest sends in `GuestRoom.tsx` get the same order.

### `0x01` — message

Canonical fields, in order:

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(writer_scope) || lp(client_msg_id) || u64be(sender_ts)
|| u64be(wseq) || lp(parent_id)            // lp("") when not a reply
|| lp(chain_head)                          // lp("") until Half B; §7
|| lp(utf8(body_text))
|| u32be(att_count) || att_binding*        // see below
```

Each `att_binding`:

```
lp(attachment_id) || u32be(att_key_version) || u64be(byte_len)
|| lp(sha256(full_ciphertext)) || lp(sha256(enc_meta))
|| lp(sha256(enc_preview))                 // lp("") when no preview
```

- `parent_id` is what the *sender* names; the server's derived `thread_id`
  is receipt metadata, checked against the signed parent on display
  (`mismatch` if the server moved the message to a thread the sender did
  not reply into).
- Attachment digests are computed over the *ciphertexts*, which exist
  before the message is built (blobs are encrypted before `initUpload`;
  the ids arrive with the upload; both precede the envelope under the new
  order). No upload reorder is needed. Receivers verify every fetched or
  inline blob (`full`, `enc_meta`, `enc_preview`) against the signed
  digest before decrypting it; a mismatch renders the attachment as
  tampered, not as content. An attachment ref the server presents that is
  not covered by its parent's envelope renders unauthenticated.
- `att_key_version` is per attachment because the upload pins its own key
  version, which can lag the message's if a rotation lands between them.

### `0x02` — edit

An edit **replaces the row's body**, envelope and all (`UPDATE messages SET
body = …`), so the edit envelope must be self-sufficient — it is the only
authenticated content the row will ever have again. Fields:

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(target_id) || u64be(target_ts)       // the row being edited
|| u64be(edit_seq)                         // 1, 2, 3… per target
|| u64be(sender_ts) || lp(chain_head)
|| lp(utf8(body_text))
|| u32be(att_count) || att_binding*        // re-stated from the original
```

- `edit_seq` is a per-target monotonic revision counter. Only the original
  sender may edit (server-enforced today, and the signature now enforces
  it cryptographically: the envelope's `sender_user_id` must be the
  target's signed sender), so sender-local IDB state suffices to mint it.
  Receivers keep the highest `edit_seq` seen per target and refuse
  anything at or below it — **the server can no longer replay an older
  valid edit over a newer one**, which the bare `edited_at` timestamp
  never prevented (migration 0044 chose overwrite-no-revisions; that
  stands — the counter lives in the envelope, not in a revision table).
- Attachment bindings are re-stated verbatim from the original message
  envelope, because the original envelope is destroyed by the UPDATE and
  the attachments must not become unauthenticated by editing a caption.
- Wire gap closed in the same slice: `message_edited` gains the editor's
  user ID so clients can render attribution before decrypt completes. The
  authenticated value remains the inner field; the wire field is display
  convenience, checked like any other outer field.

### `0x03` — reaction set

Reactions are whole-set replacement per `(message, reactor)`. Fields:

```
lp(channel_id) || u32be(key_version) || lp(actor_user_id)
|| lp(target_id) || u64be(target_ts)
|| u64be(rx_seq)                           // per (actor, target) counter
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*        // zero-count = cleared
```

- `rx_seq` orders successive replacements so the server cannot re-present
  a stale set as current; receivers keep the highest per `(actor,
  target)`.
- **Clearing becomes a signed, sealed empty set.** The current protocol's
  bare `body: ""` — which skips the key-version requirement *and* the
  ceiling check server-side, and produces an unauthenticated,
  unencrypted "user X has no reactions on Y" push — is retired. A clear
  is `emoji_count = 0`, sealed and signed like any other set; the server
  stores and pushes it as a normal value and its skip-the-checks branches
  are deleted. (The server may still garbage-collect rows whose set is
  empty *after* clients have consumed them; that is storage hygiene, not
  protocol.)
- Any member may react (unchanged); the signature binds the actor, so the
  server can no longer attribute a reaction to someone who never made it.

### Guests

Guests already derive a full Ed25519 identity from the link secret and can
sign (`GuestRoom.tsx` holds a `DerivedIdentity`); guest identities are
served by `fetch_identity` since 80-9. So guests sign messages exactly as
members do, and members verify a guest like any peer: resolve, TOFU-pin,
verify. In the other direction a guest verifies members best-effort with
in-session TOFU pins (a guest has no durable pin store and no phase-84
backup); stated as the guest-path limitation. Links minted before 82-7
remain unsigned-wrap territory until expiry — unchanged, and out of this
phase's scope.

### Previews (thread inbox, search, channel summaries)

A preview renders outer `sender` and `ts` beside decrypted text. Until the
underlying row is verified, those are receipt metadata, and the preview
carries the same assurance mark as a full row would (§6) — a preview must
never look *more* trustworthy than the message it previews. Wire gap closed
so previews are verifiable at all: `ThreadInboxEntry` gains the head and
last-reply **message IDs** (the server already holds
`thread_activity.last_reply_id`; it just never sent it), so the preview's
decrypt can locate its replay-state row and its envelope's target checks.

## §6 — Migration, downgrade resistance, enforcement

**P83-06's fix.** Four mechanisms, each with its precedent in phase 82:

**1. The per-sender downgrade ratchet** (pattern: 82-5's per-channel key
ratchet). Once this client has *verified* a signed message from a sender in
a channel, a later **unsigned** (suite-1) message attributed to that sender
in that channel is flagged as a downgrade — the server cannot forge a
signature, so "this sender signs, and now suddenly doesn't" is exactly the
attack surface. Per-`(channel, sender)`, persisted in IndexedDB, latched:
it survives reconnects, and a welcome frame cannot un-latch it (the flag
arrives over the channel the policy distrusts — same one-way-latch
reasoning as `setWrapSigRequired`). Per-sender rather than per-channel so
one member on an old build does not condemn the whole channel's traffic,
and so the flag lands on the forged sender, not on bystanders.

**2. Legacy history.** Suite-1 rows written before the sender's ratchet
point render as *legacy* — "attribution asserted by server, not verified" —
in quiet styling, not an alarm. They are never re-signed (nobody can sign
for the past honestly) and never granted the verified mark. Distinguishing
legacy from downgrade is precisely what the ratchet's per-sender watermark
is for.

**3. The enforcement flag,** `CHALK_MSG_SIG_REQUIRED` (pattern: 82-3/82-10,
the exact `CHALK_WRAP_SIG_REQUIRED` shape — config default, `--flag`, env
parse, welcome field, one-way client latch, chalkctl generate/preserve per
the `init.go` pattern). Two halves:

- *Server-side:* `handleSend` (and `handleEditMessage`,
  `handleSetReactions`) reject suite-1 bodies — the body's leading byte
  after base64 decode is the suite, so this needs no content access. Stops
  old builds re-seeding unsigned traffic after the flip, on honest
  deployments.
- *Client-side (the security boundary):* new suite-1 live messages render
  flagged regardless of ratchet state.

Defaults **off** through the migration; a later slice flips the default to
**on** once released builds all sign (the 82-10 precedent, including
`chalkctl update` preserving an explicit operator choice).

**4. Readiness and the operator story** (pattern: 82-9). `chalkctl msgsig
status` reports the share of recent messages at suite 2, per channel, by
reading that leading suite byte — content-free. `enable` refuses while
active senders are still producing suite 1 (`--force` overrides and says
so); `disable` exists for the same reason `wrapsig disable` does. Migration
in one line: ship it, let clients upgrade, wait for READY, `chalkctl msgsig
enable`.

**The threat-model staging table** — which claim moves at which point,
and *only* then:

| Ships | `threat-model.md` movement |
|---|---|
| 83-1 … 83-2 (helpers, policy) | Nothing. Helpers are not guarantees. |
| 83-3 … 83-5 (objects signed end-to-end, enforcement off) | Sender-authenticity section gains a "phase 83 partially deployed" paragraph; **status stays NOT met** (unsigned messages still accepted silently pre-ratchet). |
| 83-6 (ratchet + flag) | Sender authenticity becomes **conditionally met** — met for user-authorship and relocation where `CHALK_MSG_SIG_REQUIRED` is on, with §1's non-goals stated; the C-01 wording is the model. Never "met" unconditionally. |
| Half B complete + enforced | The membership paragraph moves, with its own condition. Not before, and never on the strength of Half A. |

**Acceptance tests** (the review's item 8), all as hostile-server /
hostile-member cases in `*.test.ts` against the real verify path (phase
82's hard lesson: a security test that passes against reverted defences is
not evidence — attack with the *accepted* suite, not one the old code
rejects anyway):

sender substitution (outer ≠ inner); signature forged by another key
holder; replay of a held message under a new server id; replay under a new
timestamp; relocation across channel, thread, parent and target; an older
valid edit replayed over a newer one; a stale reaction set re-presented;
an attachment blob swapped under a signed digest; a reaction clear forged
without the actor's key; suite downgrade against a ratcheted sender;
`unpinned` path never upgrading to `verified` without a pin; and, for Half
B: transcript fork (two prefixes at one index), rollback below a held
head, a withheld removal detected via `chain_head`, and a wrap candidate
list that disagrees with replayed state.

## §7 — Half B: the authenticated channel-state transcript

**P83-03's fix: every open question closed.** The shape is unchanged —
membership becomes a hash-linked, signed event sequence replayed by every
member, and key handling trusts the replayed state, not the roster — but
"the open questions to answer before slicing" are now answered *here*.

### The event chain

Per-channel, append-only, hash-linked:

```
event     = { channel_id, index, prev_hash, type, actor_user_id,
              subjects[], details, sig }
canonical = utf8("chalk-chan-sig.v1") || u8(event_type)
            || lp(channel_id) || u64be(index) || lp(prev_hash)
            || lp(actor_user_id) || u32be(subject_count) || lp(subject)*
            || lp(details_canonical)        // per-type, lp()-encoded
event_hash = SHA-256(canonical || lp(sig))
```

Types: `genesis`, `genesis_migration`, `add_member`, `remove_member`,
`set_mode`, `key_epoch`, `guest_grant`, `guest_revoke`.

The server stores and relays events (one new table, `(channel_id, index)`
unique; new fetch/append frames) and can forge none of them. What it *can*
do — fork, roll back, withhold — is exactly what the client rules below
detect.

### Genesis, and the migration of existing channels

- **New channels:** the creator signs `genesis` naming itself and the
  initial members, in the same client transaction as channel creation. A
  channel without a genesis is a legacy channel, full stop.
- **Existing channels:** the owner (`created_by` — chalk's only privileged
  role; roles are owner/member and effectively immutable) signs a
  `genesis_migration` asserting the roster as it stands. Clients record
  and display the adoption: *"roster as asserted by \<owner\> on
  \<date\>"*. This is TOFU for membership and is documented as such — the
  transcript's guarantees begin at the migration event and cover
  everything after; they retroactively prove nothing. A server that
  injected a principal *before* migration keeps it. The join notice and
  the members panel already give users the tools to eyeball the adopted
  roster at that moment, which is the honest best available.

### Authority, per event type

Mirrors the server's *current* authorization, now cryptographically held:

| Event | Valid signer |
|---|---|
| `genesis` | channel creator |
| `genesis_migration` | owner |
| `add_member` | any current transcript member (matches `handleAddMember` today) |
| `remove_member`, `set_mode` | owner — or, in governance mode, the resolution path below |
| `key_epoch` | the member performing the rotation |
| `guest_grant`, `guest_revoke` | the link minter (any member, matching today), binding the link's owner Ed25519 key and expiry — composing with 82-7's fragment anchor |

**Governance residual, stated:** proposals are tallied server-side, and
votes are not signed. In governance mode the `remove_member` /
`set_mode` event is signed by the **proposer** of the resolved proposal
and its `details` name the proposal; the transcript therefore
authenticates *that a member enacted the outcome*, not the tally itself.
Authenticated voting is future hardening, recorded as such, not claimed.
(A server that lies about a tally to a proposer gets an event honest
members can see and dispute — visible, like 82-8's join notice, which is
strictly better than today's nothing, and honestly less than a proof.)

An event signed by an actor the replayed state does not authorize for that
type is invalid, and the chain stops there for every honest client — the
same fail-closed rule as an invalid wrap signature.

### Fork, rollback and equivocation detection

- **Rollback:** every client persists, per channel, the highest verified
  `(index, event_hash)` head in IndexedDB and refuses any served prefix
  that ends below it.
- **Fork / equivocation** — the reason `chain_head` sits in every Half A
  envelope from day one: each signed message carries the hash of the
  sender's current verified head. Members cross-attest the transcript
  continuously just by chatting. Two verified messages carrying different
  heads at the same index is cryptographic proof of a fork, surfaced
  loudly (the identity-changed wall is the UI precedent). Until Half B
  ships, senders put `lp("")` there and receivers ignore it — the field
  costs four bytes and buys the coupling that makes the halves one phase.
- **Withholding / staleness:** unpreventable, so bounded: a peer's
  `chain_head` referencing an index the server will not serve marks the
  channel *stale* — warn, and freeze key operations (below). An offline
  client is stale by construction until it catches up; staleness is a
  state, not an accusation.

### Ordering: removals, rotations, and the reshare gate

- A `key_epoch` event's `details` bind the membership index it was minted
  under. A removal followed by a rotation is therefore provably ordered: a
  key epoch minted at an index that still contains the removed member is
  visibly pre-removal, and clients refuse to wrap the *new* epoch's key to
  anyone absent from the epoch's bound membership.
- **The gate, which is the point of the whole exercise:** `openWrap`'s
  candidate list and `rewrapForMissing`'s recipient list come from the
  **replayed transcript state**, not the server's roster. On disagreement:
  the UI shows the server's roster with a mismatch banner (visibility,
  the 82-8 pattern), but **no key is ever wrapped to a principal the
  transcript does not contain**, and resharing freezes entirely while the
  channel is forked or stale. A server that injects a principal now gets
  a banner and no key, instead of a key.

### Catch-up, multi-device, guests

- **Offline catch-up** is replay: fetch events past the local head, verify
  each (signature + prev-hash + authority), advance the head. Verification
  is self-contained, so there is nothing interactive about it.
- **Multi-device:** each device replays independently and keeps its own
  head. No sync protocol — the chain is refetchable and verification is
  deterministic, so two honest devices converge by construction. (The
  phase-84 backup is unnecessary here; deliberately unused.)
- **Guests** do not verify the transcript in v1 — scoped out and
  documented. Their *admission* is authenticated for members via
  `guest_grant`/`guest_revoke`, and their key access continues to ride
  82-7's fragment anchor. A guest trusts the member who handed it the
  link; that was already the guest trust model.

## §8 — Slices

**Gate 0 — independent protocol review of this revision. Nothing below
starts before it passes.** Then, Half A first:

| Slice | Content |
|---|---|
| 83-1 | Export the canonical helpers from `spacekey.ts`; `chalk-msg-sig.v1` typed encoders for objTypes 1–3; sign (throws) and verify (total, typed result). Pure crypto, nothing produces it yet. Tests modelled on 82-1's, plus the §6 negative list where it applies to bare crypto. |
| 83-2 | Public trusted-signer accessor on `ChannelCrypto` (today `openWrap`/`identity` are private and nothing answers "the trusted Ed25519 key for user X"); the verify policy copied from `openWrap` including the offline warm path; the receiver replay/watermark store (idb version bump). |
| 83-3 | The `onSend` reorder; message envelope (`0x01`); `CURRENT_MSG_SUITE = 2` + `describeSuites()` arm (the `spacekey.test.ts` tooltip test exists); plain sends signed and verified end to end, enforcement off. |
| 83-4 | Edits (`0x02`, incl. re-stated attachment bindings and the `message_edited` editor-ID wire field) and reactions (`0x03`, incl. retiring the unencrypted clear and the server's skip-the-checks branches). |
| 83-5 | Attachment digest verification on every fetch path; guest signing in `GuestRoom.tsx`; `ThreadInboxEntry` head/last-reply IDs and preview assurance marks. |
| 83-6 | Assurance UI states (§3's five results, mapped onto the `MemberTrust` vocabulary); the per-sender ratchet; `CHALK_MSG_SIG_REQUIRED` end to end (config → welcome → latch → chalkctl env pattern); `chalkctl msgsig status/enable/disable`. Threat model moves per §6's staging table. |
| 83-7 … | Half B, in its own slice run once Gate 0 has covered §7: event table + frames; client replay/verify + heads; `chain_head` production and cross-attestation; the reshare gate; `genesis_migration` rollout. Each slice names its threat-model movement. |

## Before this ships

The independent review requirement is now **Gate 0**, before code, not
before release — the reviewer's position, adopted: a canonical encoder
implemented against an unsettled field set is exactly how a half-fix
ships. Phase 81 gave the standing reason: a signature verified
inconsistently, or a transcript that does not actually bind membership,
produces the *appearance* of the guarantee, which is worse than the
current state, where `threat-model.md` says plainly that neither guarantee
is met.

`docs/threat-model.md` moves per §6's staging table and at no other time.
Phase 88 (federation, declined) treats this phase as a hard prerequisite;
if federation is ever reconsidered it is gated on **both** halves,
enforced, not on Half A.

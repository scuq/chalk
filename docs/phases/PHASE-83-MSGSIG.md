# Phase 83 — signed message envelopes and an authenticated channel-state transcript

The two cryptographic findings phase 81 confirmed and deliberately deferred,
and the one the 2026-08-05 audit follow-up put at the top of its
remaining-work list. **NOT IMPLEMENTED — no code exists.** This document is
the plan and nothing below it has been built.

**Status: design, fourth revision.**

- First revision, 6 August 2026: exploratory design. Reviewed 7 August 2026;
  six findings, P83-01 … P83-06, verdict *"accept as an exploratory design
  record, request major revision."*
- Second revision (commit `9890571`): answered those six. Re-reviewed the
  same day: P83-02 and P83-04 resolved, the rest partial; **Gate 0 not
  passed**; seven new findings P83-R2-01 … R2-07.
- Third revision (commit `3d8a25f`): answered those seven. Third review, same
  day: R2-04, R2-05 and R2-07 **resolved**; **Gate 0 not passed**; five
  blocking findings P83-R3-01 … R3-05 plus one claim correction, R3-06.
- This fourth revision answers the third review. All review documents are
  external, like the phase-81 audits; this doc is the in-repo record.

**Gate 0: nothing in the slice table may start until this revision passes
independent protocol review.** Three paper reviews have each caught blocking
protocol errors before a line of code existed — the gate working exactly as
intended.

**Tag:** `#msgsig` → `tools/where.sh -g msgsig` (which today finds this plan
and the documents that point at it, and no code, because none exists).

**Depends on phase 82.** The expensive half of both findings — an identity
anchor a signature can be checked against — was already paid for there:
`web/src/crypto/trust.ts` pins peer Ed25519 keys, and `channel-crypto.ts`
already verifies-then-decrypts against a pinned signer. This phase spends
that anchor twice more, and (since this revision) extends phase 82's wrap
format once.

---

## Review dispositions

First review: P83-01 → §1/§4; P83-02 → §3 (resolved); P83-03 → §7;
P83-04 → §2 (resolved); P83-05 → §5; P83-06 → §6.

Re-review: R2-01 → §7 authority (partial → completed below);
R2-02 → §7 genesis (partial → completed below); R2-03 → §7 schema
(partial → completed below); R2-04 checkpoints (resolved);
R2-05 dedup (resolved); R2-06 → §5 (partial → completed below);
R2-07 uniform legacy (resolved).

Third review, all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-R3-01 (Critical) | A fresh recipient with no transcript and a suppressed welcome flag takes the legacy path — the wrap carried no transcript binding | §7 (wrap suite 3: epoch-bound wraps; migrated-channel residual stated) |
| P83-R3-02 (High) | Edits destroy the signed original a fresh reader needs; replies bind only the untrusted server row ID | §5 (server-retained revision ancestry; replies sign the parent's content identity + envelope hash) |
| P83-R3-03 (High) | A lone latest-hash cannot distinguish stale revisions from sibling forks; ancestry was unfetchable | §5 (revision DAG state + fetchable ancestry; full state machine; reactions explicitly narrowed instead) |
| P83-R3-04 (High) | No transition from membership event to usable key epoch; no post-removal send freeze | §7 (epoch lifecycle: active/frozen; additions without rotation; removal freezes sends until a post-removal epoch) |
| P83-R3-05 (High) | Event type tags, enums, subjects, variant tags and bounds left to implementation | §7 (the frozen byte-schema table; `subjects[]` deleted) |
| P83-R3-06 (Medium) | "Every member witnessed the lifecycle" overstates democratic detection | §7 (exact observation condition; persisted lifecycle records; accepted residual) |

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
  or under a parent whose signed content identity the sender did not name.
- **Membership integrity in dictator-mode channels**, once Half B is
  enforced — **complete for channels born with a transcript** (every wrap
  they ever produce is epoch-bound, §7), and **beginning at migration for
  channels converted from legacy**, with the pre-migration residual stated
  in §7. In **democratic-mode** channels this is **conditional** — the tally
  is server-trusted and the guarantee there is detection under the precise
  observation condition of §7, not prevention.

**Detectable, not prevented:**

- **Duplication** of a genuine object the client currently holds identity
  state for, via the exact-identity dedup of §4.
- **Re-dating.** The envelope carries the sender's own clock (`sender_ts`);
  the server's timestamp is demoted to *receipt metadata*.
- **Stale or forked channel state**, once Half B ships, via checkpoint
  cross-attestation (§7) — detection is **eventual**, when evidence from the
  separated views meets, never immediate.
- **Fabricated democratic outcomes**, only by clients that observed and
  retained the contradicting proposal lifecycle (§7).

**Explicit non-goals — stated so nobody rounds up:**

- **Server-minted `id`, `ts` and `seq` are untrusted receipt metadata.**
  They order storage, drive paging and partitioning, and nothing more. The
  UI's authenticated notion of "when" is `sender_ts`; the authenticated
  notion of "which message" is the signed `(sender, writer_scope,
  client_msg_id)` triple.
- **Completeness.** A server can still withhold messages or events. Half B
  bounds this for channel state (§7); for messages it remains open.
  Withheld edit ancestry degrades an edit to unverified-target, never to
  false trust (§5).
- **Democratic tallies.** Votes are deliberately secret and unsigned;
  governance outcomes are enacted on the server's word. §7 states exactly
  what is and is not claimed there — C-01 in democratic channels is an
  **accepted residual risk**, not a resolved finding.
- **Denial of service.** Out of scope, as everywhere else in the threat
  model. (The §7 removal freeze trades availability for confidentiality
  deliberately and says so.)
- **TOFU first-fetch.** Unchanged from phase 82; signatures verify against
  the pin and inherit exactly that limit.
- **Device attribution.** See §2. The guarantee is scoped to the user.
- **Forward secrecy / post-quantum.** Unchanged non-goals.

**A fresh device (or cleared local state) starts with no dedup state, no
revision heads, no transcript head, and no pins beyond what the phase-84
backup restores.** Its detection guarantees begin at zero and grow. What a
fresh device can *prove* is stated per object class in §5 and §7.

## §2 — Identity: user-only authorship, on the anchor we already have

*(Resolved; unchanged in substance since the second revision.)*

chalk's identity is per-user by design (`migrations/0031_identity_keys.sql`):
every device signed into an account derives the same X25519/Ed25519 pair
from the same phrase. A device ID is a random UUID in localStorage with no
key material behind it. A signature made with the identity key proves *the
user*; the envelope's `writer_scope` — an opaque UUID whose **only** role is
to namespace per-device sender state (§4, §5) — is documented everywhere as
an unauthenticated label, never rendered as "sent from device X".

**Rejected: per-device signing subkeys** certified by the user identity — a
whole new sub-protocol with no existing machinery and no product
requirement; it layers on later without changing the envelope if ever
needed.

**The verification anchor is `trust.ts`, unchanged:** `resolveSigner` from
local pins on unattended paths; `fetchTrustedIdentity` (TOFU-pins) only
where `openWrap` allows the network today; `markManuallyVerified` upgrades
the same pin and a `changed` pin repudiates it; the phase-84 backup carries
pins across devices. Message assurance maps onto the existing `MemberTrust`
vocabulary.

**Key rotation.** Not implemented today — nothing sets
`identity_keys.retired_at`. Verification is against the *pinned* key. When
rotation is built it inherits a constraint recorded here: old signatures
must remain verifiable against a verified historical key or a signed
transition record, never silently re-checked against the current key.

## §3 — Construction: sign-then-encrypt, and nothing circular

*(Resolved; carried forward. One change this revision: the reply binding —
see §5 — replaces `parent_id` in the signed fields.)*

**Sign a canonical plaintext object; encrypt the object and its signature
together.** No ciphertext hash anywhere. The AEAD (AAD =
`chalk-msg-s{suite}:{channelID}:{keyVersion}`) authenticates the ciphertext
and binds channel and key version; the inner Ed25519 signature
authenticates every sender-meaningful field, including channel and key
version *again*, so the signature is self-contained even if a future suite
changes the AAD. The server never sees the signature and cannot strip it
without breaking the AEAD. Precedents: phase 82's wrap signature inside the
opaque `wrap_blob`; `signal-crypto.ts`'s `fp_sig` inside the sealed
`SdpSignal`. No message-table schema change; `messages.meta` stays unused.

### The wire format

`CURRENT_MSG_SUITE` goes 1 → 2. A suite-2 body is, as today,
`suite(1) || nonce(12) || ct || tag(16)`; the plaintext becomes UTF-8 JSON:

```
{ "e": { ...typed envelope fields... }, "sig": "<base64 Ed25519 signature>" }
```

JSON is the transport shape only; **the signature is never computed over
JSON**. The verifier rebuilds the canonical byte string from the parsed
fields.

### The canonical encoding

```
lp(x)     = u32be(len(x)) || x
canonical = utf8("chalk-msg-sig.v1") || u8(objType) || <fields per class, §5>
```

- Domain `chalk-msg-sig.v1`, sibling of `chalk-wrap-sig.v1` and
  `chalk-voice-fp.v1`. Half B's transcript events use `chalk-chan-sig.v1`
  (§7).
- `objType`: `0x01` message, `0x02` edit, `0x03` reaction set.
- Every variable-length field `lp()`-prefixed; fixed-width integers
  fixed-width big-endian; lists `u32be(count)` + elements; absent optionals
  `lp("")` (absent and empty deliberately identical: "no value").
- The **chain checkpoint** is `u64be(chain_index) || lp(chain_hash)` —
  `(0, lp(""))` until the channel has a transcript.
- 83-1 **exports** the private helpers from `spacekey.ts` (`writeU32BE`,
  `lengthPrefixed`, `concat`, `bytesEqual`, `utf8`); every canonical encoder
  in the repo uses them. Two encoders that drift apart is the failure mode
  this phase exists to avoid.

### Sign and verify behaviour

The repo's established asymmetry: **signing throws** on degenerate input;
**verification never throws** and returns a typed result on every path.

| Result | Meaning |
|---|---|
| `verified` | Signature valid against the pinned/verified key for the signed sender; every server-supplied outer field matches its signed inner counterpart |
| `mismatch` | Signature valid, but an outer field disagrees with the signed value — the server's framing is forged; the inner values are authoritative |
| `forged` | Signature invalid against our belief about the signed sender's key |
| `unpinned` | No local pin for the signed sender and the path may not fetch — decided later, not trusted now |
| `unsigned` | Suite-1 object — rendered unauthenticated, uniformly (§6) |

**On `mismatch`, the signed inner fields win, always.** **Content is
displayed even when attribution fails**, under an unmistakable warning —
only key holders can produce decryptable content, so hiding it would hand a
hostile server a censorship lever. Attribution fails closed; availability
does not.

## §4 — Deduplication and ordering: exactly what the client can prove

*(Resolved in the third review; unchanged.)*

### Sender side

Every plain message envelope carries `client_msg_id` (fresh UUID, minted
first in the send flow), `sender_ts` (sender's clock, the authenticated
"when"), `writer_scope` (opaque UUID naming this device's sender-state
store — **one scope per device counter-store, never shared**; a lost store
mints a fresh scope, never restarts an old one), and `wseq` (strictly
increasing per `(channel, writer_scope)`, persisted sender-side). **`wseq`
is an ordering claim only** in this phase: it feeds display and future
completeness-range work and generates **no security warnings**.

### Receiver side

One bounded IndexedDB store (`idb.ts` takes its first `DB_VERSION` bump
since v4 — mechanical): **exact-identity dedup** — signed
`(sender_user_id, writer_scope, client_msg_id)` → first-seen `server_id`,
bounded LRU. The same triple under a **different** server row is a
duplicate: dropped and flagged. **Eviction produces "unknown", never
"replay"** — no arrival order, page order, or gap is ever classified as
suspicious by itself; out-of-order history, previews, search and
deep-search pages are all normal.

**Buys:** duplicate elimination within the window; re-dating visible as
`sender_ts`/server-`ts` skew; per-scope ordering displayable from signed
data. **Does not buy:** replay detection beyond the window, fresh-device
auditing of unheld history, withholding detection. All stated in §1.

**Rejected (recorded):** Option B, the client-minted message ID — the
partitioned `(ts, id)` PK cannot enforce global uniqueness of a
client-supplied ID, and without uniqueness a hostile client gets an
equivocation primitive. The scalar watermark — misclassifies paginated
history (P83-R2-05).

## §5 — Typed object protocols, and the storage that backs their claims

**P83-05, P83-R2-06, P83-R3-02 and P83-R3-03's fixes.** One envelope per
object class; message semantics apply to nothing else — voice signals
(signed under `chalk-voice-fp.v1`), prefs blobs, the parking lot and link
previews (embedded in the body before encryption) keep their shapes.

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

### The signed content identity

A suite-2 object's durable, signed identity is
`(sender_user_id, writer_scope, client_msg_id)` from its envelope. Edits,
reactions **and now replies** bind their target by content identity plus an
**envelope hash** — never by the server row locator alone. Wire frames
still carry `(channel_id, message_id, ts)` for row lookup; those are
receipt metadata. A **legacy suite-1 target** has no content identity: the
binding encodes as `lp("")` fields and the object renders with an
unauthenticated-target mark — for replies exactly as for edits and
reactions. Operations on legacy rows cannot be strongly bound, ever.

### `0x01` — message

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(writer_scope) || lp(client_msg_id) || u64be(sender_ts)
|| u64be(wseq)
|| lp(par_sender) || lp(par_scope) || lp(par_client_msg_id)   // reply target:
|| lp(par_env_hash)                                            //  content identity
                                                               //  + SHA-256 of the
                                                               //  parent's canonical
                                                               //  envelope; all lp("")
                                                               //  when not a reply or
                                                               //  legacy parent
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

- **Replies (P83-R3-02):** the sender holds the decrypted parent envelope,
  so it signs the parent's content identity *and* the hash of the parent's
  canonical envelope. `parent_id` rides only on the wire frame as an
  untrusted lookup locator; the server's derived `thread_id` remains
  receipt metadata. A server mapping one `parent_id` to different signed
  parents in different views now produces a visible `mismatch` for any
  client holding either parent: the signed hash pins exactly one. A reply
  whose parent the client does not hold renders its threading as
  unverified-target — never as false trust.
- Attachment digests are over the *ciphertexts*, which exist before the
  message is built; receivers verify every fetched or inline blob against
  the signed digest before decrypting. An attachment ref not covered by
  its parent's envelope renders unauthenticated. `att_key_version` is per
  attachment because an upload pins its own key version across a rotation.

### Revision ancestry: the storage model (P83-R3-02, P83-R3-03)

The third review is right twice over: an in-place `UPDATE messages SET
body = …` destroys the signed original a fresh reader needs, and a lone
latest-hash cannot distinguish "older revision" from "sibling fork" once a
chain is more than one link long. The fix is storage, decided (scuq,
2026-08-07): **edits become append-only on the server.**

- New table, `message_revisions`: `(message identity, rev_hash,
  body ciphertext, replaced_at)`. An edit **moves** the replaced body into
  it instead of destroying it; rows are opaque E2E ciphertexts like any
  body, readable only by key holders. Deleting a message purges its
  revisions in the same statement as the tombstone. Volume is bounded by
  the 15-minute edit window — chains are short by construction.
- **This reverses migration 0044's deliberate overwrite-no-revisions
  choice**, recorded here so the contradiction is on paper: 0044 optimised
  for storage simplicity when bodies carried no signatures; once an edit
  destroys signed evidence, overwrite is no longer compatible with the
  guarantee this phase exists to provide. The 83-4 migration states this
  in its header.
- New fetch frame (`fetch_revisions`, by message): returns the revision
  ciphertexts so any client — including a fresh device — can decrypt,
  verify each envelope, and walk the chain.

**Per-object revision state, persisted client-side** (same IDB store
family as §4): a bounded set of verified revision nodes
`rev_hash → prev_rev_hash` plus the set of current **heads** (plural — a
fork has two). Eviction of nodes returns classification to **unknown**,
never to stale or forked.

**The classification state machine**, given an incoming verified revision
`R` with parent pointer `R.prev`:

| Condition | Class | Action |
|---|---|---|
| `R.prev` is a current head | **extend** | advance that head to `hash(R)` |
| `R.prev` is a known non-head ancestor, and a known child of `R.prev` ≠ `R` exists | **sibling fork** | keep both branches; surface "edited concurrently"; presentation order is the server's, labelled unauthenticated |
| `hash(R)` is a known ancestor of a current head | **stale** | already-superseded revision re-presented; it cannot displace the head |
| `R.prev` unknown and not fetchable | **unknown** | fetch ancestry via `fetch_revisions`; if the server withholds it, render **unverified-target** and do not adopt as latest |
| First revision (`R.prev = lp("")`) matching the original's envelope hash | **root** | chain begins |

**Fresh-reader claim, now backed by storage:** a fresh device fetches the
ancestry, verifies every signature and link, and proves target binding,
staleness and forks exactly as a long-lived device does. If the server
withholds ancestry, the edit degrades to unverified-target — withholding
is visible and fails toward *less* trust, never more. The only remaining
fresh-reader limit is inherited from §1: a server can withhold the entire
message; it can no longer misrepresent what an edit replaced.

### `0x02` — edit

```
lp(channel_id) || u32be(key_version) || lp(sender_user_id)
|| lp(tgt_sender) || lp(tgt_scope) || lp(tgt_client_msg_id)  // content identity
|| lp(prev_rev_hash)                       // hash of the replaced envelope
|| u64be(sender_ts) || u64be(chain_index) || lp(chain_hash)
|| lp(utf8(body_text))
|| u32be(att_count) || att_binding*        // re-stated from the original
```

Only the original sender may edit (server-enforced today; the signature
now enforces it — `sender_user_id` must equal `tgt_sender`). Attachment
bindings are re-stated so the current revision stays self-sufficient
without a fetch. Wire gap closed in the same slice: `message_edited` gains
the editor's user ID (display-before-decrypt convenience, checked like any
outer field).

### `0x03` — reaction set

```
lp(channel_id) || u32be(key_version) || lp(actor_user_id)
|| lp(tgt_sender) || lp(tgt_scope) || lp(tgt_client_msg_id)
|| lp(tgt_env_hash)                        // hash of the target's envelope
|| lp(prev_set_hash)                       // lp("") for the actor's first set
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*        // zero-count = cleared
```

- **Clearing stays a signed, sealed empty set** — the bare `body: ""`
  special case (which skips the key-version and ceiling checks server-side
  and produces an unauthenticated, unencrypted push) is retired; the
  server stores and pushes a clear as a normal value and its
  skip-the-checks branches are deleted.
- **Reactions do *not* get server-side ancestry — and their guarantee is
  narrowed accordingly, on the reviewer's own terms** (P83-R3-03: "without
  it, keep the latest-content guarantee explicitly limited to locally
  observed ancestry"). The server keeps one row per `(message, reactor)`
  as today. A client that observed a newer set refuses a stale one by its
  local chain state; a **fresh device proves only that the actor signed
  the presented set for that target at the signed `sender_ts`** — not that
  it is the latest. Concurrent device sets it happens to hold surface as
  forks; ones it never saw are invisible to it. Rationale: reaction sets
  are ephemeral, low-stakes emoji state; full ancestry storage is not
  worth its cost here, and the honest narrow claim is stated instead. Any
  member may react (unchanged); the signature binds the actor.

### Guests

Guests derive a full Ed25519 identity from the link secret and can sign
(`GuestRoom.tsx` holds a `DerivedIdentity`); guest identities are served by
`fetch_identity` since 80-9. Guests sign like members; members verify a
guest like any peer. A guest verifies members best-effort with in-session
TOFU pins (no durable pin store, no phase-84 backup) — stated. Links
minted before 82-7 remain unsigned-wrap territory until expiry —
unchanged, out of scope here.

### Previews (thread inbox, search, channel summaries)

A preview renders outer `sender` and `ts` beside decrypted text; until the
underlying row is verified those are receipt metadata, and the preview
carries the same assurance mark as a full row — a preview must never look
*more* trustworthy than the message it previews. `ThreadInboxEntry` gains
the head and last-reply **message IDs** (the server already holds
`thread_activity.last_reply_id`; it just never sent it).

## §6 — Migration, downgrade resistance, enforcement

*(P83-06 and P83-R2-07, resolved; carried forward, with the acceptance
list extended per the third review.)*

- **All suite-1 content is one class: unauthenticated.** A quiet mark, no
  attribution checkmark, ever — identically in history, previews, search
  and live. No claim is made about *when* legacy content was written
  (observation order is not creation order); suite-1 content never gains
  authenticated attribution under any circumstance.
- **The enforcement flag**, `CHALK_MSG_SIG_REQUIRED` (the exact
  `CHALK_WRAP_SIG_REQUIRED` shape: config default + `--flag` + env parse +
  welcome field + one-way client latch + chalkctl generate/preserve per
  the `init.go` pattern):
  - *Server-side:* `handleSend`, `handleEditMessage` and
    `handleSetReactions` reject suite-1 bodies — the leading byte after
    base64 decode is the suite; no content access needed.
  - *Client-side (the security boundary):* the latch is one-way per
    session; under it, **live** suite-1 arrivals are flagged hard — on a
    latched client they cannot be legitimate.
- The per-`(channel, sender)` "seen signing" memo survives **only as UI
  copy input**, explicitly not a security classification.
- Defaults **off** through the migration; a later slice flips the default
  **on** (the 82-10 precedent, `chalkctl update` preserving an explicit
  operator choice).
- **Readiness** (pattern 82-9): `chalkctl msgsig status` reports the share
  of recent messages at suite 2 per channel by the leading suite byte —
  content-free. `enable` refuses while active senders still produce
  suite 1 (`--force` overrides and says so); `disable` exists for the same
  reason `wrapsig disable` does.

**The threat-model staging table** — which claim moves at which point, and
*only* then:

| Ships | `threat-model.md` movement |
|---|---|
| 83-1 … 83-2 (helpers, policy) | Nothing. Helpers are not guarantees. |
| 83-3 … 83-5 (objects signed end-to-end, enforcement off) | Sender-authenticity gains a "phase 83 partially deployed" paragraph; **status stays NOT met**. |
| 83-6 (enforcement) | Sender authenticity becomes **conditionally met** — user-authorship and relocation, where `CHALK_MSG_SIG_REQUIRED` is on, with §1's non-goals stated. Never unconditional. |
| Half B complete + enforced | The membership paragraph moves, **split three ways**: complete for transcript-born dictator channels; beginning-at-migration for converted ones (pre-migration residual stated); accepted-residual for democratic tallies. Each under its enforcement condition. Not before, and never on the strength of Half A. |

**Acceptance tests** — all hostile-server / hostile-member cases in
`*.test.ts` against the real verify path, attacking with the *accepted*
suite (phase 82's hard lesson):

sender substitution (outer ≠ inner); signature forged by another key
holder; a held message re-presented under a new server id; LRU eviction
never producing a replay claim; out-of-order history producing **zero**
warnings; re-dating skew surfaced; relocation across channel, thread,
parent and target; a reply whose `parent_id` row disagrees with the signed
parent identity/hash (`mismatch`); a reply to an unheld parent
(unverified-target, no false trust); an older edit re-presented (stale by
chain rule); a sibling edit fork (same `prev`, both valid — surfaced,
neither dropped); ancestry withheld by the server (unverified-target, not
adopted as latest); a stale reaction set re-presented to a device that
observed newer; the fresh-device reaction claim held to its narrow form;
an attachment blob swapped under a signed digest; a reaction clear forged
without the actor's key; an edit targeting a legacy row; suite downgrade
under a latched client; `unpinned` never upgrading without a pin; and for
Half B: concurrent transcript appends racing at one index; **suppressed
genesis against a fresh recipient holding a suite-3 wrap (must fail
closed)**; **a suite-2 wrap presented for a transcript-born channel
(refused — honest signers never produce one)**; a fabricated democratic
outcome vs a client with retained lifecycle records; a unilateral event in
democratic replayed state; transcript fork at one index; rollback below a
held head; an unserveable checkpoint suffix (stale, key ops frozen); a
wrap opening to a key mismatching the epoch commitment; **an addition
wrapped before its admission event exists (refused); a send attempted
under a frozen epoch (refused); a removal followed by continued sends
under the old epoch (impossible on a compliant client — frozen); creator
offline across a removal (channel frozen, no silent fallback); a replayed
pre-removal epoch (refused by replayed state); partial rotation recovery
(wraps published, event missing — epoch stays pending)**.

## §7 — Half B: the authenticated channel-state transcript

Membership becomes a hash-linked, signed event sequence replayed by every
member; key handling trusts the replayed state, not the roster. This
revision adds the epoch-bound wrap format (R3-01), the epoch lifecycle
(R3-04), the fully frozen byte schema (R3-05), and the corrected
democratic-detection condition (R3-06).

### The event chain

```
event     = { channel_id, index, prev_hash, type, actor_user_id, details, sig }
canonical = utf8("chalk-chan-sig.v1") || u8(event_type)
            || lp(channel_id) || u64be(index) || lp(prev_hash)
            || lp(actor_user_id) || <details, exactly per the schema table>
event_hash = SHA-256(canonical || lp(sig))
```

The generic `subjects[]` field from the third revision is **deleted**
(P83-R3-05): every event's target lives in its typed `details`, in exactly
one place, so no consistency rule between two representations is needed.

The server stores and relays events (one new table, `(channel_id, index)`
unique — concurrent appends race, the loser refetches and re-appends on
the new head; fetch/append frames) and can forge none of them. What it
*can* do — fork, roll back, withhold — the checkpoint rules below detect,
**eventually**.

### The frozen byte schema (P83-R3-05)

Nothing below is left for an implementation slice to decide. Common rules:
every variable field `lp()`-prefixed; lists `u32be(count)` + elements,
sorted by user-ID bytes, duplicates invalid; absent optionals `lp("")`;
`ed25519_fp` = SHA-256 of the raw 32-byte public key; `index` starts at 0
(genesis) and is `< 2^63`.

Enum tags (each one byte):

| Enum | Values |
|---|---|
| `event_type` | `0x01` genesis, `0x02` genesis_migration, `0x03` add_member, `0x04` remove_member, `0x05` self_leave, `0x06` set_mode, `0x07` key_epoch, `0x08` guest_grant, `0x09` guest_revoke |
| `role` | `0x00` member, `0x01` owner |
| `mode` | `0x00` dictator, `0x01` democratic |
| `chan_kind` | `0x00` group, `0x01` dm, `0x02` ephemeral |
| `auth_arm` | `0x00` unilateral, `0x01` governance (proposer), `0x02` governance (owner fallback) |

`member_entry` = `lp(user_id) || lp(ed25519_fp) || u8(role)`.

`gov_record` (the governance-resolution evidence, one fixed byte order) =
`lp(proposal_id) || u8(proposal_type: 0x00 add_member, 0x01 remove_member,
0x02 set_mode) || lp(target_user_id) || u8(mode_payload; 0xFF when absent)
|| u32be(eligible) || u32be(yes) || u32be(no) || u32be(quorum_percent)
|| u32be(threshold_percent)`.

`details` per event type:

| Type | `details`, in exact order | Bounds / validation |
|---|---|---|
| `genesis` | `member_entry(creator) || u32be(n) || member_entry*(initial members) || u8(mode) || u8(chan_kind) || u32be(key_version=1) || lp(key_commitment)` | n ≤ 512; creator's role must be `owner`; exactly one owner |
| `genesis_migration` | `u32be(n) || member_entry*(roster) || u8(mode) || u32be(key_version) || lp(key_commitment) || u8(prior_state = 0x00 legacy)` | n ≤ 512; exactly one owner; actor must be that owner |
| `add_member` | `lp(target_user_id) || lp(target_ed25519_fp) || u8(role = 0x00) || u8(auth_arm) || gov_record?` | `gov_record` present iff `auth_arm ≠ 0x00`; target not in replayed membership; `gov_record.proposal_type = 0x00` and `gov_record.target_user_id` = target |
| `remove_member` | `lp(target_user_id) || u8(auth_arm) || gov_record?` | target in replayed membership, not the owner; actor ≠ target; same `gov_record` consistency |
| `self_leave` | *(empty)* | actor in replayed membership and not the owner; the actor is the subject |
| `set_mode` | `u8(old_mode) || u8(new_mode) || u8(auth_arm) || gov_record?` | old = replayed mode; dictator→democratic requires `auth_arm = 0x00` and actor = owner; democratic→dictator requires a governance arm with `proposal_type = 0x02`, `mode_payload = 0x00`, `threshold_percent` = the supermajority |
| `key_epoch` | `u32be(key_version) || lp(key_commitment) || u64be(under_index) || lp(under_event_hash)` | actor = creator; key_version = replayed version + 1; `(under_index, under_event_hash)` names a real event at or before this one |
| `guest_grant` | `lp(guest_user_id) || lp(guest_ed25519_fp) || lp(owner_ed25519_fp) || u64be(expiry_unix_ms) || u32be(key_version)` | actor = owner; the guest fp is derivable by the owner at mint (identity is a pure function of the link secret) |
| `guest_revoke` | `u64be(grant_index) || lp(grant_event_hash)` | actor = owner; names a real `guest_grant` |

`key_commitment` = `SHA-256(utf8("chalk-key-commit.v1") || spaceKey)`.

The **state-transition function** — (replayed state × event) → new state
or `invalid`, `invalid` stopping the chain for every honest client — is
part of the spec, implemented in 83-7 as a pure function with the event
list as input, testable without a server. The authority checker, the
transition function and the signer all read the *same* decoded structures;
the table above is the only decoding.

### Authority, per event type and per governance mode

*(Corrected in the third revision against the verified product rules;
unchanged.)*

| Event | dictator mode | democratic mode |
|---|---|---|
| `genesis` | creator | creator |
| `genesis_migration` | owner | owner |
| `add_member` | any current transcript member | governance arm only |
| `remove_member` | owner (target never the owner) | governance arm only |
| `self_leave` | the member; never the owner | same — never proposal-gated |
| `set_mode` → democratic | owner, unilateral | — |
| `set_mode` → dictator | — | governance arm only (supermajority) |
| `key_epoch` | creator only | creator only |
| `guest_grant` / `guest_revoke` | owner only | owner only |

The verifier's check is **mode-dependent on the replayed state**: a
unilateral `add_member` in replayed-democratic state is invalid, chain
stops.

**The democratic exclusion, with its detection condition stated exactly
(P83-R3-06).** Ballots are secret and unsigned by deliberate product
choice (scuq, 2026-08-07: ballot secrecy wins; any verifiable quorum
certificate permanently reveals endorsers — recorded future hardening). A
democratic outcome is enacted by an event signed by the **enacting
proposer** (or the owner as the named fallback arm), binding the full
`gov_record`. What that proves: a named member enacted a specific, fully
stated claimed outcome. What it does not prove: that the tally was honest.

The detection claim, narrowed to what is true: **a client detects a
fabricated outcome only if it was connected during the relevant proposal
lifecycle and retained its observations.** Concretely: clients persist
observed proposal records — proposal id, type, target, and the final
counts at resolution — in IndexedDB (bounded, per channel), and the
transcript verifier compares a governance-arm event's `gov_record` against
the retained record for that proposal id. A contradiction (different
target, different outcome, a proposal this client watched fail) is
surfaced as evidence, like a fork. A member that was offline for the whole
lifecycle, or a fresh device, has no record and detects nothing — and a
server can present a consistent fabricated lifecycle to a partition it
controls. **C-01 in democratic-mode channels is therefore an accepted
residual risk**, stated in the threat model in those words, not a resolved
finding.

**Enactment lag:** the server executes a passed proposal immediately; the
transcript event waits for the enacting client. Until it lands, replayed
state and roster disagree — and the reshare gate refuses the key to a
newly added member until the authenticated admission exists. The lag is
the window in which the addition is not yet proven, and it is closed by
the event, not by trust.

### Genesis: downgrade-safe on both ends (P83-R2-02 + P83-R3-01)

**Creator side** *(third revision, unchanged)*: the client mints the
channel ID and submits the signed `genesis` inside `create_channel` (the
`channels` table is a plain unpartitioned UUID PK; a collision is an
insert error and the client re-mints; option 2 — a pending channel
activated on a later genesis append — rejected as a second round-trip plus
a partial-failure state machine for no additional guarantee). Since
`genesis` commits to key version 1, **the creator mints the space key at
creation time**; the wraps are published after the ack as today;
`ensureChannelKeyInner`'s no-key-anywhere mint branch is superseded for
transcript channels (its 82-4 read-back guard remains). DM idempotency:
the existing-DM short-circuit returns the existing channel; the submitted
ID, genesis and key are discarded. Old clients omit both fields → the
channel is **legacy**, inside the migration soft window; under
`CHALK_TRANSCRIPT_REQUIRED` (config → welcome → one-way latch) the server
rejects creates without a genesis.

**Recipient side — the R3-01 fix: the wrap itself carries the transcript
binding.** The third revision hung the fresh recipient's fail-closed
decision on a server-controlled welcome flag; a server could suppress the
genesis, report enforcement off, serve an honest phase-82 wrap and collect
a reshare. Closed by extending the one format the recipient *must* verify
anyway:

- **Wrap suite 3** (`WRAP_SUITE_X25519_AESGCM_ED25519_EPOCH`): phase 82's
  suite-2 wrap plus the authorized epoch's identity inside the signed
  canonical message —

  ```
  message = utf8("chalk-wrap-sig.v1") || u8(3) || u32be(keyVersion)
         || lp(channelID) || lp(recipientID) || lp(signerUserID) || lp(sealed)
         || u64be(epoch_index) || lp(epoch_event_hash)
  ```

  where `(epoch_index, epoch_event_hash)` names the `key_epoch` (or
  `genesis` / `genesis_migration`) event that authorized this key version.
  The suite byte is inside the signed message, as in phase 82, so the
  format is **cryptographically self-describing — a legacy wrap is
  distinguishable by construction, not by any server-supplied flag.**
- **Honest members of a transcript channel produce only suite-3 wraps.**
  A recipient of a suite-3 wrap must fetch and verify the transcript
  through the named event, check the epoch's key commitment against the
  unwrapped key, and only then adopt or reshare — with no transcript
  served, it stays fail-closed `waiting`. A server cannot strip the epoch
  binding without breaking the signature, and cannot forge a suite-2 wrap
  from a suite-3 one.
- **Transcript-born channels are thereby closed completely**: every wrap
  that has ever existed for them is suite-3, so a fresh device either
  verifies the transcript or refuses the key. The welcome flag and the
  adoption ratchet remain as defence in depth, no longer load-bearing.
- **Migrated channels carry a stated residual**: a server that *retained*
  pre-migration suite-2 wraps can present them to a fresh device along
  with a suppressed transcript and a stale `current_key_version`, holding
  that device on a pre-migration epoch. Bounded honestly: honest members
  send under post-migration epochs the downgraded device cannot open, so
  the device sees undecryptable traffic ("waiting") rather than a working
  channel — loud, not silent — and the exposed material is pre-migration
  history plus anything the downgraded device itself sends before its user
  notices. Completing a migration therefore **includes a rotation**
  (`genesis_migration` → creator rotates → suite-3 wraps at the new
  version), and the phase-84-style recommendation is recorded: the
  guarantee for converted channels begins at migration-plus-rotation.
  Channels that cannot migrate stay scoped out: the lobby channel
  (`created_by` NULL by design, no members) permanently; orphaned channels
  (creator deleted — who also cannot rotate today) stay legacy, recommend
  recreation.
- **The transcript-adoption ratchet** (client, IndexedDB, 82-5 pattern):
  once a client holds a valid genesis or migration for a channel, it never
  again treats that channel as legacy — permanently, regardless of flags.

**Existing channels** migrate by an owner-signed `genesis_migration`
asserting the roster as it stands, displayed to every member as an
adoption: *"roster as asserted by \<owner\> on \<date\>"* — TOFU for
membership, documented as such; guarantees begin at the migration event
and retroactively prove nothing.

**Admission binds the admitted key.** The authorizer resolves the target's
Ed25519 key (pin, or fetch-then-pin) *at admission time* and signs its
fingerprint; every member converges on one admitted key, and a later
different key is the existing changed-pin flow. This does not eliminate
TOFU's first fetch — the authorizer's own pin may have been poisoned at
first sight — it prevents *divergent* resolution after the admission.

### The epoch lifecycle (P83-R3-04)

The key commitment closes substitution *within* an epoch; this section
defines when an epoch may be used at all. Per channel, the replayed state
carries an epoch status: **active** or **frozen**.

- **Additions do not require a new epoch.** The epoch's
  `(under_index, under_event_hash)` records where it was *minted*;
  authority to **distribute** it is the replayed *current* membership. A
  member added after the epoch receives the current key (matching today's
  deliberate rewrap flow) — but **only after its `add_member` event is
  verified** (the enactment-lag gate above), and only while the epoch is
  active. Creator-offline is therefore a non-event for additions.
- **A removal or self-leave freezes the epoch.** The moment a client's
  replayed state applies a `remove_member` or `self_leave`, the current
  epoch becomes **frozen**: on a compliant client, **sending, key
  adoption and resharing all stop** in that channel (compose disabled
  under a banner — "waiting for key rotation"), because anything sent
  under the old epoch is readable by the removed member, who still holds
  the key. A transcript proving a removal does not revoke a key; only the
  rotation does. Today's behaviour — traffic continuing under the old key
  with `rotation_pending` making the gap merely *visible* — is exactly
  the hole; the freeze is the fix, and its availability cost is
  deliberate and stated (§1).
- **Unfreezing is the post-removal epoch**: the creator publishes suite-3
  wraps for version `v+1` to the post-removal membership, appends the
  `key_epoch` event bound to a head at or after the removal, and commits
  the server-side version advance (the existing `rotate_channel_key`
  flow). Clients unfreeze when their replayed state applies a `key_epoch`
  whose `under_*` head includes the removal. **Ordering and recovery:**
  wraps-published-but-no-event ⇒ the epoch is *pending*, the channel
  stays frozen, the creator's client retries the append (idempotent — the
  unique `(channel_id, index)` race resolves by refetch-and-reappend);
  event-appended-but-version-not-advanced ⇒ retry the advance
  (`stale_key_version` is already swallowed as success in today's client
  rotation path). A replayed *pre-removal* epoch can never unfreeze a
  channel: its `under_*` head precedes the removal, which the transition
  function checks.
- **Creator offline across a removal ⇒ the channel stays frozen until the
  creator returns.** This matches the existing authorization model
  (rotation is creator-only in SQL, in both modes; `rotate_needed` and
  the durable `rotation_pending` catch-up already target only the
  creator) — the phase makes the wait *safe* instead of silently unsafe.
  Widening rotation authority would be a product change this phase
  deliberately does not make; recorded as a rejected alternative
  (creator-only is also what keeps `key_epoch` authority checkable).

### Checkpoints: fork, rollback, staleness (P83-R2-04, resolved)

The envelope's chain reference is the structured checkpoint
`(chain_index, chain_hash)`. Receiver state machine, comparing a peer's
checkpoint `P` against the local verified head `L` (both persisted per
channel):

| Comparison | Meaning | Action |
|---|---|---|
| `P.index == L.index && P.hash == L.hash` | agreement | none |
| `P.index < L.index`, `P.hash` matches our chain at that index | peer is older | none |
| `P.index < L.index`, `P.hash` does **not** match our chain there | **fork proof** | permanent evidence; surface like the identity-changed wall; freeze key ops |
| `P.index > L.index` | peer is ahead | fetch `(L.index, P.index]`; verify; advance. Unserveable → channel **stale** |
| `P.index == L.index && P.hash != L.hash` | **fork proof** | as above |
| no local transcript | unknown | legacy channel: ignore. Suite-3 wrap held or transcript-required: **stale** |

Rollback: any served prefix ending below `L` is refused — `L` is
monotonic. Freeze rules: *stale* or *forked* ⇒ no key adoption, no
resharing (messaging continues under a banner — distinct from the *epoch*
freeze above, which stops sends). Resume: *stale* clears when the suffix
arrives and verifies; a **proven fork never clears**. Detection is
**eventual**: cross-attestation catches equivocation only when evidence
from the separated views meets; a perfect permanent partition is caught by
neither side — what the server can no longer do is heal the partition
without the fork becoming provable.

### Catch-up, multi-device, guests

Offline catch-up is replay: fetch events past `L`, verify each (signature
+ prev-hash + mode-dependent authority + state transition), advance.
Multi-device: each device replays independently and keeps its own head;
honest devices converge by construction (the phase-84 backup is
deliberately unused). Guests do not verify the transcript in v1 — scoped
out, documented; their admission is authenticated *for members* via
`guest_grant`/`guest_revoke`, their key access rides 82-7's fragment
anchor, and a guest trusts the member who handed it the link, which was
already the guest trust model.

## §8 — Slices

**Gate 0 — independent protocol review of this fourth revision. Nothing
below starts before it passes.** Then, Half A first:

| Slice | Content |
|---|---|
| 83-1 | Export the canonical helpers from `spacekey.ts`; `chalk-msg-sig.v1` typed encoders for objTypes 1–3; sign (throws) and verify (total, typed result). Pure crypto. Tests modelled on 82-1's. |
| 83-2 | Public trusted-signer accessor on `ChannelCrypto`; the verify policy copied from `openWrap` including the offline warm path; the dedup, revision-DAG and lifecycle-record stores (idb version bump). |
| 83-3 | The `onSend` reorder; message envelope (`0x01`) including the signed parent binding; `CURRENT_MSG_SUITE = 2` + `describeSuites()` arm; plain sends signed and verified end to end, enforcement off. |
| 83-4 | Edits (`0x02`): the `message_revisions` migration (recording the 0044 reversal in its header), the append-only edit path + purge-on-delete, `fetch_revisions`, the revision state machine, the `message_edited` editor-ID field. Reactions (`0x03`): chained sets, the sealed signed clear, deletion of the skip-the-checks branches, the narrowed fresh-device claim in the UI. |
| 83-5 | Attachment digest verification on every fetch path; guest signing in `GuestRoom.tsx`; `ThreadInboxEntry` head/last-reply IDs and preview assurance marks. |
| 83-6 | Assurance UI (§3's five results on the `MemberTrust` vocabulary; uniform suite-1 rendering); `CHALK_MSG_SIG_REQUIRED` end to end; `chalkctl msgsig status/enable/disable`. Threat model moves per §6's staging table. |
| 83-7 … | Half B: the state-transition function (pure, event-list-in, the §7 schema as its only decoding); event table + fetch/append frames; **wrap suite 3** in `spacekey.ts` + `openWrap`'s transcript-fetch-and-commitment check; `create_channel` wire change (client-minted ID + genesis, creation-time key mint); the epoch lifecycle (freeze/unfreeze, compose gating, rotation recovery); client replay/verify + checkpoint heads; envelope checkpoint production and cross-attestation; the reshare/adoption gate + adoption ratchet; `genesis_migration` + migration-completes-with-rotation; persisted proposal-lifecycle records + the gov_record comparison; `CHALK_TRANSCRIPT_REQUIRED`. Each slice names its threat-model movement. |

## Before this ships

Gate 0 sits before code, not before release — three paper reviews have
each caught blocking protocol errors, which is the cheapest possible place
to catch them. Phase 81 gave the standing reason: a signature verified
inconsistently, or a transcript that does not actually bind membership,
produces the *appearance* of the guarantee, which is worse than the
current state, where `threat-model.md` says plainly that neither guarantee
is met.

`docs/threat-model.md` moves per §6's staging table and at no other time —
and when Half B's membership claim moves, it moves **split three ways**:
complete for transcript-born dictator channels, beginning-at-migration for
converted ones, accepted-residual for democratic tallies — each under its
enforcement condition.

Phase 88 (federation, declined) treats this phase as a hard prerequisite;
if federation is ever reconsidered it is gated on **both** halves,
enforced, not on Half A.

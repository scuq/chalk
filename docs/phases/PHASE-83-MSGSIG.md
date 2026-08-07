# Phase 83 — signed message envelopes and an authenticated channel-state transcript

The two cryptographic findings phase 81 confirmed and deliberately deferred,
and the one the 2026-08-05 audit follow-up put at the top of its
remaining-work list. **NOT IMPLEMENTED — no code exists.** This document is
the plan and nothing below it has been built.

**Status: design, sixth revision.**

- First revision, 6 August 2026: exploratory design. Reviewed; six findings
  P83-01 … 06, verdict *"request major revision."*
- Second revision (commit `9890571`): P83-02/04 resolved on re-review; seven
  new findings R2-01 … 07. Gate 0 not passed.
- Third revision (commit `3d8a25f`): R2-04/05/07 resolved on third review;
  five blocking findings R3-01 … 05 plus R3-06. Gate 0 not passed.
- Fourth revision (commit `60c2ade`): R3-06 resolved on fourth review; seven
  findings R4-01 … 07 — implementation-critical contradictions in the new
  constructions. Gate 0 not passed.
- Fifth revision (commit `b6ba5aa`): R4-01, R4-04 and R4-06 resolved on the
  fifth review; four blocking findings R5-01 … 04, each on a persistence,
  AEAD-context, downgrade or hash-definition boundary. Gate 0 not passed.
- This sixth revision answers the fifth review. All review documents are
  external, like the phase-81 audits; this doc is the in-repo record.

**Gate 0: nothing in the slice table may start until this revision passes
independent protocol review.** Five paper reviews have each caught blocking
errors before a line of code existed — the gate working exactly as intended.

**Tag:** `#msgsig` → `tools/where.sh -g msgsig` (which today finds this plan
and the documents that point at it, and no code, because none exists).

**Depends on phase 82.** The expensive half of both findings — an identity
anchor a signature can be checked against — was already paid for there:
`web/src/crypto/trust.ts` pins peer Ed25519 keys, and `channel-crypto.ts`
already verifies-then-decrypts against a pinned signer. This phase spends
that anchor twice more, and extends phase 82's wrap format once (suite 3,
§7).

---

## Review dispositions

Rounds one to three: P83-01 → §1/§4; P83-02 → §3 (resolved); P83-03 → §7;
P83-04 → §2 (resolved); P83-05 → §5; P83-06 → §6; R2-01/02/03 → §7;
R2-04 (checkpoints), R2-05 (dedup), R2-06 → §5, R2-07 (uniform legacy) —
resolved; R3-01 → §7 wrap binding; R3-02/03 → §5 ancestry; R3-04 → §7
epochs; R3-05 → §7 schema; R3-06 (democratic detection) — resolved.

Fourth review (per the fifth review: R4-01, R4-04 and R4-06 resolved, the
rest partial until this revision):

| Finding | Was | Resolved in |
|---|---|---|
| P83-R4-01 (High) | Suite 3 defined its signed message but not the stored blob a recipient parses | §7 (frozen 228-byte blob layout, parse and rejection rules, tests) |
| P83-R4-02 (High) | Rotation published epoch-bound wraps before the referenced event committed — a lost append race orphans every wrap | §7 (committed-event-first rotation state machine with full recovery) |
| P83-R4-03 (High) | The first edit's parent was both "the original envelope hash" and "empty"; the revision table was keyed by values the server cannot derive | §5 (root rule fixed; server schema frozen on server-visible locators; revision cap) |
| P83-R4-04 (Critical) | Converted-channel downgrade can stay silent forever — withholding post-migration traffic hides it, so "begins at migration" was false | §7 (per-device adoption boundary; recreation for the full guarantee; "loud" claim withdrawn) |
| P83-R4-05 (High) | UUID text aliasing, unfixed digest lengths, missing genesis/index invariants | §7 (canonical `uuid16`/`h32` forms; index chain rules; complete variant validation; per-field caps) |
| P83-R4-06 (High) | "Continued sends impossible on a compliant client" ignores a withheld removal | §1, §6, §7 (removal confidentiality scoped to the verified view, explicitly eventual) |
| P83-R4-07 (Medium) | Guests and suite 3: unstated whether guests verify the epoch proof | §7 (fragment-anchored owner-signature check over the full suite-3 message; epoch proof deliberately unverified by guests in v1) |

Fifth review, all answered in this revision:

| Finding | Was | Resolved in |
|---|---|---|
| P83-R5-01 (High) | Rotation could commit a key commitment whose 32-byte preimage lived only in volatile client state, and the append-race retry was invalid once another creator device won | §7 (durable pending op; **atomic event + creator-self-wrap append**; the losing-device abandon rule) |
| P83-R5-02 (High) | `message_revisions` archived a ciphertext without the `key_version` that is its AEAD context — cross-epoch ancestry was undecryptable | §5 (column added; copied atomically; returned by `fetch_revisions`) |
| P83-R5-03 (High) | The guest fragment has only two authenticated forms and cannot require suite 3 | §7 (the frozen 65-byte era-3 fragment form) |
| P83-R5-04 (High) | The object hash used by replies, edits and reactions was never defined | §3 (`object_hash`, one formula, used by every chain) |

Plus the fifth review's two non-blocking observations, both adopted: the
complete suite-3 `openWrap` predicate and the pin-backup marker capacity
rule (§7).

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
the key by a legitimate member. 82-8 makes this visible — visibility, not
prevention.

---

## §1 — Security goal, and explicit non-goals

**Guaranteed, once enforcement is on (§6):**

- **User-level authorship.** A message, edit, reaction set or attachment
  binding verifiably originates from the user it names, checked against
  *this client's* pinned or manually-verified belief about that user's
  Ed25519 identity key (`trust.ts`). No other key holder — member or
  server — can produce an object that verifies as that user.
- **Relocation resistance.** A signed object cannot be presented in a
  different channel, against a different target, at a different key version,
  or under a parent whose signed content identity the sender did not name.
- **Membership integrity, scoped to each client's verified transcript
  view.** For **transcript-born dictator channels**, key material flows
  only to principals that client's replayed transcript authorizes — and
  **removal confidentiality is eventual**: a removal binds a given sender
  only once that sender has verified it (§7); a server withholding the
  removal suffix from a member keeps that member's view honestly stale,
  which is the acknowledged partition limit, not an exception to it. For
  **converted channels** the guarantee is **per device, from the moment
  that device verifies and persists the migration adoption** (§7) — never
  global. In **democratic-mode** channels membership transitions are an
  **accepted residual risk** (§7): detection under a precise observation
  condition, not prevention.

**Detectable, not prevented:**

- **Duplication** of a genuine object the client currently holds identity
  state for, via the exact-identity dedup of §4.
- **Re-dating** — `sender_ts` vs receipt-`ts` skew.
- **Stale or forked channel state** via checkpoint cross-attestation (§7),
  **eventually** — when evidence from separated views meets, never
  immediately.
- **Fabricated democratic outcomes**, only by clients that observed and
  retained the contradicting proposal lifecycle (§7).

**Explicit non-goals — stated so nobody rounds up:**

- **Server-minted `id`, `ts` and `seq` are untrusted receipt metadata.**
  The authenticated "when" is `sender_ts`; the authenticated "which" is the
  signed `(sender, writer_scope, client_msg_id)` triple.
- **Completeness.** A server can withhold messages or events. Half B bounds
  this for channel state; for messages it remains open — and §7's
  converted-channel and withheld-removal analyses show exactly what
  withholding still buys an attacker. Withheld edit ancestry degrades an
  edit to unverified-target, never to false trust (§5).
- **Democratic tallies.** Secret, unsigned, server-tallied by deliberate
  product choice; §7 states what is and is not claimed.
- **Denial of service.** Out of scope. (The §7 removal freeze trades
  availability for confidentiality deliberately and says so.)
- **TOFU first-fetch.** Unchanged from phase 82; signatures inherit exactly
  that limit.
- **Device attribution.** §2 — the guarantee is scoped to the user.
- **Forward secrecy / post-quantum.** Unchanged non-goals.

**A fresh device starts with no dedup state, no revision heads, no
transcript head, and no pins beyond what the phase-84 backup restores.**
What a fresh device can *prove* is stated per object class in §5 and §7 —
including, for converted channels, that it can prove nothing until it holds
the migration adoption.

## §2 — Identity: user-only authorship, on the anchor we already have

*(Resolved; unchanged in substance since the second revision.)*

chalk's identity is per-user by design (`migrations/0031_identity_keys.sql`):
every device derives the same X25519/Ed25519 pair from the same phrase. The
envelope's `writer_scope` — an opaque UUID namespacing per-device sender
state (§4, §5) — is documented everywhere as an unauthenticated label,
never rendered as "sent from device X". **Rejected:** per-device signing
subkeys (a whole sub-protocol, no machinery, no requirement; layers on
later without changing the envelope).

**The verification anchor is `trust.ts`, unchanged:** `resolveSigner` from
local pins on unattended paths; `fetchTrustedIdentity` (TOFU-pins) only
where `openWrap` allows the network today; `markManuallyVerified` upgrades
the same pin and a `changed` pin repudiates it; the phase-84 backup carries
pins across devices. Message assurance maps onto the existing `MemberTrust`
vocabulary.

**Key rotation** (identity): not implemented today — nothing sets
`identity_keys.retired_at`. Verification is against the *pinned* key. When
rotation is built it inherits a constraint recorded here: old signatures
must remain verifiable against a verified historical key or a signed
transition record.

## §3 — Construction: sign-then-encrypt, and nothing circular

*(Resolved; carried forward.)*

**Sign a canonical plaintext object; encrypt the object and its signature
together.** No ciphertext hash anywhere. The AEAD (AAD =
`chalk-msg-s{suite}:{channelID}:{keyVersion}`) authenticates the ciphertext
and binds channel and key version; the inner Ed25519 signature
authenticates every sender-meaningful field, including channel and key
version again, so it stays self-contained if a future suite changes the
AAD. The server never sees the signature and cannot strip it without
breaking the AEAD. Precedents: phase 82's wrap signature inside the opaque
`wrap_blob`; `signal-crypto.ts`'s `fp_sig` inside the sealed `SdpSignal`.
No message-table schema change; `messages.meta` stays unused.

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
lp(x)      = u32be(len(x)) || x
uuid16(x)  = the UUID's raw 16 bytes; parse strictly, reject anything that
             is not a canonical UUID; text case can no longer alias
h32(x)     = exactly 32 raw bytes (SHA-256 output / Ed25519-key digest);
             fixed width, no length prefix; any other length is malformed
canonical  = utf8("chalk-msg-sig.v1") || u8(objType) || <fields per class, §5>

object_hash(O) = SHA-256( canonical(O) || lp(sig) )
             // sig = the raw 64-byte Ed25519 signature, base64-decoded and
             // length-checked (exactly 64 bytes) BEFORE hashing
```

**`object_hash` is the one hash formula for every message-class chain link**
(P83-R5-04): `par_env_hash`, `prev_rev_hash`, revision node IDs,
`tgt_env_hash` and `prev_set_hash` are all `object_hash` of the referenced
artifact — the same shape as the transcript's
`event_hash = SHA-256(canonical || lp(sig))`, deliberately, so both domains
identify the **complete signed artifact**, fields *and* signature (a
re-signed copy of the same fields is a different artifact, which is what a
chain must distinguish). The JSON transport object and base64 spellings
never enter any hash. Cross-object test vectors and mutation tests — sender,
object type, every target field, and the signature each perturbing the
hash — are 83-1 material.

- Domain `chalk-msg-sig.v1`, sibling of `chalk-wrap-sig.v1` and
  `chalk-voice-fp.v1`. Half B's transcript events use `chalk-chan-sig.v1`
  (§7), with the same `uuid16`/`h32` forms.
- `objType`: `0x01` message, `0x02` edit, `0x03` reaction set.
- Every UUID-valued field (`channel_id`, user IDs, `client_msg_id`,
  `writer_scope`, attachment IDs, proposal IDs) is `uuid16`. Every digest,
  fingerprint or commitment is `h32`. Remaining variable fields are
  `lp()`-prefixed with the per-field caps of §5/§7; lists are
  `u32be(count)` + elements. An absent optional `uuid16`/`h32` encodes as
  all-zero bytes of its fixed width; an absent `lp` field as `lp("")`.
- The **chain checkpoint** is `u64be(chain_index) || h32(chain_hash)` —
  `(0, 32 zero bytes)` until the channel has a transcript.
- 83-1 **exports** the private helpers from `spacekey.ts` (`writeU32BE`,
  `lengthPrefixed`, `concat`, `bytesEqual`, `utf8`) and adds `uuid16`;
  every canonical encoder in the repo uses them.

### Sign and verify behaviour

**Signing throws** on degenerate input; **verification never throws** and
returns a typed result on every path.

| Result | Meaning |
|---|---|
| `verified` | Signature valid against the pinned/verified key for the signed sender; every server-supplied outer field matches its signed inner counterpart |
| `mismatch` | Signature valid, but an outer field disagrees with a signed value — the server's framing is forged; the inner values are authoritative |
| `forged` | Signature invalid against our belief about the signed sender's key |
| `unpinned` | No local pin for the signed sender and the path may not fetch — decided later, not trusted now |
| `unsigned` | Suite-1 object — rendered unauthenticated, uniformly (§6) |

**On `mismatch`, the signed inner fields win, always.** **Content is
displayed even when attribution fails**, under an unmistakable warning —
attribution fails closed; availability does not.

## §4 — Deduplication and ordering: exactly what the client can prove

*(Resolved; unchanged.)*

**Sender side:** `client_msg_id` (fresh UUID, minted first in the send
flow), `sender_ts` (sender's clock), `writer_scope` (one scope per device
counter-store, never shared; a lost store mints a fresh scope, never
restarts an old one), `wseq` (strictly increasing per
`(channel, writer_scope)`, persisted sender-side; **an ordering claim
only** — no security warnings derive from it in this phase).

**Receiver side:** one bounded IndexedDB store (`idb.ts` takes its first
`DB_VERSION` bump since v4): **exact-identity dedup** — signed
`(sender_user_id, writer_scope, client_msg_id)` → first-seen `server_id`,
bounded LRU. The same triple under a different server row is a duplicate:
dropped and flagged. **Eviction produces "unknown", never "replay"**; no
arrival order, page order or gap is ever classified as suspicious by
itself.

**Rejected (recorded):** Option B, the client-minted message ID (the
partitioned `(ts, id)` PK cannot enforce global uniqueness, and without it
a hostile client gets an equivocation primitive); the scalar watermark
(misclassifies paginated history).

## §5 — Typed object protocols, and the storage that backs their claims

One envelope per object class; message semantics apply to nothing else —
voice signals (signed under `chalk-voice-fp.v1`), prefs blobs, the parking
lot and link previews (embedded in the body before encryption) keep their
shapes.

### The send-flow reorder (prerequisite)

```
mint client_msg_id
→ upload attachments (ids + ciphertext digests come back)
→ build envelope (all fields known) → sign → encrypt → send
```

The optimistic append moves with the mint. Guest sends in `GuestRoom.tsx`
get the same order.

### The signed content identity

A suite-2 object's durable identity is `(sender_user_id, writer_scope,
client_msg_id)` from its envelope. Edits, reactions and replies bind their
target by content identity plus an **envelope hash** — never by the server
row locator alone. Wire frames still carry `(channel_id, message_id, ts)`
for row lookup; those are receipt metadata. A **legacy suite-1 target** has
no content identity: the binding encodes as zero/empty fields and the
object renders with an unauthenticated-target mark — for replies exactly as
for edits and reactions.

### `0x01` — message

```
uuid16(channel_id) || u32be(key_version) || uuid16(sender_user_id)
|| uuid16(writer_scope) || uuid16(client_msg_id) || u64be(sender_ts)
|| u64be(wseq)
|| uuid16(par_sender) || uuid16(par_scope) || uuid16(par_client_msg_id)
|| h32(par_env_hash)                       // reply target: content identity
                                           //  + parent envelope hash; all
                                           //  zero when not a reply or the
                                           //  parent is legacy
|| u64be(chain_index) || h32(chain_hash)   // (0, zeros) pre-transcript
|| lp(utf8(body_text))                     // ≤ 65,536 bytes
|| u32be(att_count) || att_binding*        // ≤ 10 (the server cap)
```

Each `att_binding`:

```
uuid16(attachment_id) || u32be(att_key_version) || u64be(byte_len)
|| h32(sha256(full_ciphertext)) || h32(sha256(enc_meta))
|| h32(sha256(enc_preview))                // zeros when no preview
```

- **Replies:** the sender holds the decrypted parent envelope and signs its
  content identity *and* `par_env_hash = object_hash(parent)` (§3). `parent_id` rides only on
  the wire as an untrusted locator; `thread_id` remains receipt metadata. A
  server mapping one `parent_id` to different signed parents produces a
  visible `mismatch` for any client holding either parent. **A reply's
  `par_env_hash` may name a parent revision that has since been edited
  away**: the client matches it against the parent's current envelope and,
  failing that, its fetched revision ancestry (below); no match — withheld
  ancestry or beyond the cap — renders the threading unverified-target,
  never false trust.
- Attachment digests are over ciphertexts, verified before decryption on
  every fetch path. An attachment ref not covered by its parent's envelope
  renders unauthenticated.

### Revision ancestry: the storage model

Decided (scuq, 2026-08-07): **edits become append-only on the server.**
This reverses migration 0044's deliberate overwrite-no-revisions choice,
recorded here and in the 83-4 migration header: 0044 optimised for
simplicity when bodies carried no signatures; once an edit destroys signed
evidence, overwrite is incompatible with the guarantee.

**The server schema, frozen on server-visible locators only** (P83-R4-03 —
the server can derive neither content identities nor envelope hashes from
ciphertext, so it stores none):

```
message_revisions (
  message_ts  TIMESTAMPTZ NOT NULL,   -- the parent row's (ts, id) locator
  message_id  UUID        NOT NULL,
  rev_seq     INT         NOT NULL,   -- server-assigned arrival order;
                                      -- receipt metadata, untrusted
  body        TEXT        NOT NULL,   -- the replaced ciphertext, opaque
  key_version INT         NOT NULL,   -- the displaced body's AEAD context
                                      -- (P83-R5-02): the msgAAD binds it, so
                                      -- an archived ciphertext without it is
                                      -- undecryptable after a rotation —
                                      -- exactly as 0044's design note foresaw
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_ts, message_id, rev_seq)
)
```

- **The atomic edit transaction:** lock the message row (`FOR UPDATE`),
  `INSERT` the current **body and its `key_version` together** into
  `message_revisions` with `rev_seq = prior count + 1`, then
  `UPDATE messages SET body, key_version`. Concurrent edits serialize on the
  row lock; the moved pair is always exactly the one displaced. Deleting a message purges its revisions in the same
  transaction as the tombstone.
- **Revision cap:** the server refuses edits past
  `MAX_MESSAGE_REVISIONS = 64` per message (`edit_forbidden`) — the
  15-minute window bounds honest volume but not a malicious client's, so
  the cap is explicit.
- **No hashes cross the trust boundary:** the server stores and serves only
  ciphertexts and locators. Clients decrypt each revision, recompute every
  `object_hash`, and trust only what they recomputed. `fetch_revisions`
  (new frame, by message locator) returns each revision's ciphertext,
  **`key_version`** (bounds-checked: `1 ≤ v ≤` the channel's current
  version) and `rev_seq`.

**The chain root, fixed** (the fourth review's contradiction):

```
first_edit.prev_rev_hash = object_hash(original message artifact)
later_edit.prev_rev_hash = object_hash(previous edit artifact)
```

There is no empty-parent edit. The original message envelope is the root
node of the DAG; its `object_hash` is computed by any client that decrypts it
(current body, or the earliest revision row once edited).

**Per-object revision state, persisted client-side:** a bounded set of
verified nodes `rev_hash → prev_rev_hash` plus the current **heads**
(plural — a fork has two). Eviction returns classification to **unknown**.
The state machine, for an incoming verified revision `R`:

| Condition | Class | Action |
|---|---|---|
| `R.prev` is a current head | **extend** | advance that head |
| `R.prev` is a known non-head node with a different known child | **sibling fork** | keep both branches; surface "edited concurrently"; presentation order is the server's, labelled unauthenticated |
| `object_hash(R)` is a known ancestor of a current head | **stale** | superseded revision re-presented; cannot displace the head |
| `R.prev` matches no known node | **unknown** | fetch ancestry via `fetch_revisions`, verify, reclassify; if the server withholds it, render **unverified-target** and do not adopt as latest |

**Fresh-reader claim, backed by storage:** a fresh device fetches ancestry,
verifies every signature and link back to the original envelope, and proves
target binding, staleness and forks exactly as a long-lived device does.
Withheld ancestry degrades to unverified-target — visible, and failing
toward *less* trust.

### `0x02` — edit

```
uuid16(channel_id) || u32be(key_version) || uuid16(sender_user_id)
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(prev_rev_hash)                      // per the root rule above
|| u64be(sender_ts) || u64be(chain_index) || h32(chain_hash)
|| lp(utf8(body_text))                     // ≤ 65,536 bytes
|| u32be(att_count) || att_binding*        // re-stated from the original
```

Only the original sender may edit (server-enforced today; the signature now
enforces it — `sender_user_id` must equal `tgt_sender`). Attachment
bindings are re-stated so the current revision is self-sufficient without a
fetch. `message_edited` gains the editor's user ID (display convenience,
checked like any outer field).

### `0x03` — reaction set

```
uuid16(channel_id) || u32be(key_version) || uuid16(actor_user_id)
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(tgt_env_hash)
|| h32(prev_set_hash)                      // zeros for the actor's first set
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*        // ≤ 64 per set, ≤ 32 bytes each;
                                           // zero-count = cleared
```

- **Clearing stays a signed, sealed empty set** — the bare `body: ""`
  special case (which skips the key-version and ceiling checks server-side
  and produces an unauthenticated, unencrypted push) is retired; the server
  stores and pushes a clear as a normal value and its skip-the-checks
  branches are deleted.
- **Reactions get no server-side ancestry, and their guarantee is narrowed
  accordingly** (on the third review's own terms): one row per
  `(message, reactor)` as today; a client that observed a newer set refuses
  a stale one by local chain state; a **fresh device proves only that the
  actor signed the presented set for that target at the signed
  `sender_ts`** — not that it is the latest. Rationale: ephemeral,
  low-stakes emoji state; the honest narrow claim beats the storage cost.

### Guests

Guests derive a full Ed25519 identity from the link secret and can sign;
guest identities are served by `fetch_identity` since 80-9. Guests sign
like members; members verify a guest like any peer. A guest verifies
members best-effort with in-session TOFU pins (no durable pin store, no
phase-84 backup) — stated. Guest wrap handling under suite 3 is defined in
§7 (P83-R4-07).

### Previews (thread inbox, search, channel summaries)

Outer `sender` and `ts` are receipt metadata until the underlying row is
verified; a preview carries the same assurance mark as a full row.
`ThreadInboxEntry` gains the head and last-reply **message IDs** (the
server already holds `thread_activity.last_reply_id`).

## §6 — Migration, downgrade resistance, enforcement

- **All suite-1 content is one class: unauthenticated.** A quiet mark, no
  attribution checkmark, ever — identically in history, previews, search
  and live. No claim about *when* legacy content was written.
- **`CHALK_MSG_SIG_REQUIRED`** (the exact `CHALK_WRAP_SIG_REQUIRED` shape):
  server-side, `handleSend` / `handleEditMessage` / `handleSetReactions`
  reject suite-1 bodies by the leading byte; client-side, the one-way
  latch flags **live** suite-1 arrivals hard. Defaults off through the
  migration; flips on later (the 82-10 precedent). The per-`(channel,
  sender)` "seen signing" memo survives only as UI copy input.
- **Readiness** (pattern 82-9): `chalkctl msgsig status` by the leading
  suite byte, content-free; `enable` refuses while active senders still
  produce suite 1; `disable` exists.

**The threat-model staging table** — which claim moves at which point, and
*only* then:

| Ships | `threat-model.md` movement |
|---|---|
| 83-1 … 83-2 | Nothing. Helpers are not guarantees. |
| 83-3 … 83-5 (signed end-to-end, enforcement off) | Sender-authenticity gains a "partially deployed" paragraph; **status stays NOT met**. |
| 83-6 (enforcement) | Sender authenticity becomes **conditionally met** — user-authorship and relocation, where the flag is on, with §1's non-goals stated. Never unconditional. |
| Half B complete + enforced | The membership paragraph moves, **split three ways and view-scoped**: transcript-born dictator channels — met within each client's verified transcript view, removal confidentiality eventual, withheld-removal partition stated as the limit; converted channels — **per device, after that device verifies and persists migration adoption**, never global (§7); democratic tallies — accepted residual. Each under its enforcement condition. |

**Acceptance tests** — hostile-server / hostile-member cases in `*.test.ts`
against the real verify path, attacking with the *accepted* suite:

sender substitution; forgery by another key holder; a held message under a
new server id; LRU eviction never producing a replay claim; out-of-order
history producing zero warnings; re-dating skew; relocation across channel,
thread, parent, target; a reply whose `parent_id` row disagrees with the
signed parent identity/hash; a reply to an unheld parent; a reply naming an
edited-away parent revision (resolved via ancestry; unverified-target when
withheld); an older edit re-presented (stale); a sibling edit fork (both
kept, surfaced); ancestry withheld (unverified-target, not adopted);
a 65th edit refused; a stale reaction set vs an observing device; the
fresh-device reaction claim held to its narrow form; an attachment blob
swapped under a signed digest; a clear forged without the actor's key; an
edit targeting a legacy row; suite downgrade under a latched client;
`unpinned` never upgrading without a pin. For Half B: concurrent transcript
appends racing at one index; suppressed genesis against a holder of a
suite-3 wrap (fail closed); a suite-2 wrap presented for a transcript-born
channel (refused); **each suite-3 blob field mutated, truncated, duplicated
or relocated — including swapping epoch fields between two valid wraps**;
**a suite-3 wrap naming an uncommitted or re-indexed epoch event (refused;
rotation recovery re-publishes)**; **a withheld removal suffix — the stale
member's sends are refused only after the removal verifies, and the
threat-model limitation row covers the window**; a fabricated democratic
outcome vs retained lifecycle records; a unilateral event in
democratic replayed state; transcript fork at one index; rollback below a
held head; an unserveable checkpoint suffix; a wrap opening to a key
mismatching the epoch commitment; an addition wrapped before its admission
event exists; a send under a frozen epoch; creator offline across a removal
(frozen, no silent fallback); partial rotation at every interruption point
of §7's state machine; **crash/reload before and after every durable write
of the rotation and genesis machines; two creator devices racing different
keys for one version (one commits, the loser abandons its candidate and
adopts via the winner's self-wrap); a lost append ack (idempotent retry);
recovery of a committed epoch driven entirely from a second creator
device; an original plus edits spanning at least two key epochs, decrypted
and chain-verified by a fresh reader; cross-era guest-link substitutions
(a suite-2 blob under an era-3 link, a suite-3 blob under an era-2 link,
a 65-byte fragment with an unknown leading byte — all refused);
`object_hash` vectors (sender, object type, each target field and the
signature each perturbing the hash)**; a converted channel's fresh device
offered a retained suite-2 wrap plus a suppressed transcript (downgrade
succeeds — asserting the documented residual, and that the per-device
adoption ratchet prevents it on any device that ever adopted).

## §7 — Half B: the authenticated channel-state transcript

Membership becomes a hash-linked, signed event sequence replayed by every
member; key handling trusts the replayed state, not the roster. The suite-3
artifact is frozen (R4-01), rotation is committed-event-first with no
unrecoverable state (R4-02 + R5-01), the converted-channel claim is
per-device (R4-04), the canonical schema is complete (R4-05), removal
confidentiality is view-scoped (R4-06), and the guest rule — including the
era-3 fragment form (R5-03) — is defined.

### The event chain

```
event     = { channel_id, index, prev_hash, type, actor_user_id, details, sig }
canonical = utf8("chalk-chan-sig.v1") || u8(event_type)
            || uuid16(channel_id) || u64be(index) || h32(prev_hash)
            || uuid16(actor_user_id) || <details, exactly per the schema>
event_hash = SHA-256(canonical || lp(sig))
```

The server stores and relays events (one new table, `(channel_id, index)`
unique; append is **idempotent for an identical event** — same channel,
index and event_hash acks as success; a *different* event at a taken index
is the append race, and the loser refetches, verifies the new suffix, and
re-signs at the new head). The server can forge nothing; fork, rollback and
withholding are what the checkpoint rules detect, **eventually**.

### The frozen byte schema (R3-05 + R4-05)

Common rules: `uuid16` for every UUID-valued field; `h32` for every digest,
fingerprint and commitment — **exactly 32 bytes, fixed width, no length
prefix**; lists `u32be(count)` + elements sorted by `uuid16` bytes,
duplicates invalid; `lp` fields carry the explicit caps below; absent
optionals are all-zero fixed-width or `lp("")`.

Chain invariants: `genesis` / `genesis_migration` **must** have
`index = 0` and `prev_hash = 32 zero bytes`; every later event **must**
have `index = previous + 1` and `prev_hash = previous event_hash`;
`index < 2^63`. `key_epoch.under_*` **must name a committed prior entry:
`under_index < index`**, and `(under_index, under_event_hash)` must match
the chain at that position.

Enum tags (one byte each):

| Enum | Values |
|---|---|
| `event_type` | `0x01` genesis, `0x02` genesis_migration, `0x03` add_member, `0x04` remove_member, `0x05` self_leave, `0x06` set_mode, `0x07` key_epoch, `0x08` guest_grant, `0x09` guest_revoke |
| `role` | `0x00` member, `0x01` owner |
| `mode` | `0x00` dictator, `0x01` democratic |
| `chan_kind` | `0x00` group, `0x01` dm, `0x02` ephemeral |
| `auth_arm` | `0x00` unilateral, `0x01` governance (proposer), `0x02` governance (owner fallback) |

`member_entry` = `uuid16(user_id) || h32(ed25519_fp) || u8(role)`.

`gov_record` = `uuid16(proposal_id) || u8(proposal_type: 0x00 add_member,
0x01 remove_member, 0x02 set_mode) || uuid16(target_user_id; 16 zero bytes
for set_mode) || u8(mode_payload: 0x00 for set_mode→dictator, 0xFF
otherwise) || u32be(eligible) || u32be(yes) || u32be(no)
|| u32be(quorum_percent) || u32be(threshold_percent)`, with
`yes + no ≤ eligible`, every count `< 2^31`, percents `≤ 100`.

`details` per event type:

| Type | `details`, in exact order | Bounds / validation |
|---|---|---|
| `genesis` | `member_entry(creator) || u32be(n) || member_entry*(other initial members) || u8(mode) || u8(chan_kind) || u32be(key_version = 1) || h32(key_commitment)` | n ≤ 511; **the creator appears only in its dedicated slot and must not recur in the list**; the creator's role is `owner`; no other owner |
| `genesis_migration` | `u32be(n) || member_entry*(roster) || u8(mode) || u32be(key_version) || h32(key_commitment) || u8(prior_state = 0x00)` | n ≤ 512; exactly one owner; actor = that owner |
| `add_member` | `uuid16(target) || h32(target_ed25519_fp) || u8(role = 0x00) || u8(auth_arm) || gov_record?` | `gov_record` present iff `auth_arm ≠ 0x00`, with `proposal_type = 0x00` and matching target; target not in replayed membership |
| `remove_member` | `uuid16(target) || u8(auth_arm) || gov_record?` | target in replayed membership, not the owner; actor ≠ target; matching `gov_record` when governance |
| `self_leave` | *(empty)* | actor in replayed membership, not the owner |
| `set_mode` | `u8(old_mode) || u8(new_mode) || u8(auth_arm) || gov_record?` | old = replayed mode; →democratic: `auth_arm = 0x00`, actor = owner; →dictator: governance arm, `proposal_type = 0x02`, `mode_payload = 0x00`, supermajority threshold |
| `key_epoch` | `u32be(key_version) || h32(key_commitment) || u64be(under_index) || h32(under_event_hash)` | actor = creator; key_version = replayed version + 1; `under_index < index`, matching the chain |
| `guest_grant` | `uuid16(guest_user_id) || h32(guest_ed25519_fp) || h32(owner_ed25519_fp) || u64be(expiry_unix_ms) || u32be(key_version)` | actor = owner; expiry `< 2^63`; guest fp derivable by the owner at mint (the guest identity is a pure function of the link secret) |
| `guest_revoke` | `u64be(grant_index) || h32(grant_event_hash)` | actor = owner; names a real `guest_grant`, `grant_index < index` |

`key_commitment` = `SHA-256(utf8("chalk-key-commit.v1") || spaceKey)`.

The **state-transition function** — (replayed state × event) → new state or
`invalid`, `invalid` stopping the chain — is part of the spec, implemented
in 83-7 as a pure function; the authority checker, transition function and
signer all read the same decoded structures, and this table is the only
decoding.

### Authority, per event type and per governance mode

*(Corrected in the third revision against the verified product rules;
unchanged.)*

| Event | dictator mode | democratic mode |
|---|---|---|
| `genesis` / `genesis_migration` | creator / owner | creator / owner |
| `add_member` | any current transcript member | governance arm only |
| `remove_member` | owner (target never the owner) | governance arm only |
| `self_leave` | the member; never the owner | same — never proposal-gated |
| `set_mode` → democratic | owner, unilateral | — |
| `set_mode` → dictator | — | governance arm only (supermajority) |
| `key_epoch` | creator only | creator only |
| `guest_grant` / `guest_revoke` | owner only | owner only |

A unilateral `add_member` in replayed-democratic state is invalid; chain
stops.

**The democratic exclusion** *(R3-06, resolved; unchanged)*: ballots are
secret and unsigned by deliberate product choice (any verifiable quorum
certificate permanently reveals endorsers — recorded future hardening). A
democratic outcome is enacted by an event signed by the enacting proposer
(or the owner as the named fallback arm) binding the full `gov_record`.
Detection condition, stated exactly: **a client detects a fabricated
outcome only if it was connected during the relevant proposal lifecycle and
retained its observations** — clients persist observed proposal records
(id, type, target, final counts) in IndexedDB, and the transcript verifier
compares a governance-arm event's `gov_record` against the retained record;
contradictions surface as evidence. Offline members and fresh devices
detect nothing; a server can present a consistent fabricated lifecycle to a
partition it controls. **C-01 in democratic channels is an accepted
residual risk.** Enactment lag: the server executes immediately; the
transcript event waits for the enacting client; until it lands, the reshare
gate refuses the key to the newly added member.

### Wrap suite 3: the serialized artifact (P83-R4-01)

The signed message *and* the stored blob are both frozen. Suite 2's blob is
`sealed(92) || signerPub(32) || sig(64)` = 188 bytes; suite 3 inserts the
epoch reference between the signer key and the signature:

```
blob = sealed(92) || signerEd25519Pub(32)
    || u64be(epoch_index)(8) || epoch_event_hash(32)
    || sig(64)
     = 228 bytes, fixed           (WRAP_V3_BLOB_BYTES)

message = utf8("chalk-wrap-sig.v1") || u8(3) || u32be(keyVersion)
       || lp(channelID) || lp(recipientID) || lp(signerUserID) || lp(sealed)
       || u64be(epoch_index) || epoch_event_hash(32 raw)
```

- **The epoch fields live inside the blob** — the verifier parses them from
  the signed artifact at fixed offsets and reconstructs the canonical
  message from what the signer actually produced, never from a server
  frame. (An unsigned server-supplied epoch reference would let the server
  choose the message being verified — the exact failure the fourth review
  named.)
- **Rejection rules:** total length ≠ 228 → `null`; `epoch_index ≥ 2^63` →
  `null`; the hash is 32 bytes by construction of the layout. All before
  any crypto, as in `unwrapSpaceKeySigned`.
- `wrapSignerKey` keeps working across suites 2 and 3 — the signer key
  offset (92..124) is unchanged; it returns a claim, not a fact, as today.
  The suite registry (`describeSuites`), wrap/open dispatch,
  `maxWrapBlobBytes` and `checkWrapPublish`'s size rule all gain the
  suite-3 arm in the same slice.
- **Recipient rule — the complete acceptance predicate**, stated as one
  list so "verify through the named event" cannot be implemented as
  stopping at an old epoch that predates the recipient's own admission
  (a member wrap is adopted only when *all* hold, at the recipient's
  **full verified head**, not merely at the named epoch):
  1. the blob parses (exact length, bounds) and the signature verifies
     against the resolved signer's pinned key;
  2. the transcript is fetched and verified through the named
     `(epoch_index, epoch_event_hash)`;
  3. the epoch's `key_commitment` matches the unwrapped key;
  4. the replayed state contains the **recipient** as a current member;
  5. the replayed state contains the **signer** as a current member;
  6. no verified removal after the named epoch leaves the epoch **frozen**
     — the epoch is active in replayed state.

  Any failure → fail-closed `waiting`; with no transcript served, the same.
  The suite byte is inside the signed message, so the format is
  **cryptographically self-describing** — a legacy wrap is distinguishable
  by construction, not by any server-supplied flag.
- **Tests** (in §6's list): every field mutated, truncated, duplicated,
  relocated; epoch fields swapped between two otherwise-valid wraps; a
  wrap naming an uncommitted or re-indexed event.

### Rotation: committed-event-first, with no unrecoverable state (P83-R4-02 + P83-R5-01)

The fourth review showed wraps-first orphans every published wrap when the
`key_epoch` append loses its index race. The fifth review showed the naive
inversion is worse: an epoch whose commitment is committed while its
32-byte preimage lives only in one tab's volatile memory is **permanently
unfillable** — replay reveals the commitment, never the key. Both are
closed by one rule: **an epoch (or genesis) cannot exist without its key
being recoverable by the creator's account.**

1. The creator mints key `v+1` and its commitment, and **durably persists a
   pending-operation record — the key included — in the space-key
   IndexedDB cache before any network step.** A crash here is safe in both
   directions: nothing exists server-side, and on restart the pending op
   is either resumed or discarded (the key was never referenced).
2. **The append is atomic with a creator-self wrap.** The `key_epoch`
   append frame (and `create_channel`, for `genesis`) carries the
   creator's own suite-3 self-wrap for the new key, and the server commits
   event and wrap in one transaction. From the instant the epoch exists,
   its key is recoverable by **any device of the creator's account** —
   identity is per-user, so the shared X25519 private key opens the
   self-wrap. Volatile client state is never load-bearing after this
   point. (A duplicate retry of the identical event+wrap is idempotent
   success, per the append rule.)
3. **The race rule distinguishes who won.** Index taken by a *non-epoch*
   event: refetch, verify the new suffix, re-sign the same candidate at
   the new head, retry. Index taken by **another `key_epoch(v+1)` — a
   second device of the same creator racing its own rotation**: the loser
   **abandons its candidate entirely** — discards the pending op and its
   key, and adopts the winner's key from the winner's self-wrap (checking
   the commitment). Re-signing the losing candidate is invalid: replayed
   state is now at `v+1` and the schema requires the next epoch to be
   `v+2`. If a further rotation is genuinely still needed (the winning
   epoch's `under_*` head predates the removal that forced the freeze), a
   **fresh `v+2` rotation starts only after the winner's version advance
   commits** — the server's publish gate permits only `current + 1`.
4. The creator publishes suite-3 wraps for `v+1` to the post-change
   membership, each naming the committed `(index, event_hash)` —
   new-version slots are empty, so the upsert guard permits them.
5. Advances `current_key_version` (the existing `rotate_channel_key`
   frame; `stale_key_version` is already swallowed as success in the
   client's rotation path).
6. Clients unfreeze only when they hold the committed event **and** a key
   whose commitment matches it.

**Recovery, at every interruption point — by any device of the creator's
account, not only the one that started:** replayed state names exactly one
pending step, and the self-wrap supplies the key. Event committed / member
wraps missing → recover the key from the self-wrap, resume at step 4
(recipients stay fail-closed `waiting` meanwhile). Some recipients
wrapped → retry the missing slots (empty-slot inserts, always permitted).
Wraps complete / version not advanced → resume at step 5. Local pending op
lost at any point after step 2 → the self-wrap makes it moot. Duplicate
anything → idempotent. There is no state from which the protocol cannot
either finish or remain safely frozen, and no state whose completion
depends on a single device surviving.

**Genesis gets the same treatment**: `create_channel` carries the signed
`genesis` **and the creator's suite-3 self-wrap for key version 1** in one
request, committed in one server transaction — the creation-time key is
account-recoverable from the ack onward. A crash between the local mint
and the create request leaves nothing server-side; the pending op is
discarded.

### Genesis: downgrade-safe on both ends, with an honest converted-channel boundary

**Creator side** *(unchanged)*: the client mints the channel ID and submits
the signed `genesis` inside `create_channel` (plain unpartitioned UUID PK;
collision → re-mint; the pending-channel alternative stays rejected).
`genesis` commits to key version 1, so the creator mints the space key at
creation time; **the creator's suite-3 self-wrap rides the create request
and commits atomically with the genesis** (the R5-01 rule — see the
rotation section), and the other members' wraps are published after the
ack; `ensureChannelKeyInner`'s no-key-anywhere mint branch is superseded
for transcript channels. DM idempotency: the existing-DM short-circuit returns
the existing channel; the submitted ID, genesis and key are discarded. Old
clients omit both fields → legacy channel, inside the soft window; under
`CHALK_TRANSCRIPT_REQUIRED` the server rejects creates without a genesis.

**Recipient side** *(unchanged)*: honest members of a transcript channel
produce only suite-3 wraps, and the suite-3 recipient rule above makes a
fresh device either verify the transcript or refuse the key.
**Transcript-born channels are closed by construction** — every wrap that
has ever existed for them is suite 3 — subject only to §1's view-scoping.

**Converted channels: the per-device boundary (P83-R4-04).** The fourth
review demolished the "loud, not silent" claim, correctly: completeness is
a non-goal, so a malicious server holding a retained pre-migration suite-2
wrap can give a fresh device a fully *quiet* stale view — withhold the
transcript, report a stale key version, withhold all post-migration
traffic — and that device will open the old wrap, take the legacy path,
reshare to an injected principal, and send new messages readable by it.
Rotation cannot erase a wrap the server retained. The honest boundary,
chosen and stated:

- **Converted channels obtain transcript protection per device, from the
  moment that device verifies and persists the migration adoption**
  (the one-way adoption ratchet below). Before that moment, a fresh
  device is downgradeable, indefinitely — this is a standing
  post-migration confidentiality exposure for converted channels, named
  as such in the threat model, not a pre-migration-history footnote.
- **The full fresh-device guarantee is available only by recreating the
  conversation as a transcript-born channel.** The migration UI says so
  for channels that warrant it.
- **Hardening, honestly labelled best-effort:** the phase-84 pin-backup
  blob gains per-channel adoption markers (additive, merge-only, like the
  pins themselves), so a fresh device that restores its backup learns
  which channels have transcripts before the server can present them as
  legacy. The server can withhold the prefs blob, so this raises the cost
  of the attack and is *not* the boundary; the per-device rule above is.
  **Capacity semantics:** the markers ride phase 84's existing bounded blob
  (`BLOB_BUDGET_BYTES`, ~7900 bytes) at roughly 17 bytes each
  (`uuid16` + era flag). When the budget is tight, **pins always win** —
  they are the security record; markers are best-effort by definition —
  and omitted markers are reported through the same `PinSyncStatus`
  overflow surface phase 84 already has, so the user is told rather than
  silently uncovered.
- Completing a migration still **includes a rotation**
  (`genesis_migration` → committed-event-first rotation → suite-3 wraps at
  the new version): it moves honest members onto epoch-bound wraps and
  shrinks what the retained suite-2 wrap can open to pre-migration
  content — for *adopted* devices. The staging-table row for converted
  channels reads **per-device-after-adoption**, nothing stronger.

**The transcript-adoption ratchet** (client, IndexedDB, 82-5 pattern): once
a device holds a valid genesis or migration for a channel, it never again
treats that channel as legacy — permanently, regardless of flags.
Channels that cannot migrate stay scoped out: the lobby channel
(`created_by` NULL by design, no members) permanently; orphaned channels
(creator deleted — who also cannot rotate today) stay legacy, recommend
recreation.

**Admission binds the admitted key** *(unchanged)*: the authorizer resolves
the target's Ed25519 key at admission time and signs its fingerprint;
members converge on one admitted key; a later different key is the
changed-pin flow. TOFU's first fetch is not eliminated — the authorizer's
own pin may have been poisoned at first sight; divergent resolution after
admission is what this prevents.

### The epoch lifecycle (P83-R3-04 + P83-R4-06)

Per channel, replayed state carries an epoch status: **active** or
**frozen**.

- **Additions need no new epoch.** The epoch's `under_*` records where it
  was minted; authority to *distribute* it is the replayed current
  membership. A member added after the epoch receives the current key —
  but only after its `add_member` event is verified, and only while the
  epoch is active. Creator-offline is a non-event for additions.
- **A removal or self-leave freezes the epoch** the moment a client's
  replayed state applies it: on that client, sending, key adoption and
  resharing stop (compose disabled under a banner) until a `key_epoch`
  bound to a head at or after the removal is committed and its key
  verified against the commitment. Today's behaviour — traffic continuing
  under the old key with `rotation_pending` merely visible — is the hole;
  the freeze is the fix, availability cost stated.
- **Removal confidentiality is eventual and view-local (P83-R4-06).** The
  freeze binds a sender **once that sender has verified the removal**. A
  malicious server can withhold the removal suffix from a compliant
  member, whose verified view then honestly still authorizes the old
  epoch — that member keeps sending, and the server can route those
  ciphertexts to the removed key-holder. The stale member finds out when
  any newer checkpoint reaches it (a peer's envelope, a catch-up fetch);
  a permanently partitioned member never does, which is the same
  partition limit the fork rules already state. The claims everywhere in
  this doc are scoped accordingly: *continued sends are refused after the
  client verifies the removal* — never "impossible" in the abstract — and
  the threat model carries the withheld-removal window as an explicit
  limitation with its own acceptance test.
- **Creator offline across a removal ⇒ frozen until the creator returns**
  — matching the existing creator-only rotation model; the phase makes
  the wait safe instead of silently unsafe. Widening rotation authority
  is a rejected product change (creator-only is also what keeps
  `key_epoch` authority checkable).

### Checkpoints: fork, rollback, staleness *(R2-04, resolved; unchanged)*

The envelope carries `(chain_index, chain_hash)`. Receiver state machine
against the local verified head `L`:

| Comparison | Meaning | Action |
|---|---|---|
| equal index and hash | agreement | none |
| `P.index < L.index`, hash matches our chain there | peer older | none |
| `P.index < L.index`, hash does not match | **fork proof** | permanent evidence; surface like the identity-changed wall; freeze key ops |
| `P.index > L.index` | peer ahead | fetch `(L.index, P.index]`, verify, advance; unserveable → **stale** |
| equal index, different hash | **fork proof** | as above |
| no local transcript | unknown | legacy channel: ignore. Suite-3 wrap held or transcript-required: **stale** |

Rollback: any served prefix ending below `L` is refused. Freeze rules:
stale/forked ⇒ no key adoption, no resharing (messaging continues under a
banner — distinct from the epoch freeze, which stops sends). Resume: stale
clears when the suffix verifies; a proven fork never clears. Detection is
eventual; a perfect permanent partition is caught by neither side — what
the server can no longer do is heal one without the fork becoming
provable.

### Guests under suite 3 (P83-R4-07)

The fragment decides, exactly as 82-7 established — and the teeth stay in
*which primitive gets called*, so member wraps can never route through the
guest rule (the guest rule lives only in `openGuestWrap`, reached only
from a join fragment):

- **The fragment grows a third frozen form** (P83-R5-03 — the existing two
  shapes are distinguished by length alone and cannot express "requires
  suite 3"; deriving the requirement from server-supplied state would undo
  the fragment-decides downgrade property):

  ```
  secret(32)                              32 bytes → requires suite 1
  secret(32) || owner_pub(32)             64 bytes → requires suite 2
  0x03 || secret(32) || owner_pub(32)     65 bytes → requires suite 3
  ```

  `parseJoinFragment` accepts **exactly** these: length 32; length 64;
  length 65 with leading byte `0x03` (any other leading byte in a 65-byte
  fragment is rejected — the byte is the era marker and leaves room for
  future forms). The 32- and 64-byte forms parse byte-identically to
  today, so every existing link keeps working. Each accepted form maps to
  exactly one required wrap suite — both directions, as 82-7 established:
  a server can neither strip the epoch binding off an era-3 link's wrap
  nor bolt suite 3 onto an older link. Links minted on transcript channels
  emit the era-3 form. `buildJoinURL`, `GuestFragment`,
  `parseJoinFragment`, `openGuestWrap` and `JoinScreen` all change in the
  same slice; cross-era substitution tests (a suite-2 blob with an era-3
  link, a suite-3 blob with an era-2 link, unknown leading byte) are named
  in §6.
- On an era-3 link the guest parses the suite-3 blob and verifies the
  owner's signature **over the full canonical message, epoch fields
  included** — anchored on the fragment key, as today. The guest **does
  not verify the transcript behind the epoch reference** in v1: it has no
  pins, no transcript state, and its trust anchor is the member who handed
  it the link. Deliberate, stated; the epoch fields are still signed, so
  the guest's wrap cannot be re-pointed at a different epoch without
  breaking the signature it *does* check.
- `guest_grant` / `guest_revoke` authenticate guest admission *for
  members* (owner-only, per the authority table); members' own handling of
  guest wraps follows the member rules, never this section.

### Catch-up, multi-device

Offline catch-up is replay: fetch events past `L`, verify each (signature +
prev-hash + chain invariants + mode-dependent authority + state
transition), advance. Multi-device: each device replays independently and
keeps its own head; honest devices converge by construction (the phase-84
backup is deliberately unused for transcript state; its role is the
best-effort adoption markers above).

## §8 — Slices

**Gate 0 — independent protocol review of this sixth revision. Nothing
below starts before it passes.** Then, Half A first:

| Slice | Content |
|---|---|
| 83-1 | Export the canonical helpers from `spacekey.ts` (+ `uuid16`); `chalk-msg-sig.v1` typed encoders for objTypes 1–3; **`object_hash` with cross-object vectors and mutation tests**; sign (throws) and verify (total, typed result). Pure crypto. Tests modelled on 82-1's. |
| 83-2 | Public trusted-signer accessor on `ChannelCrypto`; the verify policy copied from `openWrap` including the offline warm path; the dedup, revision-DAG and lifecycle-record stores (idb version bump). |
| 83-3 | The `onSend` reorder; message envelope (`0x01`) with the signed parent binding; `CURRENT_MSG_SUITE = 2` + `describeSuites()` arm; plain sends signed and verified end to end, enforcement off. |
| 83-4 | Edits (`0x02`): the `message_revisions` migration (recording the 0044 reversal; the frozen schema — `key_version` archived with every row — and atomic edit transaction of §5; `MAX_MESSAGE_REVISIONS`), `fetch_revisions` (body + `key_version` + `rev_seq`), the revision state machine, the `message_edited` editor-ID field. Reactions (`0x03`): chained sets, the sealed signed clear, deletion of the skip-the-checks branches, the narrowed fresh-device claim in the UI. |
| 83-5 | Attachment digest verification on every fetch path; guest signing in `GuestRoom.tsx`; `ThreadInboxEntry` head/last-reply IDs and preview assurance marks. |
| 83-6 | Assurance UI (§3's five results on the `MemberTrust` vocabulary; uniform suite-1 rendering); `CHALK_MSG_SIG_REQUIRED` end to end; `chalkctl msgsig status/enable/disable`. Threat model moves per §6's staging table. |
| 83-7 … | Half B: the state-transition function (pure, event-list-in, §7's schema as its only decoding); event table + fetch/append frames with the idempotent-append rule — **the `key_epoch` append atomic with the creator self-wrap**; **wrap suite 3** — blob layout, registry, dispatch, size rules, the complete `openWrap` acceptance predicate, **the era-3 guest fragment** (`buildJoinURL` / `parseJoinFragment` / `openGuestWrap` / `JoinScreen`); `create_channel` wire change (client-minted ID + genesis **+ creator self-wrap**, creation-time key mint, durable pending op); **committed-event-first rotation** with its recovery table and losing-device rule; the epoch lifecycle (freeze/unfreeze, compose gating); client replay/verify + checkpoint heads; envelope checkpoint production and cross-attestation; the reshare/adoption gate + adoption ratchet + the pin-backup adoption markers; `genesis_migration` + migration-completes-with-rotation + the recreate-for-full-guarantee UI note; persisted proposal-lifecycle records + the `gov_record` comparison; `CHALK_TRANSCRIPT_REQUIRED`. Each slice names its threat-model movement. |

## Before this ships

Gate 0 sits before code, not before release — five paper reviews have each
caught blocking errors, which is the cheapest possible place to catch
them. Phase 81 gave the standing reason: a signature verified
inconsistently, or a transcript that does not actually bind membership,
produces the *appearance* of the guarantee, which is worse than the
current state, where `threat-model.md` says plainly that neither guarantee
is met.

`docs/threat-model.md` moves per §6's staging table and at no other time —
and when Half B's membership claim moves, it moves **split three ways and
view-scoped**: transcript-born dictator channels (met within each client's
verified view; removal confidentiality eventual; the withheld-removal
window stated), converted channels (per device, after adoption; recreation
for the full guarantee), democratic tallies (accepted residual) — each
under its enforcement condition.

Phase 88 (federation, declined) treats this phase as a hard prerequisite;
if federation is ever reconsidered it is gated on **both** halves,
enforced, not on Half A.

# Phase 83 — ALTERNATIVE: per-sender streams instead of a shared channel key

**Status: alternative proposal, not started, not reviewed.** This is a
competing design to `PHASE-83-MSGSIG.md` (sixth revision, Gate 0 pending),
written 7 August 2026 after a usability audit of that plan found three real
costs a user would feel. It is a *different architecture*, not a revision:
if it is chosen, the main plan's Half B is largely retired and its Half A is
kept with a simpler §4. The same Gate 0 applies — **independent protocol
review before any code** — and choosing between the two documents is itself
a decision that review should weigh in on.

**Tag:** `#msgsig`.

---

## Why this document exists

The sixth-revision plan is decision-complete and honest, but its shared-key
architecture forces three user-visible costs:

1. **The departure freeze.** One shared key per channel means a removal or
   voluntary leave compromises *the* key, and only the creator may rotate
   it — so every remaining member's composer locks until the creator's
   client acts. Creator online: seconds. Creator offline: the whole channel
   is mute for days. Creator deleted: frozen forever at the first
   departure.
2. **Sender-clock timestamps.** Demoting the server timestamp to receipt
   metadata makes the sender's own clock the displayed time; one skewed
   device shows wrong times to everyone.
3. **Retained edit history.** Proving what an edit replaced required an
   append-only `message_revisions` table — reversing 0044 and changing the
   folk expectation that editing replaces the old text.

All three follow from one architectural fact: **every member shares one
symmetric key, so any membership change is a channel-global cryptographic
event needing a single coordinator.** Remove that fact and the costs
dissolve rather than needing management.

## How everyone else solved this

This is not a novel idea — it is the industry-standard shape for group
E2EE, and the reason it is standard is exactly the coordination problem
chalk's shared key has:

- **Signal and WhatsApp — "Sender Keys."** Each member has their *own*
  outbound key per group: a random chain key (hash-ratcheted per message)
  plus a signature key, distributed to the other members over pairwise
  encrypted channels. Messages are encrypted under the sender's own chain
  and **signed by the sender's signature key** — authorship is structural.
  When a member leaves, *every remaining participant clears their own
  sender key and starts over*, unilaterally — there is no coordinator and
  nothing global to rotate, so nobody is ever locked out of sending.
- **Matrix — Megolm.** The same model under another name: a per-sender
  outbound session = hash ratchet + a per-session Ed25519 signing pair +
  a message index; recipients hold inbound sessions that decrypt and
  verify. On a membership change a client *invalidates its own outbound
  session* and re-keys on next send. The 2022 "Nebuchadnezzar" audit's
  core lesson is one chalk already learned in phase 82: never trust the
  server-supplied claim of whose session a key is — record the identity
  keys from the secure channel that shared it (chalk: `trust.ts` pins).
- **MLS (RFC 9420).** The IETF standard answer for *large* groups:
  TreeKEM gives O(log N) re-keying, and **any member can commit a
  removal** — the single-rotator bottleneck is designed out even in the
  heavyweight protocol. MLS is what chalk should reach for if rooms ever
  outgrow the O(N) model below; at chalk's mesh-voice-sized rooms it is
  machinery without a payoff.
- **Signal's Private Group System.** The cautionary half: *authenticated
  membership against the server* is a dedicated system of zero-knowledge
  credentials over encrypted member entries. Nobody gets cryptographic
  membership for free; the main plan's hash-chain transcript and this
  document's lighter certificates are both points on that curve, and both
  are honest only if they say what they don't prove.

## The architecture: per-sender streams

### Streams

Each **(member, device, channel)** has an outbound **stream**:

```
stream    = { stream_id (uuid), ck_0 (32 random bytes), i = 0 }
mk_i      = HKDF(ck_i, "chalk-stream-msg")     // per-message key
ck_{i+1}  = HKDF(ck_i, "chalk-stream-ck")      // one-way ratchet
```

A message is AES-256-GCM under `mk_i` with
AAD `chalk-stream-s{suite}:{channel}:{stream_id}:{i}`, and its plaintext is
the **same signed envelope as the main plan's §3/§5** — canonical
`uuid16`/`h32` encoding, `object_hash`, typed objects, sign-then-encrypt,
Ed25519 by the *user* identity (device attribution stays out, per P83-04).
Everything the main plan built for object typing, attachment digests, reply
binding and verification policy carries over unchanged.

The signature is what makes authorship hold — every recipient holds the
chain key and could compute `mk_i`, exactly as in Sender Keys, so the
envelope signature (verified against the stream owner's pinned identity)
remains the authenticity boundary. What the stream adds is **identity and
order for free**:

- `(stream_id, i)` replaces `(writer_scope, client_msg_id, wseq)` — the
  message identity *is* its stream position.
- One writer per stream, strictly increasing dense `i` ⇒ duplicate = index
  reuse (exact), ordering per device = total (exact), and a same-identity
  object under two server rows is caught by the index alone. The main
  plan's §4 dedup-LRU store and its "eviction becomes unknown" caveats
  shrink to a per-stream high-index and a small recent map.
- Gaps in a stream are *structurally meaningful* (an index that never
  appears was withheld, deleted, or not yet fetched) — claimed modestly:
  tombstones and retention make gaps legitimate, so a gap is a lead, not
  an alarm.

### Distribution: the phase-82 machinery, re-aimed

A **stream announcement** seals `{stream_id, ck_j, j}` to one recipient —
the existing signed-wrap construction almost verbatim: recipient-bound AAD,
canonical length-prefixed signed message under a new domain
(`chalk-stream-key.v1`), Ed25519 by the announcer, verified against pins
with `openWrap`'s exact acceptance policy (resolve → verify against *our
belief* → fail closed). Phase 82's code and its hard-won rules (verify-then-
decrypt, never-replace, downgrade ratchet) are the implementation.

The ratchet's one-wayness gives history scoping for free: announcing
`ck_0` grants the whole stream (chalk's current "new member reads history"
behaviour — the default); announcing the *current* `ck_i` grants
from-now-on only. That is a per-admission product option chalk never had.

### Membership changes — the usability fix

- **Removal or leave:** each remaining member, on learning of it,
  **unilaterally resets its own stream** — fresh `stream_id` + `ck`,
  announced to the remaining members only. Nobody coordinates, nobody
  waits, **the composer never locks**. Your future messages are protected
  the moment *your* client acts; an offline member's protection resumes at
  its next connect (rule: reconnect with a shrunk roster ⇒ reset before
  first send). The removed member's residual read window per sender is
  "until that sender resets" — seconds for online members — instead of the
  main plan's "the whole channel is frozen until the creator acts."
  **The creator has no cryptographic role at all.** Creator-offline and
  creator-deleted channels behave like any other.
- **Addition:** each member announces its stream to the new member as it
  comes online. The new member's view fills in per sender — messages from
  not-yet-announced senders show a per-message "waiting for X's key"
  instead of the channel-global waiting state. This is the model's one new
  visible seam, and it is small: members active enough to have recent
  messages are usually online to announce.

### Membership statements (the C-01 half, scoped honestly)

No hash chain, no genesis, no checkpoints, no epochs. Instead, **signed
membership certificates**, one per statement, unordered:

- `admission`: adder signs `(channel, target user, target Ed25519
  fingerprint, authority arm)` — the main plan's per-mode authority table
  and `gov_record` shape apply unchanged (democratic outcomes stay the
  accepted residual, ballots stay secret).
- `removal` / `leave`: the remover (per the same authority table) or the
  leaver signs the counterpart. Latest signed statement per user wins.

Clients announce streams **only to principals holding a valid admission
and no newer removal**, verified against pins. What this buys: **the
server cannot inject a member without a member's signature** — the C-01
auto-reshare attack dies, because there is no auto-reshare of anything a
server-edited roster can trigger. What it deliberately does not buy, said
plainly: no global consistency, no fork proofs, no rollback detection — a
server can withhold a removal certificate from one member or a fresh
device, and that victim's *own future stream* (only) is exposed to the
removed user until the certificate reaches it. The main plan's transcript
proves more (equivocation evidence, ordering) at the price of the freeze,
genesis, epochs and five reviews' worth of state machines; this buys the
core injection resistance at a fraction of the surface, with a smaller
blast radius per failure (one sender's stream, never the whole channel's
key).

Existing channels need **no migration ceremony**: members simply begin
streaming, and certificates are adopted lazily (each member signs
admissions for the roster it currently sees — per-sender TOFU, the same
honesty as `genesis_migration`, without the owner-only bottleneck or the
migration-plus-rotation choreography).

### The other two usability fixes

- **Timestamps: display stays the server's receipt time** — uniform,
  unchanged for users. The signed `sender_ts` still rides the envelope as
  the *authenticated* claim, surfaced in the message info affordance and
  as a skew flag. What is lost relative to the main plan: the displayed
  time remains server-asserted; re-dating is detectable on inspection, not
  prevented in the default view. A deliberate usability-over-purity trade,
  recorded.
- **Edits: 0044's overwrite stands; no `message_revisions` table.** Edits
  and reactions ride the sender's own stream, so per-device revision order
  is total by stream index and an old-edit replay is a lower index —
  stale by construction, no prev-hash chain, no ancestry fetch. The
  honest narrowing that buys: a fresh reader verifies an edit is
  sender-authored and correctly targeted, and *cannot* prove no newer
  edit was withheld (a stream gap may hint at it, no more). If the
  stronger fresh-reader claim is ever wanted, the revisions table is an
  orthogonal add-on — it is no longer load-bearing for the design.

## What this retires from the sixth-revision plan

| Sixth-revision construct | Fate here |
|---|---|
| Shared space key for new traffic; key versions; rotation | Retired (legacy history only) |
| Creator-only rotation; the departure **freeze**; frozen/active epochs | Gone — per-sender unilateral reset |
| `key_epoch`, key commitments, committed-event-first machine, self-wrap atomicity | Gone — no global key to commit |
| Genesis, client-minted channel IDs, `genesis_migration`, adoption ratchet, converted-channel boundary | Gone — lazy per-sender adoption; no creation-flow change |
| Hash-linked transcript, checkpoints `(chain_index, chain_hash)`, fork proofs | Replaced by unordered signed certificates (weaker, stated) |
| Wrap suite 3, epoch-bound blobs, era-3 guest fragment | Gone — announcements use the suite-2 construction under a new domain |
| §4 dedup LRU, `writer_scope`, `wseq`, eviction caveats | Replaced by exact `(stream_id, i)` identity and order |
| `message_revisions`, `fetch_revisions`, revision DAG, `MAX_MESSAGE_REVISIONS` | Not needed (optional strengthening only) |
| Enactment lag gate | Dissolves — progressive per-sender announcement |
| Sender-clock display change | Reverted — receipt time displayed, signed time inspectable |

Kept unchanged: the §3/§5 envelope (canonical encoding, `object_hash`,
typed objects, attachment digests, reply binding), the verification policy
and `MemberTrust` mapping, the uniform unauthenticated rendering of
legacy content, the enforcement-flag pattern, the democratic residual, the
TOFU limit, and all of phase 82's trust machinery.

## New costs, stated

- **O(N) announcements per sender per membership change** (O(N²) per event
  across the channel). Fine at chalk's mesh-voice-sized rooms; MLS/TreeKEM
  is the known upgrade path if rooms ever outgrow it (the same seam note
  as voice's SFU Slice I).
- **Per-sender waiting states** for newly admitted members while
  announcements trickle in — the one new visible seam.
- **More client state**: one stream per member-device per channel in
  IndexedDB, plus certificate storage. All small and bounded.
- **Same residual class as the main plan, smaller blast radius**: withheld
  certificates and partitioned views remain view-local, eventual-detection
  problems; each failure exposes one sender's stream, never a channel key.
- **A removed member keeps old history** it already had — identical to
  today and to the main plan (rotation never revoked the past either).

## Open questions for the review that gates this

1. Are unordered latest-wins certificates sufficient for chalk's threat
   model, or is the transcript's global consistency worth the freeze? (The
   central fork between the two documents.)
2. Stream reset triggers: exactly which roster observations force a reset
   before next send, and how a client that missed a removal entirely is
   bounded (certificate re-fetch on connect? peer hints in envelopes?).
3. Deletion tombstones vs stream-gap semantics — what a gap may honestly
   claim.
4. Attachments: per-stream `mk` or a per-attachment key wrapped in the
   envelope (upload-before-send ordering suggests the latter).
5. Guests: the owner announces on join and members follow — does the
   fragment anchor need to cover announcements, or does the guest's
   in-session pin of the owner suffice (as it does today for wraps)?
6. Whether the optional revisions table ships anyway for the stronger
   fresh-reader edit claim.

## Prior-art sources

- WhatsApp Encryption Overview (Sender Keys; reset on member leave):
  <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys overview: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay — *Analysis and Improvements of the Sender
  Keys Protocol for Group Messaging*:
  <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec (per-sender ratchet + Ed25519, invalidate on
  membership change):
  <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Matrix E2EE implementation guide (verify session keys from the secure
  channel, not the server):
  <https://matrix.org/docs/matrix-concepts/end-to-end-encryption/>
- Nebuchadnezzar — practically exploitable Matrix vulnerabilities (the
  don't-trust-server-labels lesson):
  <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420 (any-member removal commits; TreeKEM):
  <https://datatracker.ietf.org/doc/html/rfc9420>
- Chase, Perrin, Zaverucha — *The Signal Private Group System*
  (authenticated membership is its own system):
  <https://eprint.iacr.org/2019/1416.pdf>

## Verdict sought

This document asks one question of scuq and of the Gate-0 reviewer: given
that the sixth-revision plan is sound but pays for global membership
consistency with the departure freeze, the timestamp change and retained
edit history — is the industry-standard per-sender model, which dissolves
all three at the cost of weaker (certificate-based, view-local) membership
consistency, the better fit for chalk? If yes, this document becomes the
phase-83 plan and goes through the same independent review; if no, it
stays as the recorded road not taken, next to the main plan's other
rejected alternatives.

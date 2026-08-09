# Phase 98 — BIGROOMS: per-sender streams past the 64 cap

**Status: planned, not started — a sketch, not a frozen design.** Gated
twice: on phase 83 (envelope fanout, `PHASE-83-MSGSIG.md`) shipping through
Gate F, because this phase reuses its membership layer wholesale; and on an
independent Gate-0-style review of its own before any code. Written
2026-08-09, out of the question "can rotating the room key every Nth message
lift the 64-participant cap?" — the answer to that question is recorded
below as this phase's first rejected design.

**Tag:** `#bigrooms`.

---

## The problem

Envelope fanout's per-message cost is `63 + N×108` bytes and one DH+HMAC
per member (§A.8 of the phase-83 plan), and `MAX_FLAPS = 64` is frozen wire
format. The cap is not a performance ceiling — the sixth phase-83 review
settled that 64 is a non-issue (~6.8 KiB overhead per message) — it is a
scope decision, frozen in §A.9: *"larger rooms are out of scope by
construction — a different message layer, not a larger cap."*

This phase is that different message layer, sketched so the idea has a home
and a number. A larger room needs a per-message cost that is O(1) in room
size, paying O(N) only on membership change — the industry-standard shape
for which is per-sender keys (Signal/WhatsApp "Sender Keys", Matrix Megolm,
and at the heavyweight end MLS).

## Rejected on the way here: the rotating shared key (2026-08-09)

The proposal that prompted this doc: keep one shared room key as suite 1
has today, rotate it every 10th message — by whoever sends that message,
not the owner — and use phase 83's pairwise machinery only to distribute
the rotated key. Amortizing the fan-out over ten messages would make large
rooms cheap. Rejected on four grounds, recorded here the way phase 83's
decision section preserves its own rejected designs:

1. **It reopens the gap phase 83 exists to close.** Sender authenticity
   (`threat-model.md`, "Sender authenticity — NOT met") comes from a
   per-recipient MAC on *every* message. With MACs only on rotation
   messages, the other nine in ten are shared-key AEAD again: any member
   forges any other, the server relabels and replays. Authenticated key
   delivery, unauthenticated messages.
2. **Removal gets a disclosure window on a server-controlled clock.** A
   removed member reads until the next rotation, and "the 10th message" is
   counted in server-assigned ordering — the server chooses when rotation
   happens and who performs it. So removals need an immediate rotation
   anyway, which is "Option B — first-responder rotation", already rejected
   with the transcript design.
3. **A rotating shared key is shared mutable state.** Two senders hit
   message #10 concurrently, both mint key v+1, the server picks the winner
   by ordering — or serves different winners to different members:
   server-selected key authority, the C-01 class phases 82/83 removed. The
   transcript design spent six revisions on exactly this fork/freeze/commit
   machinery and never passed Gate 0; this variant puts it on a hot path.
4. **The insider blast radius grows ~10×.** Fanout's accepted residual
   (§A.8, no per-message roster commitment) lets a malicious sender
   partition the room's view of one message. A malicious rotator partitions
   every message until the next rotation.

And it does not actually lift the cap: the binding costs past 64 (below)
are in the membership layer, which amortized fan-out leaves untouched.

## Alice, Bob and Carol — the plain-language version

*(Explanatory only — nothing in this section is normative. This whole
phase is a sketch; the rules get frozen by its own Gate-0-style review,
and where this walkthrough and the sketch below disagree, neither wins —
the review does.)*

Alice, Bob and Carol share a big room — them and three hundred others.
Fanout would sew three hundred pouches onto every single message; here
the cost moves: each sender pays once to hand out a key chain, and
after that every message is one small box, the same size whether the
room holds three people or five hundred.

1. When Alice first sends, her client mints a random **chain key** —
   the first link of her personal **stream**. She seals a copy to each
   member individually, using the same pairwise machinery phase 83
   built: one sealed announcement for Bob, one for Carol, and so on
   down the roster. That is the expensive step, and it is paid per
   membership event, never per message.
2. To send "lunch?", her client turns the crank once: out fall a
   one-time **message key**, which locks this message, and the next
   link of the chain. One box, no pouches. Inside the box, the message
   carries Alice's **signature**, made with her identity key.
3. Bob's client holds Alice's chain, turns the same crank, gets the
   same message key, opens the box — and checks the signature. The
   signature is the proof of authorship here, not a per-person tag:
   everyone in the room can compute the message key, so *anyone
   holding the chain* could have made the box, but only Alice can make
   her signature.

That last point is the deliberate trade, in plain words: fanout's tag
proves "Alice or Bob wrote this" — Bob knows it was Alice, but he can
prove nothing to anyone else. A signature proves "Alice wrote this" to
*whoever is shown it*, forever. Deniability is given up, on purpose: a
room of five hundred is closer to a broadcast than a conversation, and
what a broadcast needs is exactly transferable authorship.

**When Carol is removed**, nobody rotates a shared room key, because
there isn't one — there are three hundred personal chains:

- **Each remaining member resets their own stream.** Alice mints a
  fresh chain key and announces it to everyone still in the room —
  everyone except Carol. So does Bob, and so does everyone else, each
  on their own, the next time they send. No coordinator, no ceremony,
  no frozen channel. Carol keeps every old chain key forever, but they
  open nothing minted after the reset.
- **The door is still checked.** Membership is phase 83's layer,
  reused verbatim: the signed anchor, the policy chain, the per-member
  certificate chains. If Carol — with a malicious server's help —
  mails the room a validly-signed message anyway, each client checks
  her chain, sees it ends in "removed", and refuses it under the same
  acceptance rule fanout uses.

**When Dave joins**, history scoping falls out of where you start the
chain: hand him Alice's chain from its first link and he can read her
stream from the beginning; hand him only the current link and he reads
from now on. Per-admission history is a property of the announcement,
not a separate grant machine.

And the seam this design shows honestly: until Alice's announcement
reaches Bob, Bob cannot read *Alice's* messages — everyone else's
remain fine. The waiting state is per-sender ("waiting for Alice's
key"), never channel-wide, and the review has to decide what that UI
says — the cost section below already names it as the seam that needs
one.

## The sketch: per-sender streams on phase 83's membership layer

The direct ancestor is the superseded per-sender-streams draft
(`git show fd9d0b6:docs/phases/PHASE-83-MSGSIG-ALTERNATIVE.md`, 2026-08-07)
— rejected *for phase 83* as non-deniable and heavier than fanout, which
was the right call at ≤ 64. This phase resurrects its stream mechanics,
replaces its deliberately weak unordered-certificate membership with
phase 83's §A.4 machinery, and scopes it to rooms past the cap.

- **Membership: §A.4 verbatim.** Authority anchor, policy chain, per-target
  certificate chains, rollback and omit latches, and §A.5's
  sender-acceptance rule are reused unchanged — the layer is shared between
  the two message formats and nothing new needs review there. Stream
  announcements are emitted only to principals passing the same checks
  that gate flap emission.
- **Message layer (suite 3):** each (member, channel) has an outbound
  **stream** — a random 32-byte chain key, hash-ratcheted per message
  (`mk_i = HKDF(ck_i, msg-domain)`, `ck_{i+1} = HKDF(ck_i, ck-domain)`),
  AES-256-GCM under `mk_i`, stream id and index in the AAD. The plaintext
  is the canonical envelope **signed by the sender's Ed25519 identity**:
  every stream holder can compute `mk_i`, so the signature — verified
  against the pinned identity — is the authenticity boundary, and
  `(stream_id, i)` gives exact message identity and per-sender order.
- **Distribution:** a stream announcement seals `{stream_id, ck_j, j}` to
  one recipient over the phase-82/83 pairwise wrap machinery under a new
  domain string — verify-then-decrypt, pins, fail closed, all inherited.
  O(N) announcements per sender per membership event, O(1) per message.
- **Membership change: unilateral own-stream reset.** On observing a
  removal or leave, each remaining member resets its own stream — fresh
  id and chain key, announced to the remaining roster. No coordinator, no
  freeze, no ceremony: fanout's core usability principle, kept. Announcing
  `ck_0` grants the stream's whole history; announcing the current `ck_i`
  grants from-now-on only — a per-admission history scoping fanout's
  grants provide by other means.

**The deliberate trade, stated plainly: deniability is lost.** A signed
envelope is transferable proof of authorship — the exact property fanout's
"authenticated for you" MACs refuse to create. That is why fanout stays
the one and only layer for rooms of ≤ 64: a room big enough to need this
layer is closer to a broadcast than a conversation, and the trade reads
differently there. Big rooms are therefore a **distinct channel kind,
chosen at creation** — a fanout channel that reaches its cap is never
silently upgraded, and nothing here amends fanout's wire or semantics.

## The cap, and where the real costs live

Proposed bound: **512** (to be confirmed at review — it should fall out of
the measured costs, not be picked round). The costs that actually bind,
none of which per-message amortization touches:

- **Announcement fan-out**: O(N) sealed announcements per sender per
  membership event — at 512, a join burst is real traffic, and the
  "waiting for X's key" seam (per-sender, not channel-global) needs UI.
- **Certificate chains**: a joiner fetches and verifies N chains against
  the anchor; incremental verification and caching become load-bearing
  rather than nice.
- **Pin capacity**: the pin blob holds ~60 pins, so at 512 the
  members-beyond-the-blob state — today a stated TOFU residual on a fresh
  device — is the common case and needs a designed answer, not a residual.
- **History at scale**: grantor-attested grants (§A.6) are per-grantee;
  what auto-grant means when 500 people can join needs its own decision.

## Open questions for scuq and the gating review

Carried and adapted from the fd9d0b6 draft, plus this phase's own:

1. Reset triggers: exactly which roster observations force an own-stream
   reset before next send, and how a client that missed a removal entirely
   is bounded.
2. Stream-gap semantics vs deletion tombstones — what a gap may honestly
   claim.
3. Attachments: per-attachment keys inside the envelope (upload-before-send
   ordering suggests it) or per-stream keys.
4. Guests: admitted to big rooms under the same stream model, or excluded
   outright at this scale.
5. The pin-capacity answer at 512 (a bigger blob? per-channel pin pages?
   accept unpinned-with-label?).
6. Do `former-member` / `unauthorized-sender` and the live/backfill
   boundary port unchanged from §A.5, or does backfill at this scale need
   its own rules?
7. Whether 512 is the right bound, and what measurement decides it.

## Non-interaction with phase 83

`PHASE-83-MSGSIG.md` is not edited by this phase's planning: Gate 0 has
passed there, and any normative change reopens it. §A.9's frozen scale
sentence — larger rooms are out of scope *by construction* — remains true
until this phase ships; amending it, and the threat model with it, is this
phase's own final slice when it is built.

## Prior-art sources

- WhatsApp Encryption Overview (Sender Keys; reset on member leave):
  <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
- Sender Keys overview: <https://en.wikipedia.org/wiki/Sender_Keys>
- Balbás, Collins, Vaudenay — *Analysis and Improvements of the Sender
  Keys Protocol for Group Messaging*: <https://arxiv.org/pdf/2301.07045>
- Matrix Megolm spec (per-sender ratchet, invalidate on membership change):
  <https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md>
- Nebuchadnezzar — practically exploitable Matrix vulnerabilities (the
  don't-trust-server-labels lesson): <https://nebuchadnezzar-megolm.github.io/>
- MLS, RFC 9420 (TreeKEM, O(log N) — the known upgrade path if 512 is ever
  outgrown): <https://datatracker.ietf.org/doc/html/rfc9420>
- Chase, Perrin, Zaverucha — *The Signal Private Group System*:
  <https://eprint.iacr.org/2019/1416.pdf>

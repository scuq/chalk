# Phase 83 — signed message envelopes and an authenticated channel-state transcript

The two cryptographic findings phase 81 confirmed and deliberately deferred, and
the one the 2026-08-05 audit follow-up put at the top of its remaining-work
list. **NOT IMPLEMENTED — no code exists.** This document is the plan and
nothing below it has been built.

**Status:** design only, written 6 August 2026 from the phase-81 analysis, the
phase-82 record, and a fresh read of the code the work has to touch. It replaces
the three paragraphs the design used to be scattered across
(`PHASE-81-SECAUDIT.md` *Deliberately open*, `threat-model.md`'s two unmet
guarantees, and phase 82's *Out of scope*), which now point here.

**Tag:** `#msgsig` → `tools/where.sh -g msgsig` (which today finds this file and
nothing else, because there is nothing else).

**Depends on phase 82.** The expensive half of both findings — an identity
anchor a signature can be checked against — was already paid for there:
`web/src/crypto/trust.ts` pins peer Ed25519 keys, and `channel-crypto.ts`
already verifies-then-decrypts against a pinned signer. This phase spends that
anchor twice more.

---

## The two problems

### H-01 — messages carry no sender signature

The AEAD associated data on a message is `msgAAD`
(`web/src/crypto/spacekey.ts`): `chalk-msg-s{suite}:{channelID}:{keyVersion}`
and nothing else. Sender, device, message ID, timestamp, thread and parent are
plaintext metadata the server attaches *outside* what is authenticated.

Two consequences, both live today:

- A server can replay a ciphertext under a different sender, timestamp or
  thread and decryption still succeeds. The recipient sees a message that never
  existed, attributed to someone who never sent it.
- Every member holds the same symmetric key, so ciphertext alone never proves
  which member authored anything. A key holder can forge a message from any
  other member without the server's help at all.

The same applies to everything whose meaning depends on server-supplied
context: edits, reactions and attachment references.

### C-01's residue — membership is server-asserted

Phase 82 made a wrap prove *who sent a key*. It cannot prove *who deserved
one*. The candidate list `openWrap` verifies against
(`web/src/crypto/channel-crypto.ts`) comes straight from the server's roster,
and an honest client auto-reshares the channel key to whoever appears in it. A
server that adds a principal it controls is handed the key by a legitimate
member.

82-8 makes this visible — a join notice above the composer, a provenance line
in the members panel — which is worth having and is not a fix. Only an
authenticated transcript of channel state prevents it.

---

## The central constraint

**The server mints both the message ID and the timestamp.** `handleSend`
(`internal/server/ws.go`) allocates `uuid.New()` and takes `ts` from the
`INSERT ... RETURNING`; the client only learns them on the send-ack. So a
signature produced at send time *cannot* cover the two fields an attacker would
most like to move.

This is the design's first fork, and it must be settled before anything else:

**Option A — sign what the sender knows.** The envelope covers channel ID, key
version, sender user + device, `client_msg_id`, parent/thread, and a hash of
the plaintext. Server-minted `id` and `ts` stay unauthenticated; the client
binds them on receipt by refusing a message whose signed `client_msg_id` it has
already seen under a different server ID. Cheap, no wire or schema change to
the send path, and it closes authorship forgery completely. It does *not* stop
a server from re-dating a genuine message or moving it between threads that the
sender did not name.

**Option B — the client mints the message ID.** `client_msg_id` becomes the
message ID, so the signature covers identity. `ts` remains server-supplied but
is now bound to a unique signed ID, which makes a replay under a new timestamp
detectable as a duplicate. Costs a server change to accept a client-supplied
PK, a uniqueness story for hostile clients, and a migration for the partitioned
`messages` table's `(ts, id)` primary key.

**Recommendation: A, with B written down as the follow-on.** A closes the
finding as stated — "any key holder can be impersonated" — without a schema
migration, and the residual (re-dating and thread-moving by a hostile server)
is a strictly smaller claim that the transcript work below partly covers
anyway. Whichever is chosen, record the rejected one here; a later reader will
otherwise re-derive this fork from scratch.

## Where the signature lives: inside the ciphertext, not beside it

No schema change. Two precedents in the repo agree:

- Phase 82 put the wrap signature inside the opaque `wrap_blob` — no
  `channel_keys` column was added.
- `web/src/voice/signal-crypto.ts` puts `fp_sig` inside the encrypted
  `SdpSignal`, not alongside the envelope.

So the message envelope is a field of the plaintext structure that gets
encrypted, and `decryptMessage` yields it. A server never sees the signature,
cannot strip it without breaking the AEAD, and needs no new column to store it.

Recorded for completeness, because someone will ask: `messages.meta JSONB`
(`migrations/0003_messages.sql`) exists and is entirely unused — the only
reference in Go is a literal `'{}'::jsonb` in the test-only `InsertMessage`, and
production `INSERT` does not list it. And adding a column to the partitioned
table has an established recipe (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
inside a transaction — see `0032`, `0035`, `0044`). Neither is needed if the
envelope rides inside the ciphertext, and the inside-the-ciphertext version is
better: it cannot be stripped.

## What to copy

`web/src/voice/signal-crypto.ts` does this correctly already and CLAUDE.md
names it as the model: canonical encode → Ed25519 sign → fail-closed verify,
with every failure path returning `false` rather than throwing, and the caller
aborting.

One caveat it does *not* have: `canonicalFingerprintMessage` joins fields with
newlines and is injective only because every field is newline-free. A message
envelope carries binary (a ciphertext hash), so it must use the
length-prefixed form phase 82 already chose — `canonicalWrapMessage`
(`spacekey.ts`) with `lp(x) = u32be(len) || x` and a domain string.

`canonicalWrapMessage` itself is wrap-shaped (it takes a `WrapSlot`) and is not
directly reusable. Its private helpers are: `writeU32BE`, `lengthPrefixed`,
`concat`, `bytesEqual`, `utf8`. Export those rather than restating them — two
canonical encoders that drift apart is the failure mode this phase exists to
avoid. The domain string is `chalk-msg-sig.v1`, alongside `chalk-wrap-sig.v1`.

`WrapSigner` (`spacekey.ts`) is the ready-made signer-identity shape and
`ChannelCrypto` already holds one.

## What a verifier calls

`trust.resolveSigner(candidateEd25519Pub, userIDs)` answers "whose key is
this?" from local pins only, and `trust.fetchTrustedIdentity` is the network
path that TOFU-pins on first sight. `channel-crypto.ts`'s `openWrap` is the
acceptance-policy model to copy: claimed key → self-check → resolve against
pins → fetch only if allowed → verify against *our belief* about the user ID,
never a claim inside the blob.

Note that `openWrap`, `adopt` and `identity` are all `private` on
`ChannelCrypto`, and there is no public "give me the trusted Ed25519 key for
user X". A message verifier needs one, or calls `trust.ts` directly.

## Blast radius

Enumerated so a slice plan can be costed rather than guessed at.

**None of `ChannelCrypto`'s seven crypto wrappers takes a sender, message ID or
timestamp** (`encryptForChannel`, `sealJSONForChannel`, `encryptBytesForChannel`,
`encryptBytesAtVersion`, and the three read halves). Every one needs a context
parameter, and that is the bulk of the mechanical work.

Senders, with what is available at each:

| Site | Has |
|---|---|
| `App.tsx` plain send | channel, own user, parent/thread, `client_msg_id` — **no** message ID or ts (server-minted) |
| `App.tsx` edit | channel, message ID, ts, own user — the full triple |
| `App.tsx` reactions | channel, message ID, ts, own user — the full triple |
| `attachments/pipeline.ts` | channel, device, attachment ID **after** `initUpload` — no message ID; the upload precedes the message |
| `GuestRoom.tsx` | channel, key version, and a `DerivedIdentity` with `ed25519Private` — guests *can* sign |

Receivers get the full metadata set on the live push and on history/thread/
search batches. Two wire gaps to close: `MessageEditedPayload` (`web/src/proto.ts`)
carries no editor user ID, and thread-inbox previews carry no message ID for the
head or the last reply. Both are needed for a verifier to have something to
check against.

Not separately encrypted, so no envelope surface of their own: link previews
(embedded in the body before encryption), the parking lot (UI state), the voice
scratchpad, and ephemeral guest rooms (which use `encryptMessage` directly).

Suite bump: `CURRENT_MSG_SUITE` 1 → 2 needs a matching arm in `describeSuites()`
or the tooltip drifts — there is a test for exactly that in `spacekey.test.ts`.

## Half B — the authenticated channel-state transcript

Less worked out than half A, deliberately: it is the harder half and should not
be designed inside a document that also has to be actionable for half A.

The shape it has to take: membership changes become a hash-linked, signed
sequence rather than rows the server can add to. Each admission is signed by
someone already authorised, every member replays the chain from a known root,
and `openWrap`'s candidate list comes from the replayed state rather than the
server's roster. A server that inserts a principal produces a chain that does
not verify, and the auto-reshare never happens.

The open questions to answer before slicing it: what the root of trust is for a
channel created before the transcript existed; who may admit (chalk has
governance, so this is not simply "the creator"); how a client that has been
offline across a rotation catches up; and what happens when the chain and the
server's roster disagree — refuse, or show the roster and refuse the *key*.

## Slices

None started. A plausible order, half A first because it is self-contained:

| Slice | Content |
|---|---|
| 83-1 | Export the canonical-encoding helpers from `spacekey.ts`; add `chalk-msg-sig.v1`, the canonical message, sign and fail-closed verify. Pure crypto, nothing produces it yet. Tests modelled on 82-1's. |
| 83-2 | A public trusted-signer accessor on `ChannelCrypto`; the verify policy, copied from `openWrap` including the offline warm path. |
| 83-3 | The envelope inside the plaintext; `CURRENT_MSG_SUITE = 2`; `describeSuites()` arm; plain sends signed and verified end to end. |
| 83-4 | Edits and reactions, plus the `MessageEditedPayload` editor-ID wire gap. |
| 83-5 | Attachment references and the guest path. |
| 83-6 | What an unverified message looks like in the UI, and the enforcement flag — the same shape as `CHALK_WRAP_SIG_REQUIRED`, defaulting off through the migration and on afterwards (82-10 is the precedent for how that default eventually moves). |
| 83-7 … | Half B, the transcript. Its own slice plan once its open questions are settled. |

## Before this ships

The audit asks for an **independent protocol review** of this phase before
release, and phase 81 gave the reason: a half-fix here is worse than none. A
signature verified inconsistently, or a transcript that does not actually bind
membership changes, produces the *appearance* of the guarantee — which is worse
than the current state, where `threat-model.md` says plainly that neither
guarantee is met.

Two documents must move in the same change set as the first shipping slice:
`docs/threat-model.md`'s *Sender authenticity — NOT met* section, and its
membership paragraph under malicious-server confidentiality.

Phase 88 (federation, declined) treats this phase as a hard prerequisite; if
federation is ever reconsidered, it is gated on both halves, not just half A.

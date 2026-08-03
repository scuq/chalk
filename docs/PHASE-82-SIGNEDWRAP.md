# Phase 82 — Signed channel-key wraps

Closing audit finding **C-01 (Critical)**: channel-key wraps are encrypted *to* a
recipient but signed by nobody, so a malicious server can substitute a space key
it knows. Planned against v0.6.4, after phase 81.

**Status: in progress.** Slices 82-1 … 82-6 are implemented; 82-7 … 82-8 are
not. C-01 is closed **on deployments that have flipped the enforcement flag**
— see *Where this actually stands* below, which is deliberately placed before
the design so it cannot be skimmed past.

---

## Where this actually stands

| | |
|---|---|
| Closed today | Substitution at the **bootstrap read-back**, for both signed and unsigned wraps. This is the audit's worst case — the one where the legitimate creator redistributes the attacker's key to the whole channel. |
| Closed today | Any suite-2 wrap signed by an identity this device has not pinned. |
| Closed by 82-5 | Every wrap chalk produces for a member is now signed, so on any channel where the members run current builds, one signed adoption **ratchets** the channel: an unsigned wrap for it is refused thereafter, at any key version. |
| Closed by 82-6 | Silent overwrite of another member's wrap slot (the store's guarded upsert), wraps parked at arbitrary future key versions, and unbounded wrap blobs. The **self-healing sweep** upgrades legacy unsigned wraps to signed ones as channels get used — no member action needed. |
| Closed **when the operator flips `CHALK_WRAP_SIG_REQUIRED`** | Unsigned wraps entirely: the server refuses them on publish, the client refuses them on read (latched per session — a later welcome cannot relax it). An un-swept member shows `waiting` and recovers via a holder's re-share. |
| **Still open by default** | On a deployment with the flag off (the shipped default), an unsigned wrap on a channel that has never yielded a signed one is still accepted — the migration window, which the sweep drains and the flag ends. |
| Still open | Membership is server-asserted, so a server that can add a member it controls can still get a key it knows distributed. Phase 83. |
| Still open | Guest wraps (the ephemeral mint) are unsigned and deliberately exempt from the flag until 82-7 gives the guest an anchor to verify against. |

The migration story, in one line: **ship 82-6, let the sweep run, flip
`CHALK_WRAP_SIG_REQUIRED=true`, and C-01 is closed for member wraps.** The
flag defaults false because flipping it before the sweep has re-signed a
channel's wraps strands every member still on an unsigned one.

---

## The problem

Producing a suite-1 wrap needs only the recipient's **public** X25519 key, and
the server stores those. So the server can generate a space key of its own,
seal it correctly for any member, and have it accepted — the sealed box is
perfectly valid, because validity was never the property in question.

The sharpest path is channel bootstrap (`web/src/crypto/channel-crypto.ts`):

1. the creator mints a key and publishes a wrap to its own `channel_keys` row;
2. it reads that row back, to converge with a concurrent bootstrap on another
   of its own devices;
3. it adopts **whatever decrypts**;
4. it then hands that key to every member via `rewrapForMissing`.

One injected frame at step 2 compromises the channel, with the legitimate
creator as the delivery mechanism.

## Two corrections to the audit's prescription

The audit says: *"a signed wrap envelope … That needs a `wrapper_id`/`wrap_sig`
column, wire-frame fields, and negative tests."*

### 1. The signature belongs in the blob, not in columns

`wrap_suite` + an opaque `wrap_blob` already flow end-to-end through all five
surfaces that carry a wrap: the `publish_channel_key` / `fetch_channel_key`
frames, `channel_keys`, `ephemeral_invite_mint`, the `ephemeral_invites` →
`channel_keys` copy at redemption, and the `POST /api/join/{lookup}` body.

So suite 2 needs **no migration, no wire change, and no server change** to
carry. Columns would need all five plus their client mirrors — five places to
forget one.

`docs/design/crypto-agility.md` also forbids the column form outright ("keep
`wrap_blob` opaque and suite-defined; do not re-introduce fixed per-curve
columns"), and it is right to: a fixed `wrap_sig BYTEA` is the wrong shape the
moment a suite authenticates differently — an ML-DSA signature is 2.4–4.6 KB.

The cost, accepted: the server cannot index by signer or reject a bogus wrap
early. Both are fine. A blind relay verifying signatures would have to decide
whose key is whose, and it *is* the adversary in this model — its verdict is
worthless and would manufacture false confidence.

### 2. The audit omits the load-bearing half: identity anchoring

A signature is only worth what the answer to *"which Ed25519 key is Bob's?"* is
worth. Before this phase that answer came from `fetchIdentity`, which:

- returned `userID: ack.user_id` — **the server's own echo**; and
- verified only `self_sig`, which is `Ed25519(x25519_pub)` and covers neither
  the user id nor the generation (`migrations/0031_identity_keys.sql`).

So a malicious server mints a keypair, computes a perfectly valid self
signature, serves it under Bob's id, signs the wrap with it, and every check the
audit proposes passes.

**Binding `user_id` into `self_sig` does not help.** A self-signature is
self-asserted: the attacker picks both the key and the claimed id. The only
sound anchors are trust-on-first-use and the existing out-of-band picture-word
comparison. Anchoring is roughly 60% of this phase's real work, and a phase that
shipped signed wraps without it would be precisely the "appearance of the
guarantee" the audit warned about.

## Design

### Wrap suite 2

```
WRAP_SUITE_X25519_AESGCM_ED25519 = 2

blob = ephemeralPub(32) || nonce(12) || wrapped(48) || signerEd25519Pub(32) || sig(64)
     = 188 bytes, fixed width
```

The leading 92 bytes are a byte-identical suite-1 sealed box, so `openBox` is
shared between suites rather than restated — the primitive does not need
re-review. `sealBox`/`openBox` take the suite as a parameter, and it reaches
only the AAD, which is what stops a sealed box made under one suite being
reinterpreted under another.

**The blob carries the signer's raw Ed25519 public key, not a user id.** That
keeps verification a pure function and forces the caller to supply the key it
already trusts. The trust decision becomes a mandatory argument: there is no way
to open a signed wrap without having first made one.

The signer's *user id* is bound inside the signed message but travels
out-of-band — the verifier supplies **its own belief** about whose key this is,
resolved from local pins. A server that re-labels who a key came from therefore
produces a verification failure rather than an acceptance, and no claim has to
be transported.

### The canonical signed message — `chalk-wrap-sig.v1`

```
lp(x)   = u32be(len(x)) || x
message = utf8("chalk-wrap-sig.v1") || u8(suite) || u32be(keyVersion)
       || lp(channelID) || lp(recipientID) || lp(signerUserID) || lp(sealed)
```

Injective: the domain prefix is a fixed-length constant, suite and keyVersion
are fixed width, and every remaining field carries its own length, so a
left-to-right parse recovers the boundaries from the byte string alone.

This deliberately does **not** copy `voice/signal-crypto.ts`'s newline join.
That encoding is injective only because every field there is newline-free;
`sealed` is ciphertext and contains `0x0A` about a third of the time. There is a
test (`canonical message is injective across field boundaries`) that newline
joining would fail.

Signed over the **sealed bytes**, not the space key — signing the plaintext key
would let anyone who ever held it re-attribute someone else's wrap.
**Verify-then-decrypt**, so a forged wrap never reaches the X25519 private key.

Following the `signal-crypto.ts` asymmetry: **signing throws** on degenerate
input (a programmer error), **verification never throws** and returns null on
every path (it is on the attacker-reachable side and must be total).

### Trust anchor — `web/src/crypto/trust.ts`

TOFU pinning, reusing the existing `verifications` IndexedDB store. New fields
on `VerificationRecord` are all optional, so pre-82 records stay meaningful and
**no `DB_VERSION` bump is needed** — which also avoids the upgrade-blocked-tab
hazard entirely.

**Pins the raw key, not `digestHex`.** The digest is a function of *both* peers'
keys, so pinning it would make every peer read "changed" the moment the local
user's own identity changed. The UI keeps using the digest, because that is what
the user actually compared.

```
first_seen | pinned | manually_verified | changed
```

- **Self-key mismatch** — hard reject, always. No flag, no escape. There is no
  legitimate path to a wrap claiming to be yours but signed by another key.
- **First seen** — pin and accept, no prompt.
- **Peer pin mismatch** — refuse *new key adoption*, keep the pin (the pin is
  the evidence; overwriting it would let a server launder a substitution into a
  fresh "pinned" on the next fetch), surface it for out-of-band resolution.

**A higher `generation` must never auto-accept a new key.** Generation is
server-asserted, so that rule would hand the attack straight back. Tested.
(Identity rotation is not implemented today — nothing sets `retired_at` — so the
wall's blast radius is small.)

TOFU's honest limit: a server that lies from the *very first* fetch of a peer
gets its key pinned, and only picture-word verification ever closed that. What
TOFU does close is every **later** substitution — the server is committed after
answering once.

Manual verification and TOFU are now **one mechanism at two assurance levels**:
`markManuallyVerified` upgrades the same row, so an in-person check is visible
to the crypto path instead of living in a parallel universe, and it never
downgrades.

### Adoption policy per site

The governing rule, applied everywhere:

> **An invalid signature is always fatal. A missing signature is a legacy wrap,
> governed by the enforcement flag.**

`openWrap` in `channel-crypto.ts` is the single decision point.

**Bootstrap read-back — requires a self-signature. Exact, not heuristic.**
Verified from the code: `fetch_channel_key` only ever returns the caller's own
row (`internal/server/ws.go`, `GetChannelKey(..., callerID)`), and the branch is
reached only when `fetch_channel_key_recipients` came back empty — nobody holds
a key. Identity is per-user, so another device of the same user signs with the
same key. The only legitimate writer is therefore *me*.

On a foreign signature: abort the bootstrap, publish nothing further, return
`waiting`, log loudly. Not calling `rewrapForMissing` is the point — that is
what stops the creator becoming the attacker's delivery mechanism.

On an *unsigned* read-back the rule needs no crypto at all: a read-back carrying
a **different** key than the one just minted did not come from another device
doing the same thing, so it is refused and the local key is kept. This is what
closes the C-01 shape today, before the enforcement flag exists.

**Ordinary fetch** — the signer must be me, or resolve via pins to a channel
member. Unresolved signers trigger one identity-fetch pass (which pins) and one
retry.

**Warm path** — the same rule **minus the network**. `warmChannelKey` sweeps
dozens of channels from the thread inbox with no user gesture; it accepts only
already-pinned signers, writes no pins, and fetches nothing. A test asserts it
issues **zero** `fetch_identity` frames. Non-resolution leaves the channel
unwarmed, which already renders a placeholder.

### The two standing rules — 82-5

Signing wraps only helps while a signature cannot be routed *around*, and there
are exactly two ways around one. Both are enforced in `adopt()`, which since
82-5 is the only way key material from outside this device enters the cache.

**Never-replace.** A `(channel, version)` slot names one key for all time —
every holder wraps the same bytes, and genuinely new material gets a new
version. So a wrap opening to *different* bytes than the slot already holds is
not a fresher answer, it is a second answer. Refused; the held key stays.

Honest scope: on the ordinary path `getKey()` already short-circuits a filled
slot before any fetch, so this rule's live effect is narrow — it serialises two
opens of the same channel in flight, and it is a backstop for any future
"refresh the key" path that skips that short-circuit. It is an invariant, not a
hot-path defence, and the test drives it through the racing-opens case because
that is the one that actually reaches it.

**Downgrade ratchet.** Once this device has opened one *signed* wrap for a
channel, an unsigned wrap for that channel is refused — at any version,
including versions minted later.

Per-**channel** rather than per-slot is the whole point. Never-replace already
covers a slot that has been answered, so a server stripping signatures would
simply wait for a rotation and answer the *fresh* slot in suite 1, where nothing
contradicts it. Making the rule per-slot would leave that door open and look
like it had closed it.

`self_minted` is deliberately **not** treated as unattributed: our own material
needs no attribution, and counting it would break rotation from a device whose
build predates this phase. Only `unsigned` and `legacy_cache` trip the ratchet.

Provenance is persisted (82-3) precisely so this survives a reload;
`channelHasSignedKey` reads it back by primary-key *prefix* (`"channelID:"`),
which needs no index and therefore still no `DB_VERSION` bump.

There is also a small **provenance upgrade**: re-offering the same bytes with a
better-attested story rewrites the record. That is what arms the ratchet for an
existing channel rather than only for new ones — though 82-6's self-healing
sweep is what will actually exercise it, since today `getKey()` returns before
the wrap is ever fetched.

### Enforcement — 82-6

`CHALK_WRAP_SIG_REQUIRED` has two halves, and only one of them is a defence
against the audit's adversary. The **client-side** half (welcome →
`wrap_sig_required` → `openWrap` refuses unsigned wraps) is the security
boundary: the attacker is the server, and a hostile server was never going to
refuse its own injected wraps. The **server-side** half (`checkWrapPublish`
refuses suite-1 publishes) matters on *honest* deployments — it stops old
clients quietly re-seeding unsigned wraps after the operator has flipped the
flag, so the sweep's work cannot be undone by one stale build.

The client **latches** the flag per session. It arrives over the very channel
the policy defends against, so "the server says it's optional again" on a
reconnect is precisely the downgrade the flag exists to refuse. An operator
rollback still works — the next page load starts a fresh session.

**The self-healing sweep** is `rewrapForMissing` grown a second duty: the
recipients ack now reports each holder's wrap *suite*, and any member sitting
on a lower suite than the one this client produces gets re-wrapped — including
**our own slot**, which the missing-only pass never touched and which is what
arms the 82-5 ratchet on this user's other devices. A member whose suite the
server did not report (pre-82-6 server) is left alone: unknown must not be
treated as worse. No new frame, no scheduler, no background job — healing
rides the code path that already runs on every channel open and re-share.

### Chokepoint — the bypass is now a compile error

`keys: Map<string, Uint8Array>` became `Map<string, HeldKey>` with provenance a
**required** parameter of `remember()`. A bare `keys.set(k, bytes)` no longer
type-checks. That is enforcement by `tsc`, not by a comment asking future edits
to behave — and the compiler immediately found the `rotateChannelKey` bypass
that had been writing the map directly.

`SpaceKeyRecord` persists provenance and `adoptedAt`, which is what let 82-5
implement the ratchet and never-replace across reloads. Pre-82 records load as
`legacy_cache` —
accepted, because refusing would lock every existing user out of their own
history, but marked.

---

## Findings during implementation

These are the things worth remembering; several are more valuable than the code.

### The first hostile tests proved nothing

Four green "hostile server" tests were written, and mutation testing — reverting
the defence and re-running — showed they **still passed**. They attacked with
suite 2, which pre-82 code rejects as an unknown suite anyway. A real attacker
uses **suite 1**, the only thing that exists in the wild.

The decisive test was rewritten to use an unsigned wrap, the mutation was
re-run, and it now fails without the fix and passes with it.

**Lesson, and it generalises past this phase: a security test that has never
been run against the vulnerable code is not evidence.** Mutate and re-run.

### The existing test suite was not exercising the unwrap path

Every user in `channel-crypto.test.ts` shares one `fake-indexeddb` in-process,
which real devices do not. So the second user's `getKey()` found the *first*
user's cached key and returned `ready` **without ever fetching a wrap**. Tests
asserting "Bob unwraps Alice's wrap and decrypts" were passing on a shared
cache.

New tests call `clearSpaceKeys()` between users to force the real path. The
pre-existing tests still pass, but the fixture quirk is a trap for anything
testing key *distribution*.

### Test files are excluded from `tsc`

`tsconfig.json` has `"exclude": [..., "src/**/*.test.ts"]`, so type errors in
tests are invisible to `npx tsc --noEmit`. The `channel-crypto.test.ts` fixture
was constructing an incomplete `ChannelCryptoIdentity` and nothing complained;
it was found by reading, not by tooling.

Fixed in the fixture. **The exclusion itself is left alone** — including tests
may surface pre-existing errors and that is a separate decision.

### A literal-typed registry pointer breaks the registry

`CURRENT_WRAP_SUITE = WRAP_SUITE_X25519_AESGCM` inferred the literal type `1`,
which made `case WRAP_SUITE_X25519_AESGCM_ED25519:` unreachable to the compiler.
It is now `: number`, with a comment: these are pointers that move, and a
literal type makes every other suite's case look dead — exactly backwards for a
registry whose job is to keep handling suites it no longer produces.

### The read-back is usually not an adoption at all

Reading one's own wrap back is the overwhelmingly common case, and adopting
byte-identical material is not an adoption. Comparing the read-back key to the
freshly minted one lets it keep `self_minted` provenance, which makes the
provenance record honest — and it was a failing provenance assertion that
surfaced this, not analysis.

### The unsigned producer had to survive, and had to be named for it

Flipping `CURRENT_WRAP_SUITE` to 2 cannot mean "suite 1 is unreachable": the
guest-invite mint still needs it, because a guest's `JoinScreen` has no identity
to anchor a signature against until 82-7 puts the owner's key in the link
fragment. Signing it now would only make every outstanding invite undecryptable.

So `wrapSpaceKey` became the dispatcher (taking a `WrapSigner`, *required* even
under an unsigned suite, so that flipping the pointer is a one-line change and
never a caller migration), and the suite-1 producer survives beside it as
`wrapSpaceKeyUnsigned`. The name is the safeguard — an exported bypass that
cannot be called by accident, and one `rg` finds every use of.

### The pin store leaked between tests, and only signing revealed it

Making wraps signed turned four unrelated `channel-crypto.test.ts` tests red.
Not a regression: every test there derives *fresh* identities but reuses the ids
`"alice"`/`"bob"`, while `fake-indexeddb` is one database for the whole process.
Opening a signed wrap pins its signer, so the first test to pin `"alice"` left a
pin naming a key no later test's Alice has — which `trust.ts` correctly reads as
a substitution and refuses.

Tests reset the key cache (`clearSpaceKeys`) but never the pins. `freshDevice()`
now does both. Worth recording because the same shape will bite anything else
that tests trust: **the fixture's "fresh device" was only ever half of one**, and
the half that was missing is the half 82-2 added.

### Accepted risk: mixed-version bootstrap divergence

Refusing a *different* unsigned read-back means two of a user's own devices
bootstrapping the same channel simultaneously — one on an old build, one on
new — will now **diverge** rather than converge, each keeping its own key.
Members end up with whichever wrap was written last, and messages under the
other key show placeholders.

Accepted deliberately: the window is narrow (both devices must bootstrap before
either sees a recipient list), the state is recoverable by rotation or
re-share, and the alternative is adopting a substituted key, which is not
recoverable. Once both devices sign (82-5), the self-signature resolves it
correctly and convergence is restored.

---

## Slices

| Slice | State | Content |
|---|---|---|
| 82-1 | **done** | Wrap suite 2, `chalk-wrap-sig.v1` canonical message, `wrapSpaceKeySigned` / `unwrapSpaceKeySigned` / `wrapSignerKey`. Pure crypto; nothing produces suite 2 yet. 13 tests. |
| 82-2 | **done** | `trust.ts`: TOFU pinning, `resolveSigner`, `markManuallyVerified`; `fetchIdentity` id-echo fix; members panel wired through it. 12 tests. |
| 82-3 | **done** | `HeldKey` + required provenance, `rotateChannelKey` bypass removed, provenance persisted, Ed25519 threaded into `ChannelCryptoIdentity`. |
| 82-4 | **done** | `openWrap` policy, self-signed read-back, warm path offline, hostile-server tests. |
| 82-5 | **done** | `CURRENT_WRAP_SUITE = 2` so every producer signs; `wrapSpaceKey` dispatches on it and `wrapSpaceKeyUnsigned` is the one named exception (guest mint); the never-replace and ratchet rules in `adopt()`; `channelHasSignedKey`; `describeSuites().keyAuth` + its tooltip row. 6 tests. |
| 82-6 | **done** | `wrap_suites` on the recipients ack; self-healing re-wrap sweep in `rewrapForMissing` (own slot included); `CHALK_WRAP_SIG_REQUIRED` through config → `welcome.wrap_sig_required` → chalkctl (generated, preserved, backfilled `false` on update); server refuses suite-1 writes when required (`checkWrapPublish`); `PutChannelKey` guarded overwrite (recipient-or-upgrade); `key_version ≤ current+1`; `maxWrapBlobBytes` on `publish_channel_key`; client latches the flag per session. |
| 82-7 | todo | Guest path: owner Ed25519 key in the link fragment (~96 → ~140 chars), `owner_user_id` in the redeem response, signed mint, `JoinScreen` verification. |
| 82-8 | todo | Members-panel badges, the identity-changed wall, key provenance line, visible `member_added`; `threat-model.md`, `crypto-agility.md` suite-2 registry entry, CHANGELOG. |

### The 82-6 server rule: recipient-or-upgrade, silently

`PutChannelKey` used an unbounded `ON CONFLICT DO UPDATE`, so **any member
could silently overwrite any other member's wrap slot at any key version**.
Verified there are only two writers — `ws.go` via `PutChannelKey`, and the
guest redeem which uses `DO NOTHING` — and no governance or admin path.

The plan said "restrict overwrite to the recipient", and that turned out to be
**half wrong**: the self-healing sweep is a *non-recipient* upgrading someone
else's suite-1 slot to suite 2, which a recipient-only rule would forbid. The
shipped rule is therefore **recipient-or-upgrade**: a filled slot is
overwritten only by its own recipient or by a wrap under a strictly higher
suite. A refused overwrite is a silent no-op, not an error — two holders
auto-rewrapping the same missing member race benignly, the loser's write
carries the same key, and erroring would make that race look like a failure.

What a hostile *member* can still do: overwrite a suite-1 slot once with a
junk suite-2 blob (a one-shot DoS; the victim's client refuses it and shows
`waiting`, recoverable by re-share). They could always do at least this; the
rule removes the *repeatable, silent* version. The server still cannot tell a
good wrap from a bad one — it enforces shape, not truth.

## Rejected alternatives

**Columns for the signature** — see above.

**A link-secret-derived AAD binder for the guest path.** The guest's link
fragment secret is unknown to the server, so folding a binder derived from it
into the wrap AAD would make a forged wrap impossible without any owner-key
trust chain at all — arguably stronger, and needing no fragment change.
Rejected because it gives one wrap suite **two different AAD constructions**
depending on the recipient's type, and "a signature that is verified
inconsistently" is the precise failure the audit named. Uniformity is worth the
44 characters. Recorded because it is a genuinely good idea that someone will
re-propose.

## Verification

```bash
go build ./... && go vet ./... && go test ./... && gofmt -l .   # gofmt empty
cd web && npx tsc --noEmit && node test.mjs && node build.mjs
```

Client suite at 82-6: **1106 tests, 0 failures** (1058 before the phase).

Every 82-5 and 82-6 defence was mutation-tested, per the lesson above — the
ratchet, the never-replace rule, the suite flip, the flag refusal and the
sweep were each reverted in turn and the tests that should fail did, and only
those. The server-side policy (`checkWrapPublish`) is a pure function tested
without a database; the guarded upsert's `WHERE` clause is exercised only
against a real Postgres and is covered by the flag-on end-to-end check below.

DB-backed Go tests need a fixture database via `bootstrap/phase-03-postgres.sh`,
not the ad-hoc dev DB — see the note in `docs/PHASE-81-SECAUDIT.md`.

The end-to-end check runs via the `run-chalk` skill: two users in a channel
exchanging messages, a guest link minted and redeemed, then
`CHALK_WRAP_SIG_REQUIRED=true` with an un-swept member showing `waiting` and
recovering via "re-share". It exercises the real Postgres upsert guard, which
no unit test reaches. The members-panel provenance and pin badges join the
checklist when 82-8 ships them. **Not yet run for 82-5/82-6** — worth doing
before cutting a release that contains them.

## Out of scope

- **Authenticated channel-state transcript** (membership changes that cannot be
  forged) — phase 83. It shares this phase's identity anchor with H-01.
- **H-01, signed message envelopes** — also phase 83; the anchor is the
  expensive half and is paid for here.
- Forward secrecy and post-quantum, which remain explicit non-goals.

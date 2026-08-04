# Phase 82 — Signed channel-key wraps

Closing audit finding **C-01 (Critical)**: channel-key wraps are encrypted *to* a
recipient but signed by nobody, so a malicious server can substitute a space key
it knows. Planned against v0.6.4, after phase 81.

**Status: complete (82-1 … 82-9).** C-01 is closed **on deployments that have
flipped the enforcement flag** — see *Where this actually stands* below, which
is deliberately placed before the design so it cannot be skimmed past. The
end-to-end run against a live stack is the one outstanding item; see
*Verification*.

---

## Where this actually stands

| | |
|---|---|
| Closed today | Substitution at the **bootstrap read-back**, for both signed and unsigned wraps. This is the audit's worst case — the one where the legitimate creator redistributes the attacker's key to the whole channel. |
| Closed today | Any suite-2 wrap signed by an identity this device has not pinned. |
| Closed by 82-5 | Every wrap chalk produces for a member is now signed, so on any channel where the members run current builds, one signed adoption **ratchets** the channel: an unsigned wrap for it is refused thereafter, at any key version. |
| Closed by 82-6 | Silent overwrite of another member's wrap slot (the store's guarded upsert), wraps parked at arbitrary future key versions, and unbounded wrap blobs. The **self-healing sweep** upgrades legacy unsigned wraps to signed ones as channels get used — no member action needed. |
| Closed by 82-7 | Guest wraps. The link fragment now carries the owner's Ed25519 public key, the mint signs, and the guest verifies — anchored on the one value the server never sees. Links minted before 82-7 keep working, unsigned, until they expire (hours). |
| Closed **when the operator flips `CHALK_WRAP_SIG_REQUIRED`** | Unsigned wraps entirely: the server refuses them on publish, the client refuses them on read (latched per session — a later welcome cannot relax it). An un-swept member shows `waiting` and recovers via a holder's re-share. |
| **Still open by default** | On a deployment with the flag off (the shipped default), an unsigned wrap on a channel that has never yielded a signed one is still accepted — the migration window, which the sweep drains and the flag ends. |
| Still open | Membership is server-asserted, so a server that can add a member it controls can still get a key it knows distributed. Phase 83. |

The migration story, in one line: **ship it, let the sweep run, wait for
`chalkctl wrapsig status` to say READY, then `chalkctl wrapsig enable`.** The
flag defaults false because flipping it before the sweep has re-signed a
channel's wraps strands every member still on an unsigned one — which is
exactly what 82-9's readiness check exists to stop you doing blind.

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

### The guest path — 82-7

A guest is the hardest case in the phase, because every anchor the rest of the
design leans on is missing: no account, no pinned peers, no IndexedDB history,
nothing but a URL. Phase 80's derived identity already stopped the server
*reading* the room (it cannot produce the guest's private key), but it left
substitution wide open: the server holds the guest's X25519 **public** key from
the mint frame, so it can seal a key of its own into a flawless suite-1 wrap
and hand that back at redemption. The guest joins a room the server can read,
believing it joined the owner's.

The anchor has to be something the server never sees, and there is exactly one
such thing: **the fragment**. So it grew a second value —

```
#<base64url( secret(32) || ownerEd25519Pub(32) )>     ~96 -> ~140 chars
```

and the governing rule became **the fragment decides what the wrap must be**:

| fragment | required wrap |
|---|---|
| carries an owner key (82-7+) | suite 2, signed by that key, as `owner_user_id` |
| carries none (pre-82-7) | suite 1, unsigned |

Both directions matter. Downward, a server cannot strip the signature off a
current link — the guest expects one. Upward, it cannot bolt a signature onto a
legacy link to look trustworthy — the guest has nothing to check it against and
refuses rather than guessing. `owner_user_id` comes from the server, but it is
bound *inside* the signed message, so mislabelling the owner produces a
verification failure instead of an acceptance.

The mint gate joins the enforcement flag here: with `CHALK_WRAP_SIG_REQUIRED`
on, no new unsigned guest links can be created. Already-parked suite-1 invites
still **redeem** — their links were issued under the old contract, the redeem
copy is not a new wrap, and they die on their own within hours anyway.

`exportKeyForMint` was **replaced** by `wrapKeyForGuest`, which does the sealing
and signing inside `ChannelCrypto` and returns only the finished wrap. The old
shape handed a component the raw space key; a caller holding plaintext key
material is a caller that can wrap it any way it likes, including unsigned.

### What the user is told — 82-8

Five slices of cryptography are worth nothing a user can act on unless the
client says what it knows. The rule for every string in this slice: **describe
what this device knows, never how safe it feels.** "signed by alice" is a fact;
"secure" would be a promise the client is not in a position to make, because it
knows whether it *recognised* alice's key, not whether the key is really hers.

- **Badges** gained a fifth state. "recognised" (TOFU) sits between
  "unverified" and "verified" — a real fact, and not a check. Naming it
  "pinned" was rejected: a user should not need the word to read the badge.
- **The identity-changed wall.** A repudiated pin is the gravest thing the
  panel can report, so it stops being a badge halfway down a list and becomes a
  block at the top, in the error colour, naming who and offering the check. Its
  wording gives both explanations honestly — *this is what a reinstall looks
  like, and it is what a tampered server looks like* — because a warning that
  cries attack at every reinstall is one users learn to click past.
- **The key-provenance line** answers "where did this device's copy of the key
  come from?" from the provenance 82-3 recorded and 82-5 persisted. The two
  unproven origins (`unsigned`, `legacy_cache`) are the only ones flagged.
- **The join notice.** Membership is server-asserted and any key holder
  auto-reshares to whoever appears in the roster, so a server that adds a
  principal it controls is *handed the key by a legitimate member's client*.
  Phase 82 cannot close that — signing a wrap says who sent a key, not who
  deserved one — so 82-8 does the one thing available: denies it silence. It
  names everyone who joined; "and 3 others" is precisely the summarisation that
  would let one unexpected member hide behind two expected ones.

Deliberately **not** a synthetic message in the feed: that would need a seq,
which means colliding with the real sequence space, persisting, and counting as
unread — a lot of blast radius for a notice about something that just happened.

### Knowing when to flip the flag — 82-9

The migration plan ends with "flip `CHALK_WRAP_SIG_REQUIRED` once the sweep has
drained", and 82-6 shipped it with no way to know when that is. An operator
staring at a config file cannot see whether one straggler would be locked out,
and the failure mode of guessing is that a real person cannot read their
channel. `chalkctl wrapsig status` answers it:

```
CHALK_WRAP_SIG_REQUIRED is currently false

channel keys at current versions: 38 of 41 signed, across 9 channel(s)

NOT READY: 3 wrap(s) are still unsigned.
These members would be blocked ('waiting') until a key holder re-shares:
  #standup                     2/5 unsigned  dave, erin
  #random                      1/4 unsigned  dave
```

The server cannot verify a signature — it is the party signatures defend
against — but `wrap_suite` is a plain column, and "which slots are still suite
1" *is* the readiness question. `enable` refuses to run while anyone would be
stranded (`--force` overrides, and says so), and `disable` exists because a flag
whose failure mode is locking users out needs its way back to be one command
rather than an env-file edit remembered under pressure.

Two scoping decisions do the real work, and both are asserted by tests because
getting either wrong yields a command that says "not ready" forever — which an
operator learns to ignore:

- **Current key versions only.** Clients never re-fetch an old version's wrap
  (`decryptForChannel` reads the local cache and nothing else), so an unsigned
  wrap at an old version can block nobody.
- **Live channels only.** Expired ephemeral rooms are pending hard-deletion by
  the janitor; letting a dead guest room hold the verdict red would block the
  operator on something about to cease existing.

Outstanding **guest links** are reported but explicitly do not gate: redeeming
an already-parked invite is not flag-gated, and the links expire within hours.

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

### Two of 82-7's guards survive their own mutation, and that is fine

Mutation-testing `openGuestWrap` produced a surprise: removing its
suite-downgrade check changed **nothing** — every test still passed. Same for
removing the refusal of a signature on an anchorless link.

The reason is that `unwrapSpaceKey` and `unwrapSpaceKeySigned` each refuse the
*other's* suite already, by construction of the registry. So the explicit
guards are belt-and-braces; what actually carries the defence is **which
primitive gets called**, which the fragment decides. Mutating *that* — forcing
the unsigned path, i.e. reverting to pre-82-7 behaviour — killed two tests,
including the substituted-wrap one.

The guards were kept, collapsed into a single `requiredSuite` line so the
policy is legible in one place rather than implied by two call sites, with a
comment saying plainly that the teeth are elsewhere. Recorded because the naive
reading of a green mutation run is "this check is dead code, delete it", and
the correct reading here is "this check is redundant *today*, and states a rule
the primitives happen to also enforce."

### 82-2 shipped a bug that only the UI slice could see

Six slices later, 82-8 went to add a "recognised" badge for TOFU-pinned peers
and found the panel was already saying something — the wrong thing. A TOFU pin
is written with `digestHex: ""` (nothing was compared out of band), and
`App.tsx` fed that straight to `verificationState()`, which reads `"" !== <the
current digest>` as **changed**.

So from 82-2 until 82-8, opening the members panel showed **"key changed"** for
every peer, on first sight, always. The loudest badge in the product, as the
default state. That is worse than showing nothing: it is how a user learns that
the alarm means nothing.

Two things it says about the phase. First, `pinStateFor` was thoroughly unit-
tested and every test passed — the bug lived in the *seam* between two
correct functions, in a component with no test. Second, nobody looked: six
slices of crypto work went by without opening the panel they were all
ultimately for.

The fix is `memberTrust(pin, currentDigestHex, stored)` in `trust.ts` — one
pure function that owns the combination, tested including the exact TOFU record
`fetchTrustedIdentity` writes, and mutation-tested by reintroducing the bug.
The rule it encodes: a repudiated pin outranks the digest comparison, and an
empty stored digest means *never compared*, not *mismatched*.

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
| 82-7 | **done** | Guest path: owner Ed25519 key in the link fragment (~96 → ~140 chars), `owner_user_id` through `RedeemedGuest` → the redeem response, `openGuestWrap`'s fragment-decides-the-suite rule, `wrapKeyForGuest` replacing `exportKeyForMint`, `JoinScreen` verify-then-open, mint gated by `checkWrapSuite`. 11 tests. |
| 82-8 | **done** | `memberTrust` (and the first-sight badge bug it fixes), the identity-changed wall, `describeKeyProvenance` + the panel's provenance line, `JoinNotice` for visible `member_added`; `threat-model.md` rewritten. `crypto-agility.md`'s suite-2 entry landed early, in 82-5. 12 tests. |
| 82-9 | **done** | `chalkctl wrapsig status\|enable\|disable` — the operator's answer to "has the sweep finished?", read from `channel_keys.wrap_suite`. 4 tests. |

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
re-propose. 82-7 shipped the fragment-key form as planned; the 44 characters
cost ~140 chars of link, which stays inside every sane URL limit.

**Versioning the fragment with a leading byte.** The obvious way to extend it,
and rejected: the two forms are already distinguished by *length* (32 vs 64),
which is unambiguous, needs no parsing state, and — the deciding point — keeps
every pre-82-7 link byte-identical rather than orphaning them. A version byte
would have made old links unparseable for a gain of nothing.

## Verification

```bash
go build ./... && go vet ./... && go test ./... && gofmt -l .   # gofmt empty
cd web && npx tsc --noEmit && node test.mjs && node build.mjs
```

Client suite at 82-8: **1132 tests, 0 failures** (1058 before the phase).

Every 82-5 … 82-8 defence was mutation-tested, per the lesson above — the
ratchet, the never-replace rule, the suite flip, the flag refusal, the sweep,
the guest fragment rule and the badge fix were each reverted in turn and the
tests that should fail did, and only those (see the note above on the two 82-7
guards that survive their own mutation, and why). The server-side policy
(`checkWrapPublish` / `checkWrapSuite`) is a pure function tested without a
database; the guarded upsert's `WHERE` clause is exercised only against a real
Postgres and is covered by the flag-on end-to-end check below.

DB-backed Go tests need a clean fixture database (seeded from
`test/integration/fixtures/users.sql`), not the ad-hoc dev DB — see the note in
`docs/phases/PHASE-81-SECAUDIT.md`.

**Outstanding: the end-to-end run.** Everything above is unit-tested; the
phase has not been driven against a live stack. Via the `run-chalk` skill:

1. two users in a channel exchanging messages;
2. the members panel — badges read "recognised" on first sight (**not** "key
   changed"), and the provenance line names the signer;
3. a guest link minted and redeemed — the link is now ~140 chars, so check it
   survives the copy button and a paste into the composer;
4. add a member, and confirm the join notice says so above the composer;
5. `chalkctl wrapsig status` — READY before the flip, and NOT READY (naming
   the right member) if one is deliberately left un-swept;
6. `chalkctl wrapsig enable`: an un-swept member shows `waiting` and recovers
   via "re-share"; a fresh guest link still mints and redeems; then
   `chalkctl wrapsig disable` restores them.

Steps 5-6 are the only exercise of the real Postgres upsert guard and of
`wrapsig`'s SQL, neither of which any unit test reaches. Worth doing before cutting a release that contains this phase.

## Out of scope

- **Authenticated channel-state transcript** (membership changes that cannot be
  forged) — phase 83. It shares this phase's identity anchor with H-01.
- **H-01, signed message envelopes** — also phase 83; the anchor is the
  expensive half and is paid for here.
- Forward secrecy and post-quantum, which remain explicit non-goals.

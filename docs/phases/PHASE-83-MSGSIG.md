# Phase 83 — MSGSIG: the signed sealed envelope

**Status: in progress — slices 83-1 … 83-5 landed 2026-08-09 (scuq opened
implementation on the R20-conditioned pass, all four of its items
being complete in the sixth revision). A fresh design under the
revised trust model (decided by scuq, 2026-08-09), superseding the
envelope-fanout design in its entirety.** The fanout plan's final text (twelve
revisions) is preserved in git history at `731eac5`; its external audit
trail lives on in `docs/audits/` (the fifth and sixth independent
reviews, and the R11–R14 delta series). This document replaces it and
does not carry its Gate-0 process forward; it gets its own review
before slice 1 lands.

**Review record.** First review of this design (R16, 2026-08-09 —
`docs/audits/security-phase-83-r16-review-2026-08-09.md`):
architecture endorsed — *"Gate 0 open, but much closer"*, no new
canonical-format blocker, the R15 split-view problem gone by design —
with two High findings, **both folded in this second revision**:
identity generations now chain cryptographically (R16-1 — the
`chalk-idgen.v1` cert, so a database row alone can never mint a
"retired identity of Alice"; D.1), and rotation is one atomic server
transaction with a `rotation_required` send gate (R16-2 — the version
ceiling serialized the version number, not which key became it; D.2).
Its completion items are also in: the claim-1/claim-2 boundary made
explicit (process control = malicious chalkd), the server-key wording
corrected (*user* keys never server-side; chalkd holds its own), and
the inner-channel session construction frozen (D.3). The R15 review
of the fanout design — the pivot's trigger — is backfilled to
`docs/audits/security-phase-83-r15-review-2026-08-09.md` so the
decision record's citation resolves. **Gate 0 stays open pending
re-review of this delta.**

Second review (R17, 2026-08-09 —
`docs/audits/security-phase-83-r17-review-2026-08-09.md`): *"Gate 0
almost passes"* — R16-1/R16-2 verified structurally fixed, the trust
boundary and inner channel pass, and one High blocker: the
generation-cert definition was circular, placing `sig64` inside the
canonical it signs (P83-A-R17-01). **Fixed in this third revision,
surgically**: the canonical excludes `sig64` (the plan's standard
convention), the generation-1 root hash is frozen
(`chalk-idgen-root.v1`, computed from the identity record's own bytes,
never database metadata), and the mutation vectors are listed. Its
non-blocking items are taken as one-liners: `rotation_due` carries
`from_version` (R17-N2), the inner-channel GCM nonce encoding is
frozen (`u32be(0) || u64be(counter)`), and the malicious-rotator
availability attack is a stated §D.5 residual (R17-N1 — no wrap-format
change; phase 82's canonical stays frozen). **Gate 0 stays open
pending re-review of exactly this delta — the reviewer's stated
expectation is a pass.**

Third review (R18, 2026-08-09 —
`docs/audits/security-phase-83-r18-review-2026-08-09.md`): R17-01
verified closed; one Critical trust-model contradiction (P83-A-R18-01)
— claim 2 permitted the host to *modify* persistent data, but
membership is server-asserted, so a database write inserting a
principal makes honest clients wrap keys to it, contradicting "host
compromise opens nothing". **Resolved in this fourth revision by
narrowing the claim, as recommended** (no membership crypto brought
back): claim 2 now covers host *reads*, and altering the
authorization tables is placed on the malicious-chalkd side of the
boundary. Per scuq's direction the lowered claim ships with two
mitigations rather than bare wording — **D.6**, client-derived
roster-change notices that fire even for a pure database insert, and
**phase 99** (`PHASE-99-DBCREDS.md`), hardening the database
credentials at rest and in chalkd's memory. Stored *cryptographic*
objects stay tamper-evident; only the authorization tables' integrity
is trusted. **Gate 0 stays open pending re-review of this delta.**

Fourth review (R19, 2026-08-09 —
`docs/audits/security-phase-83-r19-review-2026-08-09.md`): R18
verified closed, every protocol area green, and one Critical claim
mismatch from combining claims 2 and 3 (P83-A-R19-01): claim 2
permitted reading chalkd's *process memory*, which exfiltrates the
server identity key — whose holder passes the D.3 handshake, presents
any roster, and is auto-reshared channel keys. **Resolved in this
fifth revision by the reviewer's Option A — no protocol change**:
claim 2 is a *persistent-storage* breach claim (DB dumps, disks,
backups, logs open nothing), and live process compromise — memory,
the server key, execution — joins code-tampering and
authorization-table writes on the malicious-chalkd side, giving the
four-line model frozen in the claim. D.6's overclaim is corrected to
the precise property (a persisted change is surfaced at next
observation) and the diff-before-reshare ordering is frozen so the
notice really does precede any wrap. **Gate 0 stays open pending what
the reviewer expects to be the final claim-consistency pass.**

Fifth review (R20, 2026-08-09 —
`docs/audits/security-phase-83-r20-review-2026-08-09.md`): the final
pass, run against the fourth-revision text while the fifth was in
flight, so its R19 restatement was already answered; it confirmed
**every protocol area passes** — identity continuity, message
authenticity, rotation, concurrent rotation, the malicious-rotator
residual, the server pin, authorization integrity — and conditioned
Gate 0 PASS on exactly four claim/documentation changes. **This sixth
revision completes the set**: (1) process-memory reads removed from
claim 2 and (2) server-identity-key compromise placed inside the
malicious-chalkd boundary (both already in the fifth revision); (3)
the residual renamed **"Server-storage disclosure"** (the reviewer's
point taken — "host compromise" implies broader control than a
dump); (4) D.6's guarantee stated in the reviewer's words —
*unauthorized roster changes are surfaced to any client that
observes the changed roster; detection, not prevention, no guarantee
for changes never observed* — with the frozen diff-before-reshare
ordering kept and its promise stated as mechanical (the record
precedes the key), never as the human having read it. Per the
reviewer's own words, with these applied they "would be comfortable
marking Gate 0 PASS" — **the gate awaits that confirmation, and
nothing else.**

**Tag:** `#msgsig`.

---

## The revised trust model — the claims, nothing more, nothing less

Decided 2026-08-09, and now the authority for every security statement
in this phase (threat-model.md carries the user-facing version):

1. **chalkd itself is honest.** The server software runs the protocol
   as written: it stores what it is given, delivers to whom it should,
   and asserts membership and ordering truthfully. chalk no longer
   claims any property against a chalkd that lies.
2. **The host is not trusted for confidentiality of persistent
   storage — a server-side data breach must not reveal message
   contents (narrowed 2026-08-09 twice: P83-A-R18-01, then
   P83-A-R19-01 to its final form).** An attacker may read the
   database, filesystem data, backups, logs and snapshots — and
   **such access must not yield already-sent messages**: no plaintext
   at rest, no message keys, no channel space keys, and no *user*
   identity private keys ever exist server-side. Three boundaries
   with claim 1, all explicit, all the same rule — *these are
   equivalent to a malicious chalkd and outside this claim*:
   - altering chalkd's executable code or live control flow (the R16
     boundary);
   - **altering the authorization state chalkd consumes** — above
     all the membership tables (the R18 boundary): membership is
     server-asserted by design, so a database write that inserts a
     principal makes honest clients wrap keys to it. **Database
     manipulation is a real threat and chalk does not defend
     authorization state against it** — stated, not defended, and
     met with two mitigations rather than a pretended guarantee:
     D.6's client-derived roster-change notices, and phase 99
     (`PHASE-99-DBCREDS.md`) hardening the database credentials that
     make the write cheap; and
   - **live compromise of chalkd's process — including its memory
     and its server-identity private key** (the R19 boundary): the
     server key is claim 3's signer, so its holder *is* the server
     to every pinned client, and phase 82 auto-reshares to whatever
     roster the server presents — a memory read that exfiltrates the
     key is therefore a lost trusted endpoint, not a survivable
     breach, and claiming otherwise made claims 2 and 3 contradict.
     The clean model that results:

     ```
     DB dump / stolen disk / backup      → E2EE holds
     live chalkd compromise              → trusted endpoint lost
     authorization DB modification      → trusted endpoint lost
     server identity private-key theft  → trusted endpoint lost
     ```

   What claim 2 still defends against *tampering*: stored
   cryptographic objects. Corrupted or substituted ciphertexts,
   wraps and identity records fail closed — D.1's signatures, phase
   82's wrap signatures and the idgen chain are exactly the
   detectors — so opportunistic stored-object corruption is caught;
   it is the *authorization tables* whose integrity is trusted.
3. **A client can detect a MITM toward the server it originally
   registered with.** The network path between client and server is
   not trusted even with valid TLS (CA mis-issuance, DNS takeover);
   the client pins its home server's identity at registration and can
   tell when someone else answers.

And one product invariant, kept from everything the fanout work
taught: **membership changes never freeze a channel.** No owner crypto
role, no departure ceremony — a channel of 2 or 3 works exactly like a
channel of 30, and the owner leaving is not special.

What is deliberately **no longer claimed**: defense against a
malicious or compelled-to-*act* server. Twelve revisions and six
external reviews of the fanout design established what that claim
actually costs — signed per-channel authority anchors, per-target
certificate chains, a totally-ordered control chain, and finally
(P83-A-R15-01) the demonstration that branch uniqueness against an
equivocating server requires consensus, witnesses, or quorum
certificates: machinery from a different weight class than a
self-hosted friends-and-family chat. The claim was dropped rather than
half-met. A server that actively lies about membership can admit a
principal it controls and be handed the channel key by an honest
client — that is now a stated, accepted property of the trust model,
made *visible* (join notices, wrap provenance) but not prevented.

## What carries over from the fanout work

The twelve revisions were not wasted; the following survived every
review round and is reused, with its audit findings baked in:

- **The canonical encoding discipline** — `lp()`/`uuid16`/`h32`
  conventions, typed objects, strict total parsing, per-field caps,
  mutation-vector testing (reviewed across the transcript plan's five
  rounds and re-frozen twice since).
- **The replay identity** — every object keyed by
  `(actor, writer_scope, client_msg_id)`, first-seen binding,
  duplicates rendered once — including F6-03's fix: the fields exist
  in **all three** object types, not just messages.
- **The identity-generation lesson (R12/R13)** — a signed object must
  say *which* identity generation produced it, or a legitimate key
  rotation destroys history verification on fresh devices; retired
  generations must stay fetchable by `(user_id, ed25519_fp)`.
- **Verification fails closed, availability does not** — the typed
  result set, "inner wins on mismatch", content shown under a warning
  rather than dropped.
- **The send-flow reorder** — mint id → upload attachments → build →
  sign → seal → send.
- **Append-only edit revisions** (scuq, 2026-08-07, from the
  transcript design): once an edit destroys signed evidence, 0044's
  overwrite is incompatible with the guarantee.
- **First-responder key rotation** — rejected under the old model
  because it trusted the server as coordinator; under the new model
  the server *is* a trusted coordinator, and it is the simplest
  freeze-free rotation there is.

## The design

Three pieces, in order of importance: sign what is said, keep sealing
it the way phase 22+ already does, and pin the server you registered
with.

### D.1 Signed envelope inside the existing encryption

Message bodies stay encrypted exactly as today — AES-256-GCM under the
per-channel space key, wrapped to members' X25519 keys with phase 82's
**signed wraps** (suite 2), which under claim 2 are load-bearing: host
malware that tampers with stored wraps is caught by signature + pin,
and a database dump yields ciphertext and unopenable wraps. Nothing
about the sealing changes.

What changes is the plaintext: instead of bare text, the body is a
**canonical, Ed25519-signed envelope** — sign-then-seal:

```
body plaintext = canonical || lp(sig64)
sig64          = Ed25519(sender identity key, canonical)
object_hash    = SHA-256(canonical || lp(sig64))

canonical      = utf8("chalk-msg-sig.v1") || u8(objType) || fields
```

Conventions (frozen): `lp(x) = u32be(len(x)) || x`; `uuid16` strict
raw 16 bytes; `h32` exactly 32 bytes, no prefix; lists are
`u32be(count) || element*`; absent optional `uuid16`/`h32` is all-zero
bytes, absent `lp` is `lp("")`; trailing bytes are `malformed`;
encoders reuse the exported `spacekey.ts` helpers plus `uuid16`.
`objType`: `0x01` message, `0x02` edit, `0x03` reaction set.

`0x01` — message:

```
uuid16(channel_id) || u32be(key_version) || uuid16(sender_user_id)
|| h32(sender_ed25519_fp)               // WHICH generation signed —
                                        //   the R12/R13 lesson
|| uuid16(writer_scope) || uuid16(client_msg_id) || u64be(sender_ts)
|| u64be(wseq)
|| uuid16(par_sender) || uuid16(par_scope) || uuid16(par_client_msg_id)
|| h32(par_env_hash)                    // reply binding; zeros when not
                                        //   a reply / parent is legacy
|| lp(utf8(body_text))                  // ≤ 65,536 bytes
|| u32be(att_count) || att_binding*     // ≤ 10

att_binding = uuid16(attachment_id) || u32be(att_key_version)
|| u64be(byte_len) || h32(sha256(full_ciphertext))
|| h32(sha256(enc_meta)) || h32(sha256(enc_preview))  // zeros if none
```

`0x02` — edit (sender must equal the original's sender; client-checked
and server-checked, the client check is the boundary):

```
uuid16(channel_id) || u32be(key_version) || uuid16(sender_user_id)
|| h32(sender_ed25519_fp)
|| uuid16(writer_scope) || uuid16(client_msg_id)      // fresh per edit
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(prev_rev_hash)                   // object_hash of the original
                                        //   (first edit) or previous edit
|| u64be(sender_ts)
|| lp(utf8(body_text)) || u32be(att_count) || att_binding*
```

`0x03` — reaction set (a clear is a signed sealed empty set; the
unencrypted-clear special case is deleted):

```
uuid16(channel_id) || u32be(key_version) || uuid16(actor_user_id)
|| h32(sender_ed25519_fp)
|| uuid16(writer_scope) || uuid16(client_msg_id)      // fresh per set
|| uuid16(tgt_sender) || uuid16(tgt_scope) || uuid16(tgt_client_msg_id)
|| h32(tgt_env_hash)
|| h32(prev_set_hash)                   // zeros for the actor's first set
|| u64be(sender_ts)
|| u32be(emoji_count) || lp(emoji)*     // ≤ 64 per set, ≤ 32 bytes each
```

**Replay identity:** `(actor, writer_scope, client_msg_id)` — actor is
`sender_user_id` for `0x01`/`0x02`, `actor_user_id` for `0x03`; bound
to the first-seen server id; the same triple under a different server
row is a duplicate, rendered once. `sender_ts` is display-only.
Server-minted id, timestamp and ordering stay receipt metadata outside
the signature — replay and re-dating are *detectable*, not prevented,
and under claim 1 the server does not do them; the signature is what
keeps host-side tampering and member-on-member impersonation
detectable.

**Verification, fail-closed typed results:** `verified` (signature
valid against the sender's pinned current identity; every
server-supplied outer field matches its signed inner counterpart) /
`verified-former-identity` (valid against a *retired* generation of
the sender, resolved below — labelled history, never rendered as
current-identity speech) / `mismatch` (signature valid, outer frame
disagrees — inner wins, always) / `forged` (invalid against our belief
about the signed generation) / `unpinned` (no pin and the path may not
fetch) / `unsigned` (legacy pre-83 object, rendered uniformly as
such). Content is displayed even when attribution fails, under an
unmistakable warning.

**Identity generations are a signed chain, never database rows
(R16-1).** The sealed `sender_ed25519_fp` names the signing
generation, and the first review of this design caught the hole a
server-attested lookup would open: under claim 2 the host can *write*
the database, so a fabricated "retired generation of Alice" row
carrying an attacker key would convert DB tampering into historical
impersonation, laundered through an honest chalkd truthfully serving
its own poisoned table. So generations chain cryptographically — each
rotation is signed by the key it retires:

```
generation_cert canonical = utf8("chalk-idgen.v1")
  || uuid16(user) || u32be(generation)          // 2, 3, …
  || h32(new_ed25519_fp) || h32(sha256(new_x25519_pub))
  || h32(prev_generation_hash)

sig64           = Ed25519(previous generation's key, canonical)
                  // exactly 64 raw bytes, NOT part of the canonical
                  // (P83-A-R17-01 — the same convention as every
                  // other signed artifact in this plan)
generation_hash = SHA-256(canonical || sig64)

generation1_hash = SHA-256(utf8("chalk-idgen-root.v1")
  || uuid16(user) || h32(ed25519_fp)
  || h32(sha256(x25519_pub)) || self_sig64)
                  // the frozen root: computed from the generation-1
                  // identity record's own bytes (key material + its
                  // existing Ed25519→X25519 self-sig), never from
                  // mutable database metadata — two implementations
                  // must agree without consulting the server.
                  // gen 2's prev_generation_hash = generation1_hash.
```

Vectors (83-4): per-field mutation (generation, new Ed fingerprint,
X25519 hash, predecessor hash); a cert signed by the wrong
generation; a truncated or 65-byte signature; a valid cert
transplanted to another user; a root hash recomputed from tampered
key material.

Generation 1's trust is what it always was: the TOFU pin, upgradeable
by picture-word. A normal rotation holds the old identity in hand and
signs the successor as part of the same action; the server stores the
cert beside the retired row and serves it with the fingerprint-keyed
lookup — `(user_id, ed25519_fp)`, retired generations included (the
store already retains them with `retired_at`; today's `fetch_identity`
serves only the active one). Verification then requires: the
Ed25519→X25519 self-signature, plus the **current** pin for
`verified`, or membership of the fingerprint in the **verified chain
ending at the currently pinned generation** for
`verified-former-identity` — a database row alone proves nothing. A
fingerprint that resolves to nothing, to another user, or to a chain
that does not reach the pin is `forged`. **A chain break is a wall:**
a rotation that cannot sign with the old key (lost seed — the
recovery case) starts a new chain, surfaces as the existing
identity-changed wall, and history signed by pre-break generations
becomes `unpinned`-class ("an earlier identity that cannot be linked
to this user's current key") until an out-of-band comparison
re-attests it — honest, loud, and exactly the semantics key loss
deserves.

**Edits are append-only** (reverses 0044, as decided 2026-08-07): the
server moves the displaced ciphertext + its `key_version` into
`message_revisions` in the same transaction as the update, capped at
`MAX_MESSAGE_REVISIONS = 64`; `fetch_revisions` returns ciphertexts by
locator; clients verify each revision's signature and `prev_rev_hash`
link back to the original and classify extend / sibling-fork / stale /
unknown, rendering unverified-recency rather than false trust when
ancestry is withheld. Deleting a message purges its revisions with the
tombstone.

**Vectors (slice 1):** per-field mutation across all three types;
cross-object and cross-channel confusion; truncation; trailing bytes;
absent-vs-zero; oversize caps; replay-under-new-server-id for all
three types; a retired-generation signature (labelled, never current);
a foreign fingerprint (`forged`); an edit whose sender ≠ target
sender; revision-fork and withheld-ancestry cases.

### D.2 Rotation without ceremony

Membership is server-asserted (claim 1) and the server enforces
delivery, so key rotation is defense in depth for claim 2 — it bounds
what a *stored* old key opens, and cuts off a departed member's key
material going forward:

- On any membership shrink (remove, leave, guest revoke) at current
  version `v`, the server stores `rotation_due.from_version = v`; the
  required successor is therefore exactly `v + 1` (the R18 editorial
  note — the prose and the stored structure now say the same thing).
- **The next member to send rotates first**: mint space key v+1, wrap
  to every current member with signed wraps, commit, then send under
  v+1. One actor, zero coordination, no ceremony — the first-responder
  pattern, safe now because the server is a trusted coordinator.
- Nobody special is required: any member can be the next sender. The
  owner leaving is nothing — the next sender rotates. A 2-person
  channel: the remaining member rotates on their next message.
- **Rotation is one atomic transaction (R16-2)** — the first review
  caught that a version ceiling serializes the version *number*, not
  which key becomes it: two responders uploading per-recipient wraps
  independently can hand different recipients different keys for the
  same version, and only then race the version bump. So wraps are
  never published piecemeal. One request carries everything:

  ```
  rotate_channel_key { channel_id, expected_version,
                       wraps: [ per-recipient signed_wrap(K_new) … ] }

  server, in one transaction: lock the channel row;
    require member(caller)
        ∧ rotation_due.from_version == expected_version
        ∧ current_key_version == expected_version;
    // rotation_due carries the version it was raised from, never a
    // bare boolean (P83-A-R17-N2) — a repeated shrink while a
    // rotation is pending re-marks from the same version; after
    // commit it clears, and a later shrink marks from_version = v+1
    validate exactly the current roster is represented, every wrap
        suite 2 with channel / version = expected+1 / recipient /
        signer = caller consistent;
    insert all wraps; current_key_version += 1; rotation_due = false.
  ```

  The winner commits; the loser gets `stale_key_version(current)`,
  fetches the winner's wrap, and proceeds — a mixed key generation
  cannot exist in any interleaving. At ≤ 64 members and ~188-byte
  signed wraps, one request is small; this is *simpler* than the
  existing multi-step reshare, not heavier.
- **And the send gate is frozen with it (R16-2)**: while
  `rotation_due`, an ordinary send under the current or an older key
  is rejected with `rotation_required` — otherwise a sender who has
  not yet observed the shrink sends under the old key and defeats
  "the next sender rotates first". The client's flow on that error is
  automatic: rotate atomically (above), retry the original send under
  the new key — the user's send stays one action. (The existing
  in-flight tolerance for old-key sends *across an ordinary
  completed rotation* is unchanged; the gate exists only in the
  rotation-due window.)
- Members who were offline pick up v+1 via the existing signed-wrap
  fetch path; old messages stay readable under retained old versions,
  exactly as today.

### D.3 The server pin — detecting a MITM toward home

Claim 3. chalkd gets a long-term **server identity** (Ed25519,
generated by `chalkctl init`, env-provisioned like other secrets — the
`CHALK_TOTP_ENC_KEY` pattern):

- **Pin at registration:** during signup the client fetches the server
  identity, the user confirms creation, and the key is pinned —
  IndexedDB plus the encrypted prefs backup, exactly like peer pins
  (phase 84 machinery). Registration is the trust anchor; a MITM
  present at first registration wins that device, stated plainly (the
  same first-contact limit TOFU always has).
- **The inner channel:** browsers cannot read TLS certificates or
  exporters, so application-level channel binding is built instead of
  assumed: at WebSocket open, the client sends an ephemeral X25519 key
  and a fresh 32-byte nonce; the server responds with its own
  ephemeral plus an Ed25519 signature under `chalk-server-id.v1` over
  the **transcript hash**, frozen (per the R16 review) as
  `SHA-256(u8(proto_version = 1) || client_eph_pub(32) ||
  server_eph_pub(32) || client_nonce(32) || server_ed25519_pub(32))`.
  Session keys are domain-separated per direction:
  `K_c2s = HKDF(ss, salt "chalk-inner-salt-v1",
  info "chalk-inner-c2s-v1" || transcript_hash)` and `K_s2c`
  likewise with `"chalk-inner-s2c-v1"` — and **every subsequent frame
  is sealed** (AES-256-GCM) under an independent, strictly
  monotonically increasing 64-bit per-direction counter, encoded as
  the frozen 96-bit nonce `u32be(0) || u64be(counter)` (R17's note —
  never implementation-chosen); a
  repeated or out-of-order counter closes the connection. A
  TLS-terminating MITM with a valid certificate can relay the
  handshake but cannot read or modify a single inner frame — it holds
  neither ephemeral secret, and it cannot re-sign a modified
  transcript against the pin.
- **Pin mismatch is a wall**, like the identity-changed wall: the
  client refuses the session and says what it means. A legitimate
  server-key rotation is an operator action with an explicit
  re-pin flow (documented in chalkctl), never silent.
- **What this does not cover, stated plainly:** a MITM that serves the
  SPA *bundle* itself delivers malicious code — endpoint compromise,
  unfixable from inside the page (an installed PWA with a cached
  bundle narrows the window; it does not close it). And theft of the
  server identity key is a **lost trusted endpoint** (claim 2's R19
  boundary): its holder passes this handshake as the server, presents
  any roster, and is auto-reshared channel keys — which is exactly
  why the key lives only in chalkd's live process, never in the
  storage claim 2 covers, and why exfiltrating it is classified with
  malicious chalkd rather than survivable breach.

### D.4 Migration

No epochs, no conversion, no read-only states — the envelope rides
inside the existing sealing, so old and new coexist:

- New builds always sign. A body whose plaintext parses as a
  `chalk-msg-sig.v1` envelope verifies per D.1; anything else renders
  as **`unsigned` (legacy)** — uniformly, one label, no alarm.
- Old builds keep working (their sends render as legacy on new
  builds); the existing update flow retires them at its own pace. The
  welcome advertises a minimum build for *signing* as a nudge, never a
  gate.
- The server-pin handshake ships default-on for new registrations and
  is adopted by existing sessions at next login (pin on first
  post-update login — TOFU'd like registration, stated as such).
- Enforcement end-state: a build-83 client always signs; there is no
  flag to send unsigned. `CHALK_WRAP_SIG_REQUIRED` stays what it is
  (phase 82's boundary); no new server flag is needed because the
  server cannot see inside the seal — the boundary is client
  rendering.

### D.6 Client-derived roster-change notices

Membership is server-asserted and its integrity is trusted (claim 1,
narrowed by R18-01) — but a database write is a real threat the trust
model does not defend, so the one thing that must never happen is a
membership change nobody sees. chalk already posts a join notice
(82-8), but it is emitted by the server off its own event stream: a
direct database insert produces no event and therefore no notice.
D.6 makes the notice **client-derived** so it fires regardless of how
the roster changed:

- Each client persists, per channel, the last roster it observed —
  the set of `(member, current identity fingerprint)` it has seen.
- On every roster it fetches (channel open, reconnect, the periodic
  refresh that already runs), it **diffs** against that stored set.
  Any addition, removal, or identity-fingerprint change that it did
  not already render from a normal membership event is surfaced as an
  in-channel notice — *"<user> was added to the channel"* /
  *"<user> was removed"* / *"<user>'s identity key changed"* — marked
  **observed**, distinct from an event-sourced notice, because its
  provenance is the roster diff, not a signed action.
- The notice is local UI, not a message: it is not signed, not sent,
  and not attributable to an actor (the whole point is that no
  trustworthy actor record exists for a DB insert). It says *what*
  changed in the membership the client now sees, never *who* did it.
- The property, stated precisely (the R19/R20 reviews' correction —
  never "silent changes are impossible"): **D.6 surfaces unauthorized
  roster changes to any existing client that observes the changed
  roster; it is detection, not prevention, and provides no guarantee
  against changes that are never observed.** An attacker who inserts
  and removes a principal entirely between two observations is not
  caught, and visibility timing follows refresh flows — consistent
  with the narrowed claim, and the honest most a
  server-asserted-membership design can offer.
- **The ordering is frozen so the notice precedes the key**
  (R19's inexpensive hardening, kept under R20's framing): fetch
  roster → compute the diff → persist and surface additions → **only
  then** may auto-reshare wrap to the new roster. The guarantee is
  mechanical, not human: the notice is *persisted and rendered*
  before any client of yours hands over a wrap — whether the user has
  read it yet is theirs; what the ordering promises is that the
  record always precedes the key, never the other way around.
- Consistency with the identity chain: a fingerprint-change notice
  reuses D.1's generation verification — an *unlinked* fingerprint
  change (no valid idgen chain to the prior pin) is the louder
  identity-changed wall, a *chained* one is the softer "rotated their
  key" line.

This is deliberately cheap: no new server endpoint (the roster fetch
exists), no wire change, no signature. It converts "membership is
server-asserted" from a silent trust into a visible one.

### D.5 Costs and accepted residuals

Envelope overhead: 64-byte signature + ~200 bytes of canonical fields
per object, inside the existing ciphertext — no wire-format change, no
flap fanout, no per-recipient work. Signing/verification is one
Ed25519 op per object.

| Residual | Treatment |
|---|---|
| Malicious/compelled chalkd | **Out of the trust model** (claim 1, decided 2026-08-09): a server that lies about membership is handed channel keys by honest clients. Visible (join notices, wrap provenance), not prevented. Federation stays gated on this (PHASE-88). |
| Server-storage disclosure | Reads all metadata (rosters, timing, sizes, edit/reaction graphs) and every ciphertext; **a storage breach opens nothing** (claim 2 — DB dumps, stolen disks, backups, logs, stored ciphertexts). Renamed from "host compromise (read)" per R20: "host compromise" implies broader control than obtaining a database dump. TOTP secrets decrypt on the host (`CHALK_TOTP_ENC_KEY`) → account access ≠ message plaintext (the encryption phrase never reaches the server). |
| Host compromise (live process) | **Outside claim 2 (P83-A-R19-01)**: reading chalkd's memory can exfiltrate the server identity key, whose holder passes the D.3 handshake, presents any roster, and is auto-reshared channel keys — so live-process compromise, like authorization-table writes, is a lost trusted endpoint, classified with malicious chalkd. Phase 99's in-memory hygiene raises the bar; it does not move the boundary. |
| Host compromise (write to authorization state) | **A real, undefended threat (P83-A-R18-01)**: a database write that inserts a principal into a roster makes honest clients wrap the channel key to it — no signature fails, because membership is server-asserted by design and the tables' integrity sits inside the claim-1 trust boundary. Mitigations, not guarantees: D.6 surfaces unauthorized roster changes to any existing client that observes the changed roster (detection, not prevention; no guarantee against changes never observed; the diff is persisted and rendered *before* any auto-reshare wraps), and phase 99 hardens the database credentials that make the write cheap. Stored *cryptographic* objects (ciphertexts, wraps, identity records) stay tamper-evident and fail closed. |
| First contact | Registration MITM wins that device's pins (server and peers alike); picture-word comparison remains the out-of-band upgrade. |
| Bundle delivery | A web client cannot verify its own code; a bundle-serving MITM is endpoint compromise. PWA caching narrows, does not close. |
| Deniability | Gone, deliberately: signatures are transferable proof of authorship. The fanout design's "authenticated for you" was the deniable alternative and retired with its threat model. |
| No FS / PCS | Unchanged non-goal (phase 22+). A stolen encryption phrase opens recorded history. |
| Replay / re-dating by the server | Detectable (replay triple, signed `sender_ts` shown alongside receipt time), not prevented; trusted not to happen (claim 1). |
| Removed-member window | Between removal and the next send, no rotation has happened; the server already withholds delivery (claim 1), and the stored-ciphertext exposure is bounded by D.2's next-sender rotation. |
| Malicious rotator | A current member acting as first responder can deliberately wrap *different* keys to different recipients — individually valid wraps the server cannot see inside (P83-A-R17-N1). No confidentiality gain (they are a member and minted the key); it breaks the channel for others: a malicious-member availability attack, detectable as decryption failure, and availability against malicious members is not a phase-83 claim. Stated, accepted. |

**Audit mapping:** H-01 (sender authenticity) — closed by D.1 within
the revised model: every object is signed by a pinned, generation-
resolved identity; server-frame relabeling yields `mismatch`, member
impersonation yields `forged`. C-01 — phase 82's signed wraps remain
the boundary and remain conditional only on the legacy-deployment
sweep; membership authenticity is **withdrawn as a goal**, not left
half-claimed. L-01 — unchanged, separate account-recovery work.

## Slices

| Slice | Content |
|---|---|
| 83-1 | Canonical envelope: encoders (exported helpers + `uuid16`), sign/verify, typed results, total parser, full mutation/replay vector suite — **landed 2026-08-09** (`web/src/crypto/envelope.ts`; see the slice record below) |
| 83-2 | Send/receive integration: sign-then-seal, verify-fail-closed rendering incl. `unsigned` legacy label, replay dedup store (`idb.ts` bump), send-flow reorder — **landed 2026-08-09** (see the slice record) |
| 83-3 | Append-only edits: `message_revisions` migration + atomic edit transaction, `fetch_revisions`, client ancestry classification; signed sealed reaction clears (delete the unencrypted-clear branch) — **landed 2026-08-09** (see the slice record) |
| 83-4 | Identity generations: the `chalk-idgen.v1` chain cert minted at rotation (R16-1), `(user_id, ed25519_fp)` fetch incl. retired + certs, chain-to-pin verification, `verified-former-identity` labelling, the chain-break wall — **landed 2026-08-09** (see the slice record) |
| 83-5 | Rotation-due: server marks on shrink; the atomic `rotate_channel_key` transaction + `rotation_required` send gate (R16-2); tests incl. owner-leave, 2-person channels, and the two-concurrent-responders race (no mixed generation in any interleaving) — **landed 2026-08-09** (see the slice record) |
| 83-6 | Server identity: chalkctl-provisioned keypair, registration pin + prefs backup, the inner sealed channel exactly as frozen in D.3 (transcript hash, directional HKDF domains, monotonic counters, close-on-violation), mismatch wall, re-pin flow |
| 83-7 | Client-derived roster-change notices (D.6): per-channel observed-roster store, the diff on every fetch, the observed add/remove/key-change notice distinct from event-sourced ones, fingerprint-change reusing the idgen verification, **the frozen diff-before-reshare ordering** |
| 83-8 | Docs + enforcement end-state: threat-model.md final wording, minimum-signing-build advertisement, CHANGELOG |

Each slice is independently verifiable; 83-1 through 83-4 and 83-7 are
pure client (plus one migration); 83-5/83-6 touch chalkd and chalkctl.

## Slice record

**83-1 (landed 2026-08-09)** — `web/src/crypto/envelope.ts` +
`envelope.test.ts`; the five canonical-encoding helpers exported from
`spacekey.ts` unchanged. Two points D.1 left open were frozen here and
now bind every later slice:

- **The identity fingerprint**: `ed25519_fp = SHA-256(raw 32-byte
  Ed25519 public key)`, no domain prefix — it is an identifier, not a
  signed statement; every canonical embedding it is itself
  domain-prefixed. This is the value 83-4's `(user_id, ed25519_fp)`
  lookup and the idgen chain must reproduce byte-for-byte, so the Go
  side implements exactly this.
- **Parser-level structural invariants** (violations are `malformed`,
  enforced by encoder *and* parser so no well-formed-but-invalid
  envelope exists): required uuids non-nil; key versions ≥ 1;
  u64 fields ≤ 2^53−1 on both encode and parse (two clients must
  never disagree on a value JS cannot represent); bodies strict
  UTF-8; an edit's sender equals its target sender (the "only the
  author edits" boundary sits in the parse, so a violating envelope
  can never apply); a reply's parent triple is all-or-nothing, and a
  parent hash without a triple is refused; attachment `byte_len ≥ 1`;
  emoji 1–32 bytes; an *explicit* all-zero h32/uuid where a value is
  required is refused (absent is expressed as null → zeros, never the
  reverse). Per D.4 a malformed body renders `unsigned` like legacy —
  only the sender can produce one, the seal guarantees that — but the
  parser keeps `legacy` and `malformed` distinct for tests and
  diagnostics.

The test suite asserts the frozen 0x01 layout byte-for-byte against an
independent hand-built encoder, and covers every slice-1 vector from
D.1: per-field mutation across all three types, raw byte-flip sweep,
cross-object/cross-channel confusion, truncation, trailing bytes,
absent-vs-zero, oversize caps, wrong-size signatures,
retired-generation labelling, foreign fingerprints, frame relabeling
(`mismatch`, inner wins), unpinned/resolver-failure, and the
replay-triple identity for all three types.

**83-2 (landed 2026-08-09)** — sign-then-seal on the send path
(`ChannelCrypto.signAndEncryptMessage`), fail-closed envelope opening
on every message-feed read (`openMessageForChannel` → the typed
verdict on each row, warning labels in the feed, "inner wins" on any
signature-valid verdict), the replay guard (`crypto/replay.ts` +
`replay_ids` store, IndexedDB v5), and the frozen send order
mint id → upload attachments → build → sign → seal → send. Decisions
made here:

- **writer_scope is the device id** (a uuid, stable per browser
  profile) and **wseq is a localStorage counter** per scope. Two tabs
  can race the counter; accepted — wseq is detection metadata, the
  replay identity's uniqueness comes from `client_msg_id`.
- **`client_msg_id` is now a bare uuid on the wire** (it is sealed
  into the envelope as `uuid16`); the optimistic row id keeps its
  `local-` prefix locally. The server always treated the field as
  opaque.
- **Replay binding is only written for signature-valid envelopes**
  (`verified` / `verified-former-identity` / `mismatch`): binding a
  forgery would let any key-holding member squat a victim's triple and
  turn a failed forgery into denial of rendering. `unpinned` is not
  bound either. The guard fails open on storage failure (replay
  detection degrades; rendering never does).
- **Malformed envelopes and non-message objTypes in a message slot**
  render as `unsigned` with the failure placeholder, never their bytes
  as prose (only the sender can produce them; the seal guarantees it).
- **Signer resolution is current-pin only** (82-2's store, one
  TOFU fetch per unpinned actor per session); a non-matching
  fingerprint is `forged` until 83-4 adds the retired-generation
  chain walk. `decryptForChannel` became the display-text-only path
  (previews, search) — it flattens envelopes without a verdict.
- **An edit downgrades the row's verdict to `unsigned`** until 83-3
  signs edits; the signed triple stays on the row (the revision chain
  re-anchors on it).
- **Open caveat: guest sends (GuestRoom) are still unsigned** and
  render as `(unsigned)` for members. Guests derive an identity from
  the link secret, so signing them is possible — folded into a
  follow-up slice, to be decided.

**83-3 (landed 2026-08-09)** — append-only edits (migration 0051 +
the atomic displace-then-overwrite in `store.EditMessage`,
`fetch_revisions`, tombstone purge), signed 0x02 edits and signed
0x03 reaction sets end to end, and the revision-chain walk
(`crypto/revisions.ts`). Decisions made here:

- **The revision cap refuses, never drops** (`MaxMessageRevisions =
  64`, the 65th edit errors): dropping rev 1 would orphan the chain
  from its original — the evidence the table exists to keep. rev_seq
  1 is the original body; N is what the Nth edit displaced.
- **Edit envelopes re-sign text only** (`attachments: []`): the
  attachment bindings stay anchored in the original envelope, which
  remains verifiable through the chain. Re-binding attachments in
  edits needs the original binding data client-side and is deferred.
- **Ancestry is three-valued** (`verified` / `forked` / `unknown`,
  `crypto/revisions.ts`): a live edit extending the held head
  verifies by hash comparison alone; history rows carrying an 0x02
  body start `unknown` (honest unverified-recency, amber `(edited)`
  marker) and upgrade via one background `fetch_revisions` + chain
  walk per row per session. A signature-valid edit applied to a row
  whose triple it does not target renders `mismatch`/`forked`. A
  verified chain also recovers the ORIGINAL envelope's hash, which
  re-anchors `sigObjectHash` so replies bind to the message, not its
  latest edit. Chain signatures verify under the sender's current
  resolved key; a mid-chain generation rotation reads `unknown`
  until 83-4's chain walk.
- **Reactions**: a signed target gets signed 0x03 sets — a clear is
  a signed sealed EMPTY set with a key version, so the server stores
  a row and never learns the set emptied. The unencrypted `""` clear
  verb survives only for legacy targets (pre-83 messages with no
  triple to bind), and the server's empty-body delete branch stays
  for old clients. Verification failures render as NO reactions
  (reactions have no warning surface; a bare unattributable tally is
  not worth showing), legacy sealed-JSON sets still open labelled
  unsigned, and a signed set whose target triple does not match the
  row it arrives on is refused (anti-relocation). `prev_set_hash` is
  best-effort chain metadata: empty sets are stored as absence, so a
  clear restarts the actor's chain — a verifier reads exactly that.
- **Edits and reactions are not replay-bound** (the 83-2 guard stays
  0x01-only): re-applying either converges by construction.

**83-4 (landed 2026-08-09)** — the generation chain
(`crypto/idgen.ts`: root hash, cert canonical, minting, the walk,
`chainStanding`), the server rotation primitive (migration 0052
`identity_keys.gen_cert`; `store.RotateIdentityKey` retires the
active generation and inserts the next in one transaction, requiring
the cert and exactly active+1; `fetch_identity_chain`), the
resolver's chain walk (`verified-former-identity` for a linked earlier
generation, forward resolution for a later one), and the pin
roll-forward vs. wall in `trust.ts`. Decisions made here:

- **No rotation existed before this slice** — `PutIdentityKey` only
  ever upserted, nothing set `retired_at`, and `deriveIdentity`'s HKDF
  does not mix the generation in, so a new generation means a new
  phrase (seed). 83-4 builds the *primitive*
  (`identity-sync.publishRotatedIdentity`) and everything that
  verifies its output; the user-facing phrase-rotation flow (new 24
  words, re-wrap every channel key to the new X25519 key, re-wrap the
  auth identity seed) is separate work, not started. Nothing calls the
  primitive in production yet.
- **The fetch shape is the whole chain**, not a per-fingerprint lookup:
  `fetch_identity_chain {user_id}` returns every generation with
  certs, and the client resolves the fingerprint locally after the
  walk. A user has a handful of generations; one request per actor per
  session (cached, re-walked after 60 s only when a lookup fails).
- **Publishing generation ≥ 2 IS the rotation**: the server requires
  `gen_cert` and refuses out-of-sequence numbers; re-publishing the
  already-active generation with the same key is idempotent (a second
  device after rotation). The server stores the cert blind — it is the
  party the cert defends against.
- **Pin roll-forward**: when `fetchTrustedIdentity` sees a key that is
  not the pin, it walks the chain; if the pinned key links forward to
  the active key the pin is rewritten (source carries over — the old
  key vouched for the new one; the safety-number digest is cleared, so
  the members panel reads "pinned" until the user compares again).
  Anything else is the existing identity-changed wall, untouched: a
  chain that does not reach the pinned key (the lost-seed new-root
  case, or a database write inserting an unlinked generation) rolls
  nothing, and messages signed by that key are `forged`.
- **A generation-1 root is bound to its user only through its hash**:
  the walk accepts any self-consistent root (that is TOFU's domain),
  but the root hash includes `uuid16(user)`, so a chain transplanted to
  another user id breaks at its first cert.
- **Our own retired generations** resolve through the same walk with
  our current key as the pin.

**83-5 (landed 2026-08-09)** — migration 0053
`channels.rotation_due_from` (set by every shrink to the current
version; `rotation_pending` kept equal to `IS NOT NULL` for old
clients and the badge), `store.RotateChannelKeyAtomic` (row lock;
member; `current == expected` and, when due, `due == expected`;
wraps name exactly the roster, all signed, within the blob cap; all
inserted at expected+1 then the bump and the clear — one
transaction), the `rotation_required` gate on `send` and
`edit_message`, and the client: `ChannelCrypto.rotateChannelKeyAtomic`
(every wrap built before the request, never published piecemeal),
rotate-before-send/edit (`rotateIfDue`), the ref-keyed
rotate-and-resend backstop for a `rotation_required` rejection, and
the catch-up effect no longer gated on the owner. Decisions:

- **The legacy two-step form stays accepted** (`new_version` without
  `wraps`, creator-only, clears the due mark too) so pre-83 clients can
  still rotate; the new client never uses it.
- **`rotation_due_from == current_key_version` is an invariant** while
  due — the gate freezes the version — so the client rotates from
  `currentKeyVersion` and the summary's `rotation_due_from` is carried
  for the record (R17-N2), not consumed.
- **Reactions are not gated.** An emoji set re-sealed under the old key
  in the due window is the accepted residual; gating it would need a
  rotate-and-retry path for a non-content write.
- **Owner-leave** reduces to any-member rotation: the existing
  cannot-remove-owner rule still forbids the owner's own removal, so
  "the owner leaving" is governed there, not here. A 2-person channel
  rotates with a single wrap (tested).
- **Guest revoke is not a shrink site today**: `RevokeEphemeralInvite`
  only voids the link; a redeemed guest stays a member until the room
  expires. If a guest-removal path is added it must call
  `RemoveMember` (or mark due the same way).
- **Guest senders cannot clear the gate** (GuestRoom has no rotate
  path); a guest's send in the due window fails until a member's next
  send rotates. Accepted — rare, and the member path clears it.
- The store race test (`TestRotateChannelKeyAtomic`: two goroutines,
  one winner, every v+1 wrap the winner's) and the client race test
  (`rotation-atomic.test.ts`) cover the two-concurrent-responders
  property from both sides.

## The decision record (2026-08-09)

The envelope-fanout design (no group key; per-recipient MAC flaps;
anchored membership with certificate chains; latterly a control chain
with in-band witnesses) was developed through twelve revisions, ten
internal reads and six external reviews — fifth/sixth independent
reviews and the R11–R14 delta series, all in `docs/audits/`. It was
retired undefeated on its own terms but unaffordable: P83-A-R15-01
showed that its central remaining gap — membership branch uniqueness
against an equivocating server — is only closable with quorum
certificates, witness committees, or an external notary. Rather than
adopt consensus machinery or ship a half-claim, scuq revised the trust
model (above): the server software is trusted, the host is not, and
the MITM claim is scoped to the registered home server. Under those
claims, this design — signed envelopes inside the existing sealing,
first-responder rotation, a pinned server identity with an inner
channel — delivers every stated property with roughly one-tenth the
machinery. The fanout plan remains in git history (`731eac5`) should
the malicious-server claim ever return; phase 98 (big rooms), which
was gated on fanout's membership layer, is re-gated on this design and
needs its own re-sketch before any review.

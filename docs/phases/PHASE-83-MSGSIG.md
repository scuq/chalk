# Phase 83 — MSGSIG: the signed sealed envelope

**Status: planned, not started — a fresh design under the revised trust
model (decided by scuq, 2026-08-09), superseding the envelope-fanout
design in its entirety.** The fanout plan's final text (twelve
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

**Tag:** `#msgsig`.

---

## The revised trust model — the claims, nothing more, nothing less

Decided 2026-08-09, and now the authority for every security statement
in this phase (threat-model.md carries the user-facing version):

1. **chalkd itself is honest.** The server software runs the protocol
   as written: it stores what it is given, delivers to whom it should,
   and asserts membership and ordering truthfully. chalk no longer
   claims any property against a chalkd that lies.
2. **The machine chalkd runs on is not trusted for confidentiality or
   stored-data integrity.** Malicious code beside chalkd may read
   server storage (database, disk, backups), read process memory, and
   **modify persistent server data**. **There must be no easy way for
   such code to read already-sent messages.** Nothing the host stores
   or observes may yield message plaintext: no plaintext at rest, no
   message keys, no channel space keys, and no *user* identity private
   keys ever exist server-side (chalkd necessarily holds its **own**
   server-identity private key — claim 3's signer; stealing it
   impersonates the server, it opens no history). The boundary with
   claim 1, made explicit (the R16 review): the model does **not**
   attempt to preserve protocol correctness if the attacker alters
   chalkd's executable code or live control flow — that is equivalent
   to a malicious chalkd and falls under claim 1. Claim 2 defends
   against what real host compromises overwhelmingly are: reading and
   tampering with *data*, and D.1's signatures are what make the
   tampering detectable.
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
  || h32(prev_generation_hash)                  // gen 2: the gen-1
                                                //   self-sig record hash
  || sig64                                      // by the PREVIOUS
                                                //   generation's Ed25519
generation_hash = SHA-256(canonical || sig64)
```

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

- On any membership shrink (remove, leave, guest revoke) the server
  marks the channel *rotation due, version v+1*.
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
    require member(caller) ∧ rotation_due
        ∧ current_key_version == expected_version;
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
  monotonically increasing 64-bit per-direction nonce counter; a
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
  bundle narrows the window; it does not close it). And host malware
  that steals the server identity key can impersonate the server —
  which under claim 2 still yields no message plaintext; it yields the
  server's own legitimate position.

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

### D.5 Costs and accepted residuals

Envelope overhead: 64-byte signature + ~200 bytes of canonical fields
per object, inside the existing ciphertext — no wire-format change, no
flap fanout, no per-recipient work. Signing/verification is one
Ed25519 op per object.

| Residual | Treatment |
|---|---|
| Malicious/compelled chalkd | **Out of the trust model** (claim 1, decided 2026-08-09): a server that lies about membership is handed channel keys by honest clients. Visible (join notices, wrap provenance), not prevented. Federation stays gated on this (PHASE-88). |
| Host compromise | Reads all metadata (rosters, timing, sizes, edit/reaction graphs) and every ciphertext; opens nothing (claim 2). Can steal the server identity key → impersonate the server, not read history. TOTP secrets decrypt on the host (`CHALK_TOTP_ENC_KEY`) → account access ≠ message plaintext (the encryption phrase never reaches the server). |
| First contact | Registration MITM wins that device's pins (server and peers alike); picture-word comparison remains the out-of-band upgrade. |
| Bundle delivery | A web client cannot verify its own code; a bundle-serving MITM is endpoint compromise. PWA caching narrows, does not close. |
| Deniability | Gone, deliberately: signatures are transferable proof of authorship. The fanout design's "authenticated for you" was the deniable alternative and retired with its threat model. |
| No FS / PCS | Unchanged non-goal (phase 22+). A stolen encryption phrase opens recorded history. |
| Replay / re-dating by the server | Detectable (replay triple, signed `sender_ts` shown alongside receipt time), not prevented; trusted not to happen (claim 1). |
| Removed-member window | Between removal and the next send, no rotation has happened; the server already withholds delivery (claim 1), and the stored-ciphertext exposure is bounded by D.2's next-sender rotation. |

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
| 83-1 | Canonical envelope: encoders (exported helpers + `uuid16`), sign/verify, typed results, total parser, full mutation/replay vector suite |
| 83-2 | Send/receive integration: sign-then-seal, verify-fail-closed rendering incl. `unsigned` legacy label, replay dedup store (`idb.ts` bump), send-flow reorder |
| 83-3 | Append-only edits: `message_revisions` migration + atomic edit transaction, `fetch_revisions`, client ancestry classification; signed sealed reaction clears (delete the unencrypted-clear branch) |
| 83-4 | Identity generations: the `chalk-idgen.v1` chain cert minted at rotation (R16-1), `(user_id, ed25519_fp)` fetch incl. retired + certs, chain-to-pin verification, `verified-former-identity` labelling, the chain-break wall |
| 83-5 | Rotation-due: server marks on shrink; the atomic `rotate_channel_key` transaction + `rotation_required` send gate (R16-2); tests incl. owner-leave, 2-person channels, and the two-concurrent-responders race (no mixed generation in any interleaving) |
| 83-6 | Server identity: chalkctl-provisioned keypair, registration pin + prefs backup, the inner sealed channel exactly as frozen in D.3 (transcript hash, directional HKDF domains, monotonic counters, close-on-violation), mismatch wall, re-pin flow |
| 83-7 | Docs + enforcement end-state: threat-model.md final wording, minimum-signing-build advertisement, CHANGELOG |

Each slice is independently verifiable; 83-1 through 83-4 are pure
client + one migration; 83-5/83-6 touch chalkd and chalkctl.

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

# Seventh Review of Phase 83 — Envelope Fanout: Independent Cryptographic Audit

**Review date:** 2026-08-08

**Design reviewed:** the phase-83 plan (envelope fanout) in
[`../phases/PHASE-83-MSGSIG.md`](../phases/PHASE-83-MSGSIG.md) — the
fifth revision (commit `927e998`) plus the working-tree additions at
review time: the non-normative §A.0 walkthrough and the sixth-review
status note. The R6 findings are acknowledged in that note but **not
incorporated** in the normative text.

**Reviewer lens:** cryptographic security audit — primitives, key
schedule, domain separation, AEAD and nonce discipline, binding and
malleability, replay, deniability and forward-secrecy claims — plus
independent re-verification of the open prior findings.

**Prior reviews:** rounds one through four exist only as disposition
tables in the phase doc (the files were retired as each round was
absorbed). The fifth and sixth review documents were removed with this
review; their load-bearing content is recorded in the phase doc's
disposition tables and in the next two sections. From this round on,
the review record lives in `docs/audits/`.

## Record of the fifth and sixth reviews (carried forward)

**Fifth review** (of commit `eb1ee873`, the fourth revision):
independently re-verified all five fourth-review blockers
(P83-A-R4-01 … 05 — backup merge ordered trust roots by `policy_p`;
non-atomic page overwrite; unsignable guest expiry; fork fallback
un-verifying removals; Gate F over era-less presence) and added
**P83-A-R5-01**: the receive pipeline never checked the sender's
membership, while pairwise MAC keys survive removal — an ex-member plus
a malicious server could inject `authenticated-for-you` messages
forever. All six were incorporated in the fifth revision.

**Sixth review** (of the fifth revision): verified all six blockers
genuinely closed in the text, then found **P83-A-R6-01** (blocking —
the directional-assurance latch falsely flags departed-member and
lapsed-guest history on every restored or long-dormant device, training
users to ignore `unauthorized-sender`) and **P83-A-R6-02** (concurrent
mints can push members-plus-guests past `MAX_FLAPS = 64` into signed
state with no frozen resolution). It also settled scale: performance at
the frozen cap is a non-issue on every axis (108-byte flaps, ~6.8 KiB
send overhead at N = 64, O(1) receive crypto), and 512-member rooms are
out of scope by construction — upload O(N), delivery O(N²) (~54 KiB
per-message overhead and ~28 MB server egress per message at 512), so
larger rooms are a different message layer, not a larger cap. Both
verdicts are adopted by this review and not re-litigated.

## Status of the open findings — re-verified against the text

**P83-A-R6-01 — confirmed open.** §A.5's directional-assurance clause
still reads "Fresh devices lose nothing real: their pre-join scrollback
arrives grantor-attested as `granted`"
([PHASE-83-MSGSIG.md lines 512–517](../phases/PHASE-83-MSGSIG.md#L512-L517)).
That is true only for new members. A restored device of an *existing*
member has post-join scrollback for which no grant exists or can (there
is no grantor for one's own membership), so every message from every
since-removed or since-departed member re-arrives as
first-fetched-after-removal and renders `unauthorized-sender`; the
guest rule ([lines 578–589](../phases/PHASE-83-MSGSIG.md#L578-L589))
does the same for all lapsed-guest history, and guests always lapse.
The required `former-member`/`unauthorized-sender` split and the frozen
live-path/backfill boundary are absent. Still blocking.

**P83-A-R6-02 — confirmed open.** §A.5's cap accounting
([lines 482–491](../phases/PHASE-83-MSGSIG.md#L482-L491)) enforces
members-plus-active-guests ≤ 64 client-side at mint, with the server
check named convenience. Two authorized actors each seeing 63 still
mint concurrently to 65 valid certificates — state every client
verifies but no client can send under (the parser refuses > 64 flaps;
§A.7 forbids omitting a valid member). Neither a deterministic shed
rule nor mint-time headroom below the wire cap appears. Still open.

**Sixth-review completion items — still open:** the commit record's
real page bound (~183, not the u8's 255); the note that one full
64-member channel alone overflows the ~60-pin blob budget; the
threat-model sentence scoping group messaging to 64 participants.

## The cryptographic core, audited

Each mechanism was checked independently, from the frozen bytes, not
from prior reviews' summaries.

### Key schedule (§A.2) — sound

- **Domain separation is complete.** Every derivation has a distinct
  ASCII context; the pair root uses a real salt while subkeys separate
  on `info`; `K_mac`/`K_wrap`/`K_history` never cross nonce domains
  (the P83-A-R2-06 fix); the grant AAD subtype byte (0x01/0x02)
  separates history from legacy-key grants below the type string.
- **No encoding ambiguity in KDF inputs.** All `info` fields are
  fixed-width (16-byte UUIDs), so no concatenation aliasing exists.
  Directionality (`uuid16(A) || uuid16(B)`) makes reversed-direction
  tags fail, and the vectors cover it.
- **Contributory-behavior checks present**: all-zero X25519 output
  rejected before any HKDF; non-32-byte public keys rejected.
- **The self-flap** MACs under `K_mac(A→A)`, computable only with A's
  private key. Sound.

### Envelope binding (§A.3) — sound; the binding graph closes

Verified against the inherited canonical (checked in git history at
`927e998^`: it carries `channel_id`, `key_version`, `sender_user_id`,
`writer_scope`, `client_msg_id`, `sender_ts`, parent binding and
attachment bindings):

- body AAD binds the channel; flap AAD binds channel, recipient and
  `sha256(body_ct)`; the MAC binds canonical and `sha256(body_ct)`
  jointly; the canonical binds sender and channel. Consequences, each
  traced: **cross-channel replay** dies at both AEADs (AAD mismatch);
  **cross-recipient flap swap** dies at the flap AAD and the parser's
  sorted-unique rule; **canonical/body mix-and-match** dies at the
  joint MAC; **eph_pub substitution plus re-wrap** dies at the body
  AEAD (the substitute cannot know `msg_key`) or at the MAC.
- The deliberate choice **not** to MAC the flap bytes themselves costs
  nothing: `msg_key` integrity is enforced by the body AEAD tag, wrap
  integrity by the flap AAD, and a corrupted flap is at worst the
  denial a relaying server can always inflict by dropping.
- Parsing is total, length-equation-exact, with the 16-byte GCM floor
  on `body_ct` and both size caps. No allocation before bounds.

### Arithmetic — re-derived

Flap `16 + 12 + 48 + 32 = 108` ✓; backup record 93 bytes ✓; page
budget ⇒ 63 records ✓; commit record ⇒ ~183 pages ✓. One slip: §A.8's
per-message overhead "`34 + N×108`"
([line 889](../phases/PHASE-83-MSGSIG.md#L889)) matches no field sum —
the fixed header is `1 + 32 + 2 = 35` bytes, and the true fixed cost
beyond `body_ct` is `47 + 16 = 63` (header + body nonce + GCM tag).
One-line fix (completion item 3).

### Claims audit — honest

- **Deniability**: correct as stated. HMAC over pairwise secrets means
  every verifier is a possible forger; "authenticated for you" is the
  accurate name, and no transferable proof exists anywhere in the
  design. The claim survives edits, reactions and voice signals.
- **No FS / no PCS**: stated plainly, and the self-flap's consequence —
  static-key compromise plus recorded ciphertexts recovers every old
  message key — is admitted in §A.8 rather than hidden.
- **Nonce discipline**: the body key is one-time; flap keys are fresh
  per (message, recipient) via the ephemeral. The two *static*-key
  AEAD domains — `K_wrap` (voice signals) and `K_history` (grant
  chunks) — use random 96-bit nonces under long-lived keys, which NIST
  SP 800-38D bounds at 2³² invocations per key. Unreachable at chalk
  scale, but the freeze should state the bound (completion item 6).

## New finding

### P83-A-R7-01 — The Gate-F interregnum: a build-F client can emit neither suite, so every channel is read-only from bundle deploy until the epoch is deliberately flipped

**Severity:** High — availability, cluster-wide, on the normal
deployment path

**Disposition:** Blocking (a hole in the frozen migration sequence,
the same class as R2-07/R4-05)

Three frozen rules compose into an unstated outage:

1. **No-suite-1 is absolute**: "a build-F client never originates
   suite 1. Not for a channel the server calls legacy, not on
   rollback, not anywhere"
   ([lines 685–687](../phases/PHASE-83-MSGSIG.md#L685-L687)).
2. **Emission waits on the barrier**: "conversion and fanout emission
   begin only behind the barrier … a build-F client neither converts
   nor emits suite 2 until [`era_enforced`] is true"
   ([lines 956–961](../phases/PHASE-83-MSGSIG.md#L956-L961)).
3. The adoption machine
   ([lines 693–706](../phases/PHASE-83-MSGSIG.md#L693-L706)) has no
   suite-1 branch; its non-adopted terminal state is read-only.

Therefore between the moment the build-F bundle reaches a device and
the moment `era_enforced` becomes true, that client can send
**nothing, in any channel**. chalk ships chalkd and the SPA as one
image, and `chalkctl` updates it on a weekly *automatic* timer — while
the epoch is flipped "once, deliberately, by `chalkctl fanout gate-f`"
([lines 937–939](../phases/PHASE-83-MSGSIG.md#L937-L939)), a manual
step. The window is unbounded and can open with no operator present:
the timer fires overnight, every user wakes to a server that talks and
a client that cannot. This violates the design's own first principle —
a design must not protect a conversation by preventing its use — via
deployment mechanics rather than cryptography.

The adversarial shadow of the same gate: a **malicious server that
advertises `era_enforced = false` forever** holds every build-F client
read-only indefinitely — a quiet, targeted denial. It is bounded
(denial only; no-suite-1 means no downgrade), but it is nowhere in
§A.8's residual table.

**Required correction** — any one of, plus the residual line:

- **couple the flip to deployment**: when `chalkctl update` ships the
  first build-F image, it performs the gate-f flip in the same
  operation once every instance is updated — on the single-instance
  deployments chalk targets, update and flip become one breath; or
- **serve the pre-F bundle until enforced**: chalkd owns the SPA, so no
  build-F client need exist before the epoch — the flip then *causes*
  the client rollout instead of racing it; or
- at minimum, **freeze the window**: state the read-only interregnum,
  its owner (the operator), and the UI it shows.

And in §A.8: name the `era_enforced`-withheld-forever residual as the
denial it is.

## Completion items (non-blocking)

1. **`claimed_sender` provenance.** §A.5's receive pipeline says
   "derive `K_mac(claimed_sender→me)`" without saying where the claim
   comes from. The inherited canonical carries a sealed
   `sender_user_id` (verified in git history), so the intended rule is
   derivable — but it must be stated: *the claimed sender is the
   canonical's `sender_user_id`; outer server metadata is display-only
   and never selects the MAC key.* If an implementation instead keyed
   off the server's sender label, a relabel would manufacture false
   `forged` evidence against an innocent third member — the same
   false-evidence class as R6-01. One sentence; the A-4 vectors need
   it anyway.
2. **Replay identity.** Confirm the retired plan's first-seen rule —
   `(sender, writer_scope, client_msg_id)` → first-seen server id —
   survives the A-3 re-freeze, so a server-replayed envelope is a
   duplicate, not a fresh message. (Ordering and timing remain
   server-controlled; that is already accepted with receipt-time
   timestamps.)
3. **§A.8 overhead arithmetic**: replace "`34 + N×108`" with the true
   fixed cost (35-byte header; 63 bytes beyond `body_ct` including the
   body nonce and tag).
4. **Backup generation rollback.** `gen16` is random and the commit
   carries no monotonic counter, so a *complete* older generation is
   indistinguishable from current to a fresh device. Bounded by the
   stated fresh-device residual, and devices with prior state are
   protected by the `rev` merge — but a `u64` repack counter in the
   commit, floor-latched like `rev`, would close it for a few bytes.
5. **Guest identity is link possession.** The guest keypair is a pure
   function of the fragment secret, so every holder of the link —
   including the minting owner — is the same cryptographic principal
   and can speak as the guest. Consistent with "authenticated for you"
   plus the guest label, but it belongs in §A.8's residual table.
6. **State the SP 800-38D bound** for the two static-key AEAD domains
   (`K_wrap`, `K_history`), as above.
7. **Backup KDF IKM is the identity X25519 scalar** (§A.7). HKDF is
   one-way, so the backup key leaks nothing about the scalar and the
   scalar holder can decrypt everything anyway — acceptable. Key-
   separation hygiene would derive from the identity seed entropy
   instead; note only.

## Checked and found sound (negative results, for the record)

Mix-and-match across flap/body/canonical; cross-channel and
cross-recipient replay; MAC direction confusion; self-flap self-MAC;
KDF info aliasing; the `sig64` no-length-prefix convention and every
`*_hash = SHA-256(canonical || sig64)`; the manifest one-owner rule and
converter/owner slot split; `manifest_admit_ref` derivation; the
monotonic omit latch's intersection/union roster under forks; the
atomic guest mint/revoke transactions and directional skew; the
double-buffered backup commit protocol (a crash at every write point
leaves the old generation fully intact; the commit overwrite is the
one atomic switch); the era door's owner-only signature rule; the
`key_version = 0` cross-layer inventory. No break found in any of
them.

## Verification performed

- Read the full phase doc at the working tree (fifth revision + §A.0 +
  the status note); confirmed §A.0 is marked non-normative and
  consistent with §A.2–§A.9.
- Re-verified R6-01 and R6-02 from the normative text, not the sixth
  review's summary.
- Checked the inherited canonical envelope's field list against the
  retired transcript plan in git history (`927e998^`), which is what
  resolves completion item 1 and grounds the binding-graph analysis.
- Re-derived all frozen arithmetic (flap, record, page, commit,
  per-message overhead — finding the §A.8 slip).
- No code was executed; the phase remains design-only. This is a
  documentation and git-history-assisted protocol audit.

## Verdict

The cryptographic core is sound. No primitive-level, binding-level or
key-schedule break was found in this round, and the state-machine
repairs the earlier rounds forced — monotonic latches, atomic commits,
two-sided membership enforcement — compose correctly with the crypto
they protect. The design's claims (deniability, no FS/PCS, O(1)
receive) are honest as written.

The gate still fails, now on three items, none of them cryptography:
**P83-A-R6-01** and **P83-A-R6-02** (carried forward, independently
re-verified open) and **P83-A-R7-01** (new — the deployment
interregnum). All three are text-local; none needs new primitives, a
coordinator, or a user ceremony.

**Retain envelope fanout. Gate 0 does not pass at the fifth revision.
Apply R6-01, R6-02 and R7-01, fold in the completion items, and
re-review that delta before slice A-1 lands.**

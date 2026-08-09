# Independent Security Review — Phase 83 MSGSIG (R17: second review of the signed-envelope design)

**Review date:** 2026-08-09

**Scope:** the second revision of the signed-envelope design (R16
findings folded).

**Verdict: Gate 0 almost passes — one High blocker remains,** small to
fix, plus two non-blocking hardening items. The two previous High
findings (R16-1/R16-2) are structurally fixed; none of the old
fanout/control-chain machinery should return.

| Area | Result |
|---|---|
| Retired identity authenticity | Architecture fixed |
| Atomic first-responder rotation | Fixed |
| rotation_due send gate | Fixed |
| Host/chalkd trust boundary | Clear |
| Inner server-pinned channel | Sound design |
| Signed envelope | Good |
| **Identity-generation certificate encoding** | **High / blocker** |
| Malicious rotator causing key split | Hardening / accepted-availability candidate |
| Rotation transaction validation wording | Tighten |

## P83-A-R17-01 — generation_cert signs/hashes sig64 twice

**Severity:** High / Blocking specification contradiction

The definition places `sig64` inside the canonical *and* appends it
again in `generation_hash = SHA-256(canonical || sig64)`, while saying
the signature is by the previous generation — leaving the actual
signature input circular/ambiguous. A signature cannot be part of the
bytes it signs. Required (the convention the plan already uses
elsewhere):

```
canonical        = utf8("chalk-idgen.v1") || uuid16(user)
                   || u32be(generation) || h32(new_ed25519_fp)
                   || h32(sha256(new_x25519_pub))
                   || h32(prev_generation_hash)
sig64            = Ed25519(previous_generation_priv, canonical)   // NOT in canonical
generation_hash  = SHA-256(canonical || sig64)
```

Mutation tests: changed generation; changed new Ed fingerprint;
changed X25519 hash; changed predecessor; wrong signing generation;
truncated/65-byte signature; a valid cert transplanted to another
user.

**Bundled into the same fix: freeze the generation-1 root hash** —
"the gen-1 self-sig record hash" must be exact bytes two
implementations compute identically without consulting mutable
database metadata, e.g.:

```
generation1_hash = SHA-256(utf8("chalk-idgen-root.v1")
    || uuid16(user) || h32(ed25519_fp)
    || h32(sha256(x25519_pub)) || self_sig64)
```

## P83-A-R17-N1 — A malicious rotator can publish inconsistent wraps

**Severity:** Low / accepted-availability candidate

The atomic transaction prevents *accidental* mixed generations, but
the server cannot see inside wraps: a malicious current member can
intentionally wrap different keys to different recipients — all
individually valid suite-2 wraps. No confidentiality gain (they are a
current member and minted the keys); it breaks the channel for others:
malicious-member DoS, detectable as decryption failure. Should not
block Phase 83 unless availability against malicious members is
claimed — state it. (Optional cheap hardening: a
`SHA-256(K_new)` commitment in authenticated wrap metadata; not worth
modifying phase 82's frozen wrap canonical for on its own.)

## P83-A-R17-N2 — Make the transaction predicates exact

Non-blocking. `rotation_due` should carry the version it was raised
from (`rotation_due.from_version = v`) and the transaction should
require `from_version == expected_version == current_key_version`,
`new = expected + 1` — a version-bound due marker is harder to
misimplement than a Boolean, especially across repeated shrinks while
a rotation is pending (the "exactly current roster" rule already
handles the roster side).

## Passing on this round

- **Host-compromise wording:** the claim-1/claim-2 boundary is now
  explicit and coherent; the user-scoped key statement plus the
  separate server-key acknowledgement is correct.
- **Identity chain design** (with R17-01 corrected): the verification
  rule — current identity must equal the pin; retired identity must be
  on a valid chain terminating at the pin — means database malware
  cannot invent a fake historical generation; the key-loss semantics
  (chain break → wall → no invented continuity) are honest.
- **Inner channel:** transcript contents and directional domains are
  right; monotonic counters are straightforward over ordered WebSocket
  delivery. One tiny note for D.3: define the 96-bit GCM nonce
  encoding explicitly (e.g. `u32be(0) || u64be(counter)`).
- **Rotation:** the new flow closes the dangerous interval (old-key
  send after an unnoticed removal) and the concurrent-responder race;
  R16-2 is closed.

## Gate assessment

After R17-01 (and unless the exact root definition exposes something
unexpected), **comfortable moving toward Gate 0 PASS**. The contrast
with the previous design is substantial: the discussion is now a
malformed certificate definition and minor state-machine hardening,
not fundamental group-consistency impossibilities.

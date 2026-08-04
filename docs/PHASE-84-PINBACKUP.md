# Phase 84 — Identity pin backup

Restoring the trust ledger after a browser profile is lost. Planned against
v0.7.0, after phase 82.

**Status: complete (84-1 … 84-3).** Client-only: no migration, no new frame, no
server change, no `chalkctl` change. The blob rides the prefs sync that has
carried the notification rules since 50-6.

---

## The problem

Phase 82 made a pin the anchor of the whole trust story: the crypto path refuses
key material signed by a repudiated pin, and the members panel reports
`recognised` / `verified` / `key changed` off the same record. That record lives
in IndexedDB, and IndexedDB dies with the browser profile — cleared site data, a
new machine, a reinstall, a different browser.

The lost `verified` ticks are the visible half and the lesser one. The pins are
what matter: with none, every peer is `first_seen`, and *first sight is the one
moment TOFU cannot defend*. A server that wants to substitute a key needs the
target to have no pin — and wiping a profile hands it exactly that, on a
schedule the user chooses for unrelated reasons.

## What ships

| | |
|---|---|
| 84-1 | `crypto/pin-backup.ts` — the blob format, the merge, the capacity rule. Pure; 21 tests. |
| 84-2 | `crypto/pin-sync.ts` — the orchestrator, plus `listVerifications` / `subscribeVerifications` in `crypto/idb.ts` and the two effects in `App.tsx`. 10 tests. |
| 84-3 | The `verified identities` section in settings: what is backed up, what did not fit, and which peers your devices disagree about. |

## Design

**Transport.** One flat prefs key, `identity_pins_enc`, holding base64 of
`nonce || AES-256-GCM(...)`. The key is HKDF-SHA256 over the identity's X25519
scalar with this blob's own salt/info — the construction `crypto/prefs-blob.ts`
already provides and the notification rules (50-6) and per-peer audio list
(66-3) already use. The server stores JSONB it cannot read and fans it out via
`prefs_changed`, which is the whole cross-device story for free.

Deriving from the identity is what makes this a *restore* rather than another
thing to have backed up: the scalar comes from the 24-word encryption phrase,
which already survives storage loss. Unlock the identity and the pins return
with the messages. There is no second secret and no file to have kept.

**Format.** A packed pin is
`[peerUserID, ed25519PubB64, generation, pinnedAt, verifiedAt, digestHex?]`,
timestamps in seconds. The safety-number digest is *absent* whenever the key is
present, because it is derivable from it — `hydratePins` recomputes it from the
pinned key and this identity's own. Storing it too would be storing one fact
twice in a form that can contradict itself, and it costs 70% more per record.
Only a pre-82 record, which pinned a digest and no key, carries one.

**The merge is the design.** Two devices can hold different keys for one peer,
and the rule that resolves that decides whether this feature protects the user
or defeats the mechanism it is backing up. The tempting rule — newest wins — is
wrong, and dangerously so: a fresh device served a substituted key pins it
without complaint (it has nothing to compare against), and "newest wins" would
then propagate that pin to the device holding the real one, silencing the alarm
that device was about to raise. So:

- **same key** — merge metadata: strongest provenance, earliest sighting, latest
  comparison;
- **one side compared** — the out-of-band comparison wins. Only the user can make
  one, and the server cannot forge one into a sealed blob;
- **neither compared** — the **earlier** sighting wins.

The last rule is TOFU's own principle carried across devices. Its cost is
honest: a peer who legitimately reinstalled reads as `key changed` until someone
compares the new number out of band. That is an alarm rather than a silent
adoption, and one comparison settles it for every device at once.

Because the rule is a total order over any two records, both directions use it —
what a device keeps and what it uploads are the same merge. Two devices that
disagree converge instead of overwriting each other forever. A device whose
storage was wiped holds nothing, so the merge can only teach it; it cannot
publish its emptiness over the set the others depend on. That is the one place
this differs from `rules-sync.ts`, which is whole-blob last-write-wins.

**Change detection is on content, not ciphertext.** Every seal draws a fresh
nonce, so re-sealing an unchanged set yields a different blob; without
`canonicalPins` two devices would echo each other's blobs forever.

**Capacity.** The server caps one prefs patch at 8 KiB
(`prefsMaxBytes`, `internal/server/ws.go`). A packed pin is ~95 bytes, so the
ceiling is near 60 peers. `fitPins` orders comparisons before sightings (a
comparison cost a human conversation; a sighting cost nothing), then most recent
first, and reports what did not fit — to the console and in the settings
section. A cap nobody is told about reads as "everything is backed up".

## What the server can still do

Withhold the blob, or serve an older one. Neither gains it anything, because the
merge only ever adds a record or strengthens the evidence behind one: a stale
copy cannot delete a pin or downgrade one, and a withheld copy leaves the device
exactly where it would have been with no backup at all. **That is why there is
no rollback counter here** — there is nothing for a rollback to undo. A tampered
blob fails its GCM tag and is discarded, and an unreadable blob is *not*
overwritten: it may be a newer format this build does not know, and pins are
expensive to re-establish.

What it cannot do is forge a pin. It has no key.

## Verification

`node test.mjs` covers the format, the merge (including the laundering case and
convergence), the capacity rule, and the sync loop against a fake store and
transport — 31 tests.

**The end-to-end run against a live stack is done** (unlike phase 82's, which is
still outstanding). The prefs round-trip is the one thing no unit test can
reach, so it was driven through the real SPA with the run-chalk probe: two
users, friended, one channel, the members panel opened to pin the peer, then the
`verifications` store wiped with the identity left intact — precisely what a
cleared profile does to the trust ledger — and the page reloaded. 10/10:

| | |
|---|---|
| the peer is pinned, badge reads `recognised` | the starting state |
| `prefs ? 'identity_pins_enc'` is true in Postgres | the upload actually happened |
| blob is 196 bytes | one pin; the 8 KiB cap is far off |
| the blob does not contain the peer's UUID | the server is holding ciphertext |
| settings reads `backed up: 1 person` | |
| after the wipe: 0 records | the loss is real |
| after the reload: 1 of 1 restored, **same key** | the restore is real |
| badge still reads `recognised` | the peer is not a stranger again |

Worth re-running whenever the blob format or the merge changes; the probe is one
rewrite of `.claude/skills/run-chalk/probes/ui.mjs`.

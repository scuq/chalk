# Notifications

Sounds built in phase 40; the full notification system — rules engine, OS
banners, tab blink, unread badge, encrypted cross-device sync — in phase 50.
Client-side end to end: the server stores one opaque ciphertext blob and
otherwise knows nothing about any of this.

## The model: bus → rules → priorities → sinks

```
frame handlers ──normalize──▶ bus (NotifyEvent) ──▶ resolvePriority(event, rules) → mute | 1..4
                                                          │  user > channel > type default
                                                          ▼
                                          profiles[priority] → { sound, banner, blink }
                                                          │
                       ┌──────────────────────────────────┼─────────────────────┐
                       ▼                                  ▼                     ▼
                 sound sink                        banner sink             blink sink
             (synth.ts, gate.ts)                  (banners.ts)             (title.ts)

read cursors / thread inbox / friend requests ──▶ badge (badge.ts; independent of all of the above)
```

Two indirections, both deliberate:

- **Rules assign priorities, never actions.** Defaults per event type,
  overridable per user and per channel; most specific wins (a person you
  singled out beats the channel it happened in, which beats the kind of thing
  it was). Mute is priority 0. Consequence to know about: a muted channel
  also mutes mentions in it — a per-user rule is the way to punch through.
- **Priorities map to actions once, globally.** "This friend should banner"
  is expressed as "this friend is P4" plus "P4 banners". Changing what P4
  means updates every P4 rule at once.

Modules: `web/src/notify/` — `bus.ts` (event stream), `rules.ts` (the pure
engine + edit helpers), `rules-store.ts` (persistence), `classify.ts` (which
event a message is), `events.ts` (which event a non-message frame is),
`gate.ts` (moment-level suppression for sounds and banners), `synth.ts`,
`banners.ts`, `title.ts`, `badge.ts`, `rules-sync.ts`. The one consumer that
ties bus to sinks lives in `App.tsx`.

## Event types

| Type | Default priority | Fires on |
|---|---|---|
| `mention` | 4 | someone writes your handle in a channel |
| `dm` | 4 | any message in a 1:1 — thread replies in a DM included |
| `thread_reply` | 3 | a reply in a thread you wrote in, outside DMs |
| `channel_added` | 3 | you're added to a channel |
| `friend_request` | 3 | a friend request arrives (accept/decline/removal stay quiet) |
| `voice` | 2 | a call **starts** — someone else joins an *empty* voice room; later joiners are silent, and scratchpad chat never notifies |
| `governance` | 2 | a proposal opens or resolves, except your own |
| `message` | 1 | any other new message |

Exactly one event per arriving message: the four chat types are a precedence
order (`classify.ts`). A DM outranks a mention, because in a 1:1 the channel
already tells you the message is for you. Mentions are derived on-device from
the decrypted body — bodies are ciphertext, so the server can never know
about them (see migrations 0043/0047 for that refusal).

Default action profiles: P1/P2 `{sound}`, P3 `{sound, blink}`, P4
`{sound, banner, blink}`.

## Sinks

**Sound** — the chalk-stroke pack, unchanged from phase 40 (design notes
below). The gate (`decideSound`) applies moment-level suppression with named
verdicts: already-watching (tab focused + relevant surface open + not idle),
DND, 2 s global / 5 s per-category rate floors, audio-unlock. The per-category
pref check now applies only to machine noises — a muted event type never
reaches the gate.

**Call sounds** (71-1) — `call_join`, `call_leave`, `peer_join`,
`peer_leave`, fired by `voice/session.ts` through `NotifySounds.playCall`.
Machine noises, but the only ones that default **on**: they can't fire
outside a call, and inside one they are the only thing that says who came
and went. Two departures from the ordinary path, both because a call has no
surface you could be "already watching" — `playCall` passes
`isRelevantSurfaceOpen: false` (hearing that someone arrived is the point
even while you look at their tile), and they use a 400 ms floor against
themselves instead of the shared 2 s / 5 s ones, which they neither read
nor spend. Peer sounds follow the *tile*, not the roster: what you hear is
what appears on the stage, including a peer whose connection failed.

**OS banners** (`banners.ts` + `decideBanner`) — page-context `Notification`
with the decrypted sender/preview, rendered locally by the OS; nothing leaves
the device. No rate limit and no unlock: collapse is the OS `tag` mechanism
(one banner per channel / per thread / per concern), which also dedupes
across tabs. Banners close themselves when the thing they announced is read
— on any device, since read cursors sync — and clicking one focuses the
window and lands in the right channel or thread. Permission is requested
only from the settings toggle, never on load. Platform reality: desktop
Chrome/Firefox/Safari work; **Android Chrome throws** on page-context
construction (needs a service worker chalk doesn't have) and iOS lacks the
API — a probe turns that into "unsupported" and the UI hides the feature.
macOS may re-alert on tag replacement; accepted.

**Tab blink** (`title.ts`) — the title alternates with a ● marker until the
tab regains focus or visibility. Never starts while the window is visible
and focused (nothing would clear it). One controller owns `document.title`
for both the blink and the badge count, so the two can't fight. DND silences
blink along with sounds and banners.

**Badge** (`badge.ts`) — `"(n) chalk"` in the title plus
`navigator.setAppBadge` where installed. Pure derivation of read-cursor
state — unread DMs + mentioned channels + involved unread threads + open
friend requests — the "needs you" line the thread inbox drew, not raw
volume. Deliberately exempt from rules and DND: silencing interruptions is
not hiding what's waiting.

## Rules UI

- **NotificationsPanel** (profile → notifications → "notification rules…"):
  the P1–P4 action matrix, per-event-type defaults with sound previews, and
  the per-person / per-channel rule lists (add, change, remove).
- **Sidebar context menus**: right-click or long-press a friend or channel →
  set priority or mute on the spot. Same store, same helpers (`withUserRule`
  / `withChannelRule`), so a quick-set is a first-class rule the panel shows.

## Storage and sync

Two stores, split on purpose:

- **Device-local** (`chalk.notify.v2` in localStorage): master, volume, DND,
  and the machine-noise toggles (`presence`, the four call sounds,
  `connect`, `disconnect`, `send_confirm`, `error` — sounds about chalk
  itself; no rule should ever banner them). Volume is a property of the
  machine; the phone and the desk can disagree. v1 entries are still read;
  normalize dropping their chat categories *is* the migration.
- **Synced, encrypted** (`chalk.notify.rules.v1` locally, mirrored to the
  server): the rules and profiles. They name the people and channels you've
  singled out — exactly what `user_preferences` (plaintext JSONB the server
  reads) must not carry — so `rules-sync.ts` seals them with AES-256-GCM
  under a key HKDF-derived from the identity's X25519 scalar
  (salt `chalk-notify-rules-salt-v1`, info `chalk-notify-rules-v1`) and
  ships base64 ciphertext through the ordinary prefs flow under the flat key
  `notify_rules_enc`. Every device holding the identity derives the same
  key; the server stores noise. Whole-blob last-write-wins; on connect the
  server copy is applied over the local cache, a blob-less server is seeded
  from local, and an undecryptable blob is ignored rather than allowed to
  eat the local ruleset. Until identity unlock, the local cache serves.

First-run seeding: with no rules stored, a v1 sound category the user had
switched off becomes a muted event type — the closest pre-rules equivalent.

## Sound design

The app is called chalk, so every sound is a **chalk stroke on a board** — the
warm, big-piece-of-chalk kind, never the screech. That is not an oscillator: a
bell is a pitched tone that gets struck and decays, chalk is friction, which
means broadband noise shaped by what you take out of it.

```
  bell / chime          chalk stroke
  |\____                 __---____
  struck, decays         contact, drag, lift
```

Four parameters carry the whole design, in `web/src/notify/synth.ts`:

| | |
|---|---|
| `lowpassHz` | The anti-screech ceiling. Nails-on-a-blackboard is stick-slip resonance at roughly 2–8 kHz, so nothing here goes near it. If a sound ever turns sharp, this is the knob. Enforced against `SCREECH_FLOOR_HZ` by the tests, at both ends of the sweep. |
| `q` | Bandpass width. Narrow bands make noise ring at their centre and the stroke becomes a beep; everything stays wide. Capped at `MAX_Q`. |
| `sweep` | How far the band travels while the stroke sounds. The movement is what makes it a swish rather than a hiss — a sweep of 1 is a bug. |
| `body` | A quieter layer an octave down, following the same sweep. This is how big the piece of chalk is. |

There are **no oscillators anywhere in the pack**. An early version put a quiet
sine under the noise so each category had a nameable pitch; it made everything
peep. Categories are told apart by brightness, length, sweep direction and
stroke count instead.

Two-tone categories are two separate strokes, not a glide. Direction carries
meaning: **rising = something arrived for you, falling = something went wrong.**

The call sounds are two mirrored pairs, held to that by the tests: yours
(`call_join` / `call_leave`) is a warm two-stroke pair with real mass
behind it, everyone else's (`peer_join` / `peer_leave`) is one short, light
stroke from a fixed place on the board. Within each pair only the direction
changes, so coming and going are told apart the way this pack tells
anything apart.

`disconnect` deliberately breaks the pattern — it is an eraser sweep, the
widest, dullest, longest and heaviest thing in the pack. Losing the connection
should sound like the board being wiped, and the tests hold it to that.

The numbers in `SOUND_SPECS` were tuned by ear. Treat the table as a recording
of that session rather than as arithmetic: changing one means listening again.

`node tools/sound-bench.mjs` builds the bench for that listening pass —
a single self-contained page with every category, the real `stroke()` graph
and the live spec table extracted from the source (so the bench can never
drift from what chalk plays), a slider per parameter, A/B against the
committed version, and the invariants above enforced as live warnings. Its
"copy tuned specs" block goes straight back into the table; the prose
comments go with it.

## Unlocking

An `AudioContext` is born suspended and only resumes from inside a real user
gesture, so the first click or keypress anywhere unlocks sound for the session.
Before that the gate returns `locked` and nothing is queued — a message that
arrives before you have touched the page is silent, not saved up. No context is
created until then either.

This is also why sounds can default to on without startling anyone: a tab left
open and never touched cannot make a noise.

## Guards at the call sites

Two live in `App.tsx` because they need app state: your own messages never
notify (they come back to you on your other devices and after a reconnect),
and only live pushes publish to the bus — the history backfill on reload
calls the same classifier and would otherwise play the entire backlog at
once. Voice reconnects are safe the same way: roster seeding arrives as
`voice_roster` acks, not join pushes.

## Not built

- **`dnd_schedule`** — a time-window scheduler. The `dnd` boolean exists; the
  schedule is its own slice.
- **A sample-based pack.** There is one pack, and a discriminator with one
  value discriminates nothing.
- **True push (service worker + Web Push).** Banners need an open tab or
  installed PWA; with chalk closed, nothing arrives. A service worker would
  also need channel-key access to show decrypted previews — its own design
  problem, not an afternoon.
- **Per-(type, scope) rules** — e.g. "mentions still notify in this muted
  channel". The resolver's shape permits it; the UI cost is why it waits.
- **`error` on decryption failure.** It fires on server error frames only.
  Detecting a failed decrypt means string-matching the fail-closed placeholder
  body, which is too fragile to build on.

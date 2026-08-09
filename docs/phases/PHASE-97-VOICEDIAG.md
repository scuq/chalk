# Phase 97 — voice reconnect diagnostics

## The problem

A participant in a ~2-hour call reported voice reconnecting on them at least
once, while measured latency stayed good. The server log for the same window
showed their phone's websocket flapping — but nothing on the client could say
what actually happened, because the 30-4c diagnostics were destroyed by the
very event under investigation:

- The event ring lived inside `VoiceCall`. A ws drop runs `handleWsDown` →
  `leave(false)` → call teardown, and the auto-rejoin constructs a **new**
  `VoiceCall` — so "copy report" after a reconnect showed only the fresh
  call's events. Everything leading up to the drop was gone.
- `getStats()` snapshots ran only while the debug drawer was open. Nobody has
  the drawer open when a call unexpectedly degrades, so there was no record of
  the selected candidate pair (relay vs direct, RTT, byte counters) at the
  moment of failure.
- Session-level edges — ws down, auto-rejoin armed/consumed, join failures —
  were never recorded anywhere the drawer could show. Distinguishing "the
  socket died" from "the media path died" is exactly the question a reconnect
  report needs answered, and the client couldn't.

## The design

Make the diagnostics outlive the thing they diagnose, and take the one
snapshot that matters at the moment trouble starts.

- **The ring moves up to the session** (`web/src/voice/diag.ts`,
  `VoiceDiagRing`). `VoiceSessionImpl` constructs one per page load and hands
  it into every `VoiceCall` via `VoiceCallOptions.diag`; the call keeps its
  `diag()` surface but writes through. The guest room, which builds its own
  `VoiceCall` with no session, passes nothing and gets a private ring — the
  30-4c behaviour, unchanged.
- **The session writes its own edges** into the same timeline: joining,
  in-call (relay/video flags), join failed, left (user vs app), ws drop,
  room-gone, rejoin hint consumed (ws drop vs page reload). A reconnect now
  reads as a contiguous story: peer states degrading → ws drop → rejoin →
  fresh call coming up.
- **`diagnostics()` never returns null.** The blob is now session-shaped
  (`VoiceSessionDiagnostics`): `reconnects` (ws-drop count this page load),
  `lastDrop`, the ring's `events`, and `call` — the live call's config +
  per-peer stats, null while idle. `VoiceDiagnostics` (call-level) loses its
  `events` field; the session owns the timeline.
- **Trouble snapshots** (97-2): `oniceconnectionstatechange` is now handled
  (it was only piggybacked on connection-state lines). On `disconnected` or
  `failed`, a one-shot `getStats()` writes the selected pair into the ring via
  `describePair` — same shape as the drawer's live stats row. `disconnected`
  is the valuable edge: the pc is still open and the pair still readable;
  by `failed` it is often gone (still attempted, best-effort, including from
  the connection-state handler just before `dropPeer` closes the pc). A
  `troubleSnap` marker on the peer dedupes per state per episode and resets
  on recovery, so a flapping link logs each episode once rather than a spam
  stream.
- The drawer shows a **reconnects line** (count + time and cause of the last
  drop) and "copy report" carries the whole session blob.

### Rejected

- **Persisting the ring to sessionStorage** so a page reload keeps it. Held
  as 97-3 until reloads are shown to be a factor in real reports; the ws-drop
  path (the reported one) never reloads the page.
- **Uploading diagnostics to the server.** The ring's snapshots contain
  candidate addresses (local network topology). chalk's server stays blind;
  the user pastes the report themselves, seeing exactly what they share.
- **Counting peer-connection failures as "reconnects".** A peer's link
  failing is their event as much as ours and already visible in the ring;
  the counter means one thing — this device's session dropped — or it means
  nothing.

## Slices

- **97-1** — the session-owned ring. `web/src/voice/diag.ts` (new:
  `VoiceDiagRing`, `describePair`), `call.ts` (ring injected via options,
  `VoiceDiagnostics` loses `events`), `session.ts` (edge events, reconnect
  counter, `VoiceSessionDiagnostics`, never-null `diagnostics()`),
  `VoiceCallPanel.tsx` (blob paths, reconnects line). `diag.test.ts`.
- **97-2** — trouble snapshots. `call.ts`: `oniceconnectionstatechange`
  logging, `snapshotTroublePair` with the per-episode dedupe, best-effort
  snapshot before `dropPeer` on connection failure.
- **97-3** — *(deferred)* ring survives a page reload via sessionStorage,
  alongside the existing rejoin hint.

## Manual checklist

- [ ] Join a call on two devices; kill the network on one for ~10s and
      restore. After the auto-rejoin, the drawer's ring should still show the
      pre-drop `ice state … = disconnected`, the `pair at disconnected …`
      snapshot, `session: ws drop`, and the rejoin — and the reconnects line
      should read `1`.
- [ ] "copy report" while **idle** (after leaving a call) still produces a
      blob with the session events.
- [ ] Guest room voice still works (private ring, no drawer regression).

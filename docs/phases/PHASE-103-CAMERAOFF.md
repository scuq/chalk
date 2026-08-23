# Phase 103 — camera off, done properly

**Status:** 103-1 and 103-2 shipped. Two slices; the phase is closed unless
the follow-ups under [Left open](#left-open) are taken up.

**Tag:** `#voice` → `tools/where.sh -g voice` (the 103-* comments live in
`web/src/voice/call.ts` and `web/src/voice/camera-chain.ts`).

## The problem

Two user reports, both fallout of 66-2 ("camera off means the device is not
opened"):

1. **Remote video only shows once your own camera is on** — worst on a
   rejoin after a connection drop. Since 66-2 a camera-off join publishes no
   video track, so the joiner's peer connection has an audio sender only.
   The joiner is always the offerer (the join-time roster loop; a rejoin is
   a fresh join), and its offer therefore carries no video m-line. The far
   side's camera sender cannot be added by an *answer*, and chalk wires no
   `onnegotiationneeded`, so it is never negotiated in. Turning your own
   camera on runs `enableCameraMidCall`, whose offer finally has the m-line
   — which is why "it works once my cam is on". Screen share had this hole
   patched for its own tracks in `onOffer` (re-attach, re-offer); the camera
   never got the equivalent when 66-2 removed the always-present disabled
   video track.
2. **The camera LED stays on after turning the camera off mid-call.** By
   design until now: `CameraChain.setActive` gated the raw track and parked
   the draw loop but kept the device open for a fast toggle, on the argument
   that the browser indicator is the honest signal. 66-2 already argued the
   opposite for the join, and users read the light the same way mid-call.

## The design

- **103-1 — a recvonly video transceiver on every peer we create without a
  local video track.** Every offer then has a video m-line; the far side's
  camera sender associates with it (JSEP matches an unassociated sendrecv
  transceiver of the same kind) and the answer comes back `sendonly`.
  `enableCameraMidCall`'s `addTrack` reuses that transceiver per spec, so
  the mid-call add still costs one renegotiation and adds no m-line. The
  budget/sender loops already null-check `sender.track`, so the trackless
  transceiver is safe there.

  *Rejected:* re-offering from `onOffer` when a local sender has no m-line,
  the way screen share does. Works, but costs every camera-on participant
  an extra renegotiation per joiner; the transceiver restores what pre-66-2
  got for free without reopening the camera.

- **103-2 — camera off releases the device, camera on reacquires it, no
  renegotiation.** The published track is the graph's canvas capture, not
  the device, so `CameraChain.releaseDevice()` can stop the raw
  `getUserMedia` tracks while the canvas track stays in every peer
  connection (disabled, black). `setVideoEnabled(true)` runs
  `recapture(prefs)` — permission is already granted, so no prompt — then
  un-parks the graph and re-applies the blur preference. Toggles during the
  reacquire are honoured by reading the desired state once it lands. A
  reacquire that fails (device unplugged, taken by another app) leaves the
  call camera-off, surfaces the reason, and `onCameraLost` flips the
  session's toggle back. A camera-picker change while off is deferred to
  the reopen rather than opening the device behind an "off" button.

  *Cost accepted:* first frame after "on" arrives a few hundred ms later
  than the previous instant flip; the far end sees black meanwhile.

  *Not covered:* the raw-publish fallback (no camera graph) still holds the
  device while disabled — there is no canvas to hide behind. It is the
  path taken only when the graph failed to build.

## Slices

- **103-1** — recvonly video transceiver for video-less peers (`ensurePeer`).
- **103-2** — `releaseDevice` / `deviceReleased` on `CameraChain`;
  `setVideoEnabled` releases on off and `reopenCamera` reacquires on on;
  `onCameraLost` callback; `applyDevicePrefs` defers a camera switch while
  released.

## Manual checklist

Neither slice is node-testable (both need `RTCPeerConnection` /
`getUserMedia`), so verify in two browsers against the dev stack:

- [ ] A has the camera on. B joins camera-off: A's picture shows on B
      without B touching its camera. Repeat with B rejoining after a
      forced disconnect.
- [ ] B then turns its camera on: A sees B (the mid-call add still works).
- [ ] B turns the camera off: B's browser camera indicator and hardware LED
      go out; A sees B's tile go black. B turns it on again: LED back, A
      sees frames within about a second; blur (if set) is still applied.
- [ ] Toggle off/on quickly several times: ends in the state of the last
      click, no stuck "reopening".
- [ ] With the camera off, unplug the camera, turn it on: an error shows,
      the button returns to off.

## Left open

- The raw-publish fallback keeps the device open while off (see above).

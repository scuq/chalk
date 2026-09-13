# Phase 122 — a microphone picked during a call takes effect

**Status:** 122-1 built (2026-09-13). 122-2 is conditional on a report from
the Windows machine, see the end. Unit-tested where the code is pure
(`web/src/voice/mic-capture.test.ts` the capture loop against fakes,
`mic-prefs.test.ts` the constraint shape). The browser half was driven by a
17-check probe (`.claude/skills/run-chalk/probes/ui.mjs` at the time) in
headless Chromium with fake media, which offers two named inputs: a join on
the default, a mid-call swap to "Fake Audio Input 2" through the settings
dialog (`requested` and `landed` equal, one attempt), a fresh join with that
device saved, and a saved device that does not exist (default captured, the
label in the diag line, the "not found" notice shown). What the probe cannot
stage — a device that is listed but will not open, a headset that arrives
mid-call — is the checklist at the end, by hand on the real machines.
**Tags:** `#voice` → `tools/where.sh -g voice`

## The problem

On the desktop app (Electron), on Windows and on macOS: pair or plug in a
microphone during a call, pick it in the mic dropdown, and nothing happens.
No toast, no error, the far end keeps hearing the old mic. On macOS a rejoin
fixed it. On Windows only an app restart did.

chalk already had a mid-call swap (41-4, 63-3): the dropdown writes
`chalk.mic.v1`, `subscribeMicPrefs` calls `VoiceCall.applyMicPrefs`, which
calls `MicChain.recapture`, which captures the new device and swaps the
`MediaStreamAudioSourceNode` under the published track — no `replaceTrack`,
no renegotiation. That chain ran, threw nothing, and the audio did not move.

## The diagnosis

The shape of the constraint. `micConstraints` passed `deviceId` as a bare
string, which is an `ideal`. Chromium honours an ideal only for a device in
its capture capability list, and a device it has enumerated but cannot
describe yet is not in that list: a Bluetooth headset that is changing its
profile, a device plugged in a moment ago, an input the audio service has
not caught up with. For such a device getUserMedia succeeds on the default
device and throws nothing. The dropdown (fed by `enumerateDevices`) and the
capture capability list are different lookups in Chromium, so a device in
the dropdown proves nothing about capture.

Nothing checked where the capture landed. `recapture` never compared
`track.getSettings().deviceId` with the request, and `applyMicPrefs` logged
"mic recaptured" regardless.

The bare hint existed so an unplugged mic would not fail the join. 63-3's
`resolveMicPrefs` already covers that: a device absent from the enumeration
resolves to `""` before the constraint is built. So a non-empty resolved id
is always a device the browser listed a moment ago, and `exact` costs the
fallback nothing.

Why a rejoin was enough on macOS and a restart was needed on Windows is
unknown. One explanation fits both: the same mechanism with a different
recovery time — seconds for a headset to settle, the process lifetime for
Chromium's audio service on Windows. That cannot be proven from the dev box.
122-1 turns the silent miss into a visible, retried, logged failure. What
the log then says on Windows decides 122-2.

## The design

### 122-1 — capture the chosen mic exactly, check that it landed, retry, and say so

- **`micConstraints`** emits `deviceId: { exact }` for a non-empty id. Every
  caller resolves first, so the id is one the browser listed.
- **`mic-capture.ts`** is the one capture path for the join, the mid-call
  swap and the settings dialog's meter. `captureMic(prefs, deps, opts)`
  re-resolves the saved (id, label) pair against a fresh enumeration on
  every try, captures with the exact id, and checks the track that came back
  (`captureLanded`: settings id, or the label for Brave and for engines that
  leave `deviceId` out of settings). A capture that lands elsewhere is
  released and retried. `OverconstrainedError`, `NotFoundError` and
  `NotReadableError` are retried after 600 ms, four tries in all. A denial
  or a security error is thrown at once. In a combined mic+camera request
  only `OverconstrainedError` is retried, because the other two can be the
  camera's and the join's audio-only tier retries them without the
  ambiguity. After the last try, a join (`fallbackToDefault: true`) captures
  the default and marks the outcome `fellBack`. A swap or the meter throws,
  so the old mic is kept. The browser calls are injected, which is what
  makes the loop testable.
- **`MicChain.recapture`** returns the outcome, and serialises overlapping
  swaps by sequence number: a newer recapture started while an older one was
  capturing wins, and the older result is released rather than installed.
  `applyMicPrefs` and the 63-3 devicechange tick could overlap before, when
  a device arrived and the user picked it inside the 800 ms settle window.
- **`VoiceCall.reportMicCapture`** writes one diag line per capture, join
  and swap alike — `mic capture (join): requested=<id|default> "<label>"
  landed=<id|?> attempts=N [fell back to default]` — and raises the notice:
  "not found — using the system default" when the saved device is absent
  (63-3's), "could not open — using the system default" when it is listed
  but would not open. The devicechange tick retracts either once the chosen
  device is captured, as before.
- **`describeMediaError`** takes the device label, and for the mic phrases
  `OverconstrainedError` as "could not open microphone "X" — possibly still
  connecting, try again or rejoin", since on this path it is our exact id,
  not an unsupported setting.

**Rejected:** a swap that stops the old device before opening the new one.
It matches what a rejoin does, but a new device that then fails leaves the
user silent. Capture-new-first keeps them audible, and the exact id gives
the same certainty. **Rejected:** a Chromium switch in the desktop shell now.
The Windows cause is not proven and the switch would be a guess. 122-2 waits
for the report.

### 122-2 — the desktop shell on Windows (conditional)

Only if the 122-1 build on the Windows machine still needs a restart before
a hot-plugged mic opens, and the diagnostics show `OverconstrainedError` or
`landed=<old>` on every try for a device the dropdown lists. Then the
renderer has done all it can and the cause is Electron's audio service. The
candidate is `app.commandLine.appendSwitch("disable-features",
"AudioServiceSandbox")` beside the existing switch in `desktop/src/main.ts`,
win32 only, with a comment citing the observed failure — to be tried on that
machine, not assumed.

## Manual checklist

- [ ] macOS app: join, pair the headset, pick it in the dropdown. The audio
      moves within about two seconds, no rejoin. The diagnostics show a
      `mic capture (swap)` line with `landed=` the headset's id.
- [ ] Windows app: the same. If a restart is still needed, copy the
      diagnostics report. That report decides 122-2.
- [ ] Regression: pick a mic, unplug it, join. The "not found — using the
      system default" notice appears and the join succeeds. Plug it back in:
      the notice clears (63-3 path).
- [ ] Settings dialog with "test" running: pick a device that cannot open.
      The error line shows under the dropdown, the meter stays on the old
      device.
- [ ] A first join in a fresh profile still shows one permission prompt for
      mic and camera together.

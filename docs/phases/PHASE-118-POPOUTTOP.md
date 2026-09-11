# Phase 118 — pop-outs stay ordinary windows unless asked to float

**Status:** built, 118-1 (2026-09-12). Unit-tested (`web/src/voice/pip.test.ts`:
opted in, the first pop-out takes document PiP and the rest are plain; not
opted in, PiP is never requested). Not yet checked on a real Windows or macOS
browser — the checklist below.
**Tags:** `#voice` → `tools/where.sh -g voice`

## The problem

scuq, on Windows, in a four-person call: pop out three of them and the first
window is above every other window on the desktop while the other two are
not. On macOS none of the three floats. Nobody chose either behaviour, and a
window that covers whatever you switch to is the kind of thing a person
should have to ask for.

The cause is 47-4's two mechanisms in `web/src/voice/pip.ts`. Chromium's
Document Picture-in-Picture is a real always-on-top OS window, but a page
gets exactly one, so the first pop-out took it and every later one was an
ordinary `window.open` pop-up. Whatever macOS Chrome was doing with its PiP
window in scuq's case, it was not floating; the desktop app switches the API
off outright (104-6) because Electron exposes it without implementing it. So
the floating window was taken whenever the browser offered it, and whether it
was offered, and whether it floated, varied by platform.

## The design

### 118-1 — the floating window is opt-in

- `VoicePrefs.popoutsOnTop` (`web/src/state/types.ts`), default **off**, with
  `selectPopoutsOnTop`. Account-level like the rest of the voice prefs.
- `openTilePopout` takes `opts.onTop`; only then does it look for
  `documentPictureInPicture`. Off, every pop-out goes through `openPlain`
  everywhere — the behaviour macOS and the desktop app already had.
- `VoiceCallPanel` gets `popoutsOnTop` from App, which reads the pref.
- The checkbox lives in the voice & video dialog's **calls** tab beside
  "show latency" (`MicSettings.tsx`, `voice-popouts-on-top`). Its hint says
  the two things the pref cannot make true: even on, only the *first*
  pop-out floats, because the browser rations the window; and it does
  nothing in Firefox, Safari or the desktop app, which have no such window.

**Rejected:** dropping document PiP altogether. It is the only way a browser
page gets a window that stays over a game or a full-screen document, and
that is exactly what someone popping a shared screen out wants; the problem
was taking it unasked, not having it.

**Left open:** the desktop app could honour the pref properly — Electron's
`BrowserWindow` has `alwaysOnTop`, and every pop-out there could float, not
just the first, if the page passed a feature flag through
`setWindowOpenHandler` (`desktop/src/links.ts` parses only geometry today).
That is a second slice if anyone asks for it; the hint text would then need
its "desktop app" clause changed.

## Manual checklist

- [ ] Windows, Chrome or Edge, box off (the default): three pop-outs, none
      stays above other windows when you switch to something else.
- [ ] Same with the box on: the first floats, the second and third do not.
- [ ] macOS: same two runs; report whether the first floats with the box on.
- [ ] Desktop app: the box changes nothing, pop-outs open as before.
- [ ] The box survives a reload and shows the same on a second device.

---
name: flair-demo
description: Put chalk's flair mode (phase 115 — flame, wave, avatar frames, banner drift) in front of a person: a live dev stack, four chatting bots and a headed browser window signed in as the viewer. Use when asked to demo, show off or eyeball flair, the flame on a busy channel, the name wave, or the avatar frames.
---

Flair is the animated mode from phase 115 (`docs/phases/PHASE-115-FLAIR.md`).
Its unit tests prove the model and `theme-flair.test.ts` the stylesheet, but
the point of the phase is what it *looks like*, and that needs eyes. This
skill stages a scene for them.

## What it does

`.claude/skills/run-chalk/flair-demo.mjs` (kept beside the other run-chalk
scripts, because it needs that directory's Playwright install):

1. registers **you** in a headed Chromium window that stays open, plus four
   headless bots (`ada`, `bea`, `cid`, `dot` with a run suffix), all in
   parallel — Argon2id makes this the slow part, a minute or two;
2. friends everyone, creates the channel **campfire** with all five in it;
3. turns flair on for you with **3 messages in 1 minute** as the threshold
   (so the flame visibly comes and goes), and roster/feed pictures on;
4. gives three bots a picture and a frame — ember, aurora, pulse;
5. runs forever: bursts of chat then ~100 s of quiet (flame on, flame out),
   `dot` away/online every half minute (its name waves), `cid` DMing you
   about once a minute (its name waves; its row flames when DMs pile up).

Credentials for all five accounts, TOTP secrets included, land in
`/tmp/chalk-demo/credentials.txt`; the running log is `/tmp/chalk-demo/demo.log`.

## Run

The dev stack must be up — the `run-chalk` skill's launch line, in short:

```bash
KEY_FILE=~/.cache/chalk-dev-totp-key
[ -f "$KEY_FILE" ] || { mkdir -p ~/.cache; head -c 32 /dev/urandom | base64 > "$KEY_FILE"; }
CHALK_TOTP_ENC_KEY="$(cat "$KEY_FILE")" CHALK_OPEN_REGISTRATION=1 \
CHALK_PUBLIC_URL=http://127.0.0.1:8443 tools/dev.sh
```

Then, from the repo root, in the background so the window outlives the call:

```bash
node .claude/skills/run-chalk/flair-demo.mjs
```

Poll `/tmp/chalk-demo/demo.log` for `everyone is in campfire`; that is when
the window is worth looking at. Tell the person what each bot is doing (the
list above) and where the credentials are.

Stop it by killing the node process. chalkd keeps running.

## While it runs

- **settings → appearance → flair** flips effects off and on live, and the
  threshold fields change what counts as busy.
- Asking the OS for reduced motion holds every effect still in place.
- Turning flair *off* is the honest baseline: nothing moves, no frames.

## Gotchas

- A headed window needs the live desktop session (`DISPLAY`/`WAYLAND_DISPLAY`
  are set in the VS Code terminal here); headless-only environments get no
  window and the script still runs.
- Five parallel Argon2id registrations at 256 MiB each: fine on this box, but
  do not raise the bot count casually.
- The web bundle is embedded in chalkd: a flair CSS/TS change is not on
  screen until `node build.mjs` and a chalkd rebuild + restart.

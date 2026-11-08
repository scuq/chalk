---
name: ui-sweep
description: Screenshot or check chalk's UI across themes, sweep the voice room for clipping with several users, or start a headed demo of the shell or the voice room. Use it when a UI change needs a look in more than one theme. Also use it for a voice layout clipping check, or when asked to demo.
---

The `ui-sweep` script drives a real browser against the dev stack.
Phase 133 used it to check fifteen themes and the voice room.
It found the bugs that `docs/phases/PHASE-133-POLISH.md` records.

## What it does

The script is `.claude/skills/run-chalk/ui-sweep.mjs`.
It lives beside the other run-chalk scripts, because Node resolves `@playwright/test` from that directory.
Its header comment lists every flag.

1. Registers users through the full signup: ann (the viewer) and bob.
2. Registers more users with `--users=N` (2 to 8).
3. Makes every user a friend of ann.
4. Creates the channels `general`, `random`, and `quiet`, with bob as a member.
5. Has bob post into `general`, so that ann has an unread.
6. Runs the pass that the flags choose.

Flags:

- `--themes=a,b,c` sets the themes for the theme passes. The default is green, light, warmwhite, lcars, and solarized-dark.
- `--sweep-only` stops after the feed pass: every theme on the channel with messages. With `--phone`, it also writes the feed and the open drawer at 390 px width.
- With no mode flag, the script also writes the composer shots (empty, typed, in an edit, three themes, phone width). It prints measurements of the header, the channel header, the row heights, and the sidebar width.
- `--voice` starts Chromium with a fake camera and microphone. Ann creates the voice room "lounge" with every friend, and the others join.
- `--voice-only` (with `--voice`) screenshots the voice room and stops.
- `--sweep-voice` (with `--voice`) runs the voice scenario sweep.
- `--headed` opens a visible window signed in as ann and keeps it open.
- `--cycle` (with `--headed`) changes the theme every `--cycle-secs` seconds. The default is 5.

Each flag also reads as an upper-case environment variable with underscores. For example, `--sweep-voice` is `SWEEP_VOICE=1`.
An unknown flag stops the script with exit code 2 and lists the known flags.

The voice sweep does these steps:

1. Screenshot the cards view in six themes.
2. Screenshot the speaking highlight from bob's view.
3. Send a scratchpad note.
4. Turn on one, two, three, and then all cameras, and then force the tiles grid. Measure each step at 1280x800, 1229x790, 1229x700, and 1440x900.
5. Start a screen share and screenshot it from both views.
6. Screenshot bob's phone view.

Use `--users=5` to cover three or more cameras.

## Run

The dev stack must be up. Use the start line in the `run-chalk` skill.
For the voice flags, add `CHALK_VOICE_ENABLED=true` to that line and run the dev TURN server.
The script needs the stack at `http://localhost:8443`.

Run the script from the repository root, as a single command.
Do not add `cd`, a pipe, or `rm`. The permission allowlist matches the plain command only.
The script clears its output folder itself.

```bash
node .claude/skills/run-chalk/ui-sweep.mjs --sweep-only --themes=green,light,cyberpunk
node .claude/skills/run-chalk/ui-sweep.mjs --voice --sweep-voice --users=5
node .claude/skills/run-chalk/ui-sweep.mjs --headed --voice --users=5
node .claude/skills/run-chalk/ui-sweep.mjs --headed --cycle
```

The last two commands are demos. They run until you close the window or stop the node process.
Run a demo in the background, so that the window stays open after the call.
Each user registers with Argon2id, so setup takes some time. More users take more time.

## Reading the output

The script deletes `/tmp/chalk-sweep/` at the start and writes all files there:

- Screenshots, as `.png` files.
- `probe.log`, with internal steps and caught errors.
- `metrics.json`, from the default pass.
- `credentials.txt`, in headed mode only. It holds the shared password and the TOTP secret of every user.

The measurements go to standard output, not to `probe.log`.

The voice sweep prints one line for each step, for example `two-cams`. Each line shows the result for the four viewport sizes.
`ok` means that all tiles and cards fit in the stage.
`CLIPPED` means that the stage content is taller than the stage, or that a tile or card goes past the stage edge.
The `v=` value lists the video tile sizes. The `c=` value is the number of cards.
The labels are `one-cam`, `two-cams`, `three-cams`, `all-cams`, and `forced-grid`. The label `all-cams` means that every user has a camera on.

Screenshots to open:

- `<theme>.png` and `<theme>-hover-sidebar.png`: the shell with an empty channel, and the sidebar with a hovered row.
- `<theme>-feed.png`: the channel with messages, for each theme.
- `phone-feed.png` and `phone-drawer.png`: the phone width (with `--phone`).
- `focus-row.png` and `focus-search.png`: keyboard focus.
- `composer-*.png`: the composer.
- `voice-*.png`: the voice room (`--voice-only`).
- `vs-*.png`: the voice sweep. The files `vs-<label>-1229x700.png` show each step at the smallest height.

For many screenshots, a contact sheet (all images in one grid) is faster to review than single files.

## Traps

- The avatar nudge and the "what's new" note cover the page after signup. The script dismisses both. If you add a step, dismiss them first.
- A channel picks bob by name. With several friends, the first friend is not always bob, and bob then never sees the channel.
- The web bundle is embedded in chalkd. A change to the client is not on screen until `node build.mjs` and a chalkd rebuild and restart.
- A headed window needs the live desktop session. A headless-only environment gets no window.

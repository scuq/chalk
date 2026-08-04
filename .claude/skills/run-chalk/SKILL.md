---
name: run-chalk
description: Build, launch, and drive chalk's dev stack (Postgres + chalkd + SPA). Use when asked to run or start chalk, screenshot its UI, register test users, drive the mobile view, or verify a change in the real app with Playwright.
---

chalk is a self-hosted E2E-encrypted chat: a Go server (chalkd) serving an
embedded Preact SPA. Launch the stack with `tools/dev.sh` (plus the env
below), then drive the real UI with
`.claude/skills/run-chalk/driver.mjs` — a Playwright script that registers a
fresh user through the full auth-v2 signup (password + TOTP it computes
itself + identity phrase) and lands in the chat UI. There is no shortcut
session cookie: auth v2 has no unauthenticated path and no seeded loggable
users, so registering a fresh user IS the login recipe.

All paths are relative to the repo root.

## Prerequisites

Docker (for Postgres), Go 1.25, Node 22 — all already present on this
machine. One-time driver setup (own Playwright install; the repo's
`test/e2e` pin is too old to reach the chat UI, see Gotchas):

```bash
cd .claude/skills/run-chalk && npm install && npx playwright install chromium && cd -
```

## Run the stack

`tools/dev.sh` brings up (or reuses) the `chalk-dev-pg` Postgres container,
builds the SPA + chalkd, migrates, and runs chalkd in the foreground on
`127.0.0.1:8443`. It does NOT set `CHALK_TOTP_ENC_KEY`, without which
signup 500s — so wrap it:

```bash
# TOTP secrets are AES-encrypted under this key; reuse the same key across
# restarts or previously registered users' TOTP secrets stop decrypting.
KEY_FILE=~/.cache/chalk-dev-totp-key
[ -f "$KEY_FILE" ] || { mkdir -p ~/.cache; head -c 32 /dev/urandom | base64 > "$KEY_FILE"; }

make dev-turn-up    # optional: coturn, enables voice
make dev-mail-up    # optional: mailpit SMTP sink, UI on :8025

CHALK_TOTP_ENC_KEY="$(cat "$KEY_FILE")" \
CHALK_OPEN_REGISTRATION=1 \
CHALK_VOICE_ENABLED=true CHALK_TURN_URLS=turn:localhost:3478 CHALK_TURN_SECRET=devsecret \
CHALK_SMTP_HOST=localhost CHALK_SMTP_PORT=1025 \
CHALK_PUBLIC_URL=http://127.0.0.1:8443 \
tools/dev.sh
```

Run it in the background and poll for readiness (first run builds
everything — allow ~2–3 min):

```bash
timeout 180 bash -c 'until curl -sf http://127.0.0.1:8443/api/auth/config >/dev/null; do sleep 2; done'
```

Stop / restart:

```bash
lsof -ti:8443 -sTCP:LISTEN | xargs -r kill   # chalkd only; PG container stays up
make dev-down                                 # remove the PG container too
```

`CHALK_DEV_SKIP_NPM=1 CHALK_DEV_SKIP_BUILD=1` skips the rebuilds when only
restarting — but see Gotchas: any web/ change needs BOTH rebuilds.

## Drive it (agent path)

```bash
node .claude/skills/run-chalk/driver.mjs             # register user → chat UI → screenshot
node .claude/skills/run-chalk/driver.mjs --mobile    # same, under iPhone 14 emulation
node .claude/skills/run-chalk/driver.mjs --friend    # + 2nd user, friend them, create channel, send message
```

| flag | what it does |
|---|---|
| `--mobile` | iPhone 14 emulation (390×664, DPR 3, touch, `hover: none`) — the mobile CSS keys off coarse-pointer, not just width |
| `--friend` | registers a second user, friends the two (directory one-click add + accept), creates a channel, sends a message |
| `--base URL` | target another instance (default `http://localhost:8443`) |

Screenshots + `credentials.txt` (username/password of the created users, for
manual follow-up or a second run) land in `/tmp/chalk-driver/`.

The driver is also the template for custom flows: `register()` gets you an
authenticated page object; testids for the main surfaces are in the
`--friend` branch (drawer `nav-toggle`, `sidebar-new`, `composer-input`,
`message-menu` via touch long-press…), more in `test/e2e/*.spec.ts`.

## Custom probes

One-off "how does the UI actually behave" scripts go in **one fixed place**:
`.claude/skills/run-chalk/probes/ui.mjs`, rewritten per investigation. It is
gitignored and allowlisted, so the run costs no permission prompt:

```bash
node .claude/skills/run-chalk/probes/ui.mjs            # from the repo root
```

That only stays true if the command remains a single segment — every part of a
compound command has to be permitted, so one `cd`, `rm` or `| tail` puts the
prompt back. Hence the conventions:

- **No `cd`, no `cp`.** Node resolves `playwright` by walking up from the
  script's own directory into `run-chalk/node_modules/`; writing the probe
  anywhere else (a `/tmp` scratchpad) is what used to force both.
- **The probe owns its output dir.** `rmSync('/tmp/chalk-probe', {recursive:
  true, force: true})` + `mkdirSync` at the top — never `rm -rf` on the command
  line. One dir over from the driver's `/tmp/chalk-driver/`, so a probe never
  clobbers driver screenshots.
- **Print a short summary, log verbosely to a file.** Write the noise to
  `/tmp/chalk-probe/probe.log` and read that if needed, instead of `| tail -N`.
- **Crib from `driver.mjs`, don't import it** — it is a top-level script that
  registers a user on load, not a module.

A probe worth keeping earns a topic name, a commit beside `readme-shots.mjs`,
and its own entry in `.claude/settings.json`. `probes/` itself stays
gitignored — it is one scratch slot, rewritten per investigation, so anything
committed from it would describe whatever question came last.

## Kept scripts (same dir, all committed)

| script | what it holds |
|---|---|
| `readme-shots.mjs` | regenerates `docs/screenshots/` for the README — two users, a staged conversation, reaction + thread, desktop + mobile. Header says how to re-run it (fresh handles needed) |
| `unread-landing.mjs` | the 79-2 repro: where opening a channel puts the view, across a real attachment decrypt on a phone-shaped viewport |
| `parking-privacy.mjs` | 53-4/53-5: asks the computed style whether the privacy screen blurs every shell child except the parked pane, and whether F9's guard and the way back behave. 15 checks |

Each exists because the assertion needs a real browser and `web/test.mjs` has
no DOM; the pure halves live in `*.test.ts` beside the source.

## Run (human path)

Same launch line, then open `http://localhost:8443/` in a browser and
register via "create an account" (open registration is on). TOTP: paste the
shown base32 secret into any authenticator app. Ctrl-C stops chalkd.

## Test

```bash
go build ./... && go vet ./... && gofmt -l .   # gofmt output must be empty
go test ./...
cd web && npx tsc --noEmit && node test.mjs && node build.mjs   # 815 tests, 0 fail (2026-07-31)
```

## Gotchas

- **`CHALK_TOTP_ENC_KEY` unset → signup silently 500s.** The wizard shows a
  bare "HTTP 500" banner; chalkd stderr has the real message. `tools/dev.sh`
  never sets it. Keep the key stable across restarts (hence the key file).
- **The repo's pinned Playwright cannot reach the chat UI.** `test/e2e`
  pins 1.48 (Chromium 130); the identity gate needs WebCrypto Ed25519
  (Chromium ≥ 137). That's why this skill has its own newer install.
  `smoke/mobile.spec.ts` fail at the sign-in card for the same reason.
- **A fresh account cannot create a channel.** `create-modal-submit` is
  disabled with zero friends and requires ≥1 member selected. Use
  `--friend`, which does the two-user dance.
- **The web bundle is embedded in the chalkd binary** (`embed.go`). A CSS/TS
  change is not served until `node build.mjs` AND a chalkd rebuild+restart —
  rerunning `tools/dev.sh` without the SKIP vars does both.
- **The signup password step takes tens of seconds.** Client-side Argon2id
  at 256 MiB; the driver waits up to 120 s. Don't shorten that timeout.
- **Use `http://localhost:8443` in the browser, not `127.0.0.1`.** WebAuthn
  RP origins default to localhost; the server banner printing 127.0.0.1 is
  fine for curl but passkey flows care.
- **Mobile layout needs touch emulation, not a narrow window.** The mobile
  rules key off `(hover: none)` / `(pointer: coarse)` — use a Playwright
  device descriptor (`--mobile`), not just a small viewport.

## Troubleshooting

- **Signup banner "HTTP 500"** → `CHALK_TOTP_ENC_KEY` missing (see Gotchas).
- **Driver: "chalkd not reachable"** → start the stack first; poll line above.
- **`bind: address already in use` on 8443** → a previous chalkd is still
  listening: `lsof -ti:8443 -sTCP:LISTEN | xargs -r kill`.
- **Stuck at the sign-in card / identity gate in a script** → the browser
  lacks Ed25519 (Chromium < 137). Use this skill's Playwright, not test/e2e's.
- **"postgres did not become ready"** → `docker logs chalk-dev-pg`; the
  container survives reboots stopped — `docker start chalk-dev-pg` or just
  rerun `tools/dev.sh`.

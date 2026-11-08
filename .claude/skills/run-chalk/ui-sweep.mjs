// ui-sweep.mjs - screenshot and measure chalk's UI across themes and in the voice room.
//
// Phase 133 used this script to check fifteen themes and the voice room.
// It found the bugs that docs/phases/PHASE-133-POLISH.md records.
// It is kept because the same checks apply to every later UI change.
// It lives in this directory because Node resolves @playwright/test from the
// node_modules folder here.
//
// Usage (from the repository root):
//   node .claude/skills/run-chalk/ui-sweep.mjs [flags]
//
// Prerequisite: a dev stack at http://localhost:8443, started with the
// launch line in the run-chalk skill. Voice flags also need
// CHALK_VOICE_ENABLED=true and the dev TURN server.
//
// The script registers users through the full signup. The password and the
// TOTP code come from this script, and the identity phrase is confirmed in
// the signup form. User ann is the viewer. User bob is the friend. Both get
// a run suffix. The script makes ann and bob friends, creates the channels
// general, random, and quiet with bob as a member, and has bob post into
// general so that ann has an unread. With --groups, the script also creates
// six channels in channel groups, and bob posts into one of them.
//
// Each flag also reads as an upper-case environment variable with
// underscores: --sweep-voice is the same as SWEEP_VOICE=1. An unknown flag
// stops the script with exit code 2 and lists the known flags.
//
// Flags:
//   --themes=a,b,c  Themes for the theme passes.
//                   Default: green,light,warmwhite,lcars,solarized-dark.
//                   All fifteen: green, light, snazzy-light, warmwhite,
//                   vscode-light, catppuccin-latte, cyberpunk,
//                   solarized-dark, tokyo-night, lcars, blade-runner,
//                   azeroth, darkord, exchalk, catppuccin-mocha.
//   --users=N       2 to 8 users. Users 3 to 8 are cat, dan, eve, fay, gus,
//                   and hal. Each one is a friend of ann.
//   --sweep-only    After the first theme pass, the focus crops, and the
//                   feed pass (<theme>-feed.png), stop.
//   --phone         With --sweep-only, also write the feed and the open
//                   drawer at 390 px width.
//   (no mode flag)  Theme pass, focus crops, feed pass, then the composer
//                   (empty, typed, in an edit, three themes, phone width)
//                   and measurements of the header, the channel header,
//                   the row heights, and the sidebar width.
//   --voice         Start Chromium with a fake camera and microphone and
//                   automatic screen capture. Ann creates the voice room
//                   "lounge" with every friend, and the others join it.
//   --voice-only    With --voice, screenshot the voice room (cards, after a
//                   note, light theme, one camera on, phone), then stop.
//   --sweep-voice   With --voice, run the voice scenario sweep. It writes
//                   one line for each step on standard output. A line shows
//                   ok or CLIPPED for each of four viewport sizes. CLIPPED
//                   means that a tile or card goes past the stage edge.
//                   Use --users=5 to get three or more cameras.
//   --groups        After general, random, and quiet, create six channels in
//                   channel groups: frontend and backend in "dev", tracks in
//                   "music", infrastructure-migration in "operations",
//                   boardgames in "friday-boardgame-night", and alerts in
//                   "ops". Bob also posts into infrastructure-migration, so
//                   that channel is unread. The long names show how chaos
//                   mode shortens the group tag before the channel name.
//   --headed        Open a visible Chromium window signed in as ann and keep
//                   it open after setup (a demo). With --voice, the other
//                   users stay in the call in background browsers. The
//                   voice steps that --sweep-voice does not gate still run
//                   first: ann sends one note and turns her camera on.
//   --cycle         With --headed, change the theme every --cycle-secs
//                   seconds (default 5) and show the theme name in a
//                   corner tag.
//   --cycle-secs=N  Seconds between theme changes for --cycle.
//   --season=KEY    With --headed, run the season scene demo for the season
//                   key KEY (see "Season demo" below).
//   --scene=NAME    With --season, show only the scene with the row name
//                   NAME, again and again.
//   --scene-secs=N  Seconds to show each scene. Default: 30.
//
// A headed run does not end. Close the window or stop the node process.
//
// Season demo: --season sets a fake date with the Playwright clock, which
// runs at normal speed. The keys are neutral, late-autumn, christmas,
// winterfest, new-year, spring-bloom, green-season, midsummer,
// harvest-festival, and spooky-season. The table SEASON_DATES has the date of
// each key. The script clears the visit log and seeds the neutral log
// so that a visit is due at once. After each page load it skips the first
// pause (13 s) and reads data-scene from the scene canvas. It loads the page
// again, up to 25 times, until the scene has the wanted name. It then shows
// the scene for --scene-secs seconds with a corner tag. Without --scene, the
// targets are the scenes of the key, in table order: the five rows in
// web/src/season/scene.ts, the ten scripts in web/src/season/offseason.ts for
// neutral, the seven scripts in web/src/season/christmas.ts for christmas, or
// the seven scripts in web/src/season/newyear.ts for new-year.
// For each target, the script prints
// "SCENE <key>: <name>" on standard output, with "(wanted X)" if it gave
// up. A visit lasts 45 s to 75 s. A value of --scene-secs above 45 can let
// the visit end before the next load. An unknown key or scene stops the
// script with exit code 2 and lists the known values. The app has no preview
// API, so the demo only loads the page again until the scene shows.
//
// Output: the folder /tmp/chalk-sweep/. The script deletes the folder at
// the start of each run. The folder holds the screenshots and probe.log.
// A headed run also writes credentials.txt with the shared password and the
// TOTP secret of every user.
//
// Traps that the script handles:
//   - After signup, the avatar nudge and the "what's new" note cover the
//     page. The script dismisses both.
//   - A channel picks bob by name. With several friends, the first friend
//     is not always bob, and bob then never sees the channel.
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';

for (const a of process.argv.slice(2)) {
  const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(a);
  const known = ['themes', 'sweep-only', 'phone', 'voice', 'voice-only', 'sweep-voice', 'users', 'headed', 'cycle', 'cycle-secs', 'groups', 'season', 'scene', 'scene-secs'];
  if (!m || !known.includes(m[1])) {
    console.error(`unknown argument: ${a} (known: --${known.join(', --')})`);
    process.exit(2);
  }
  process.env[m[1].toUpperCase().replace(/-/g, '_')] = m[2] ?? '1';
}
const OUT = '/tmp/chalk-sweep/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';
const log = (...a) => appendFileSync(LOG, a.join(' ') + '\n');

const BASE = 'http://localhost:8443';
const HEADED = process.env.HEADED === '1';
const secrets = {};
const RUN = Date.now() % 100000;
const PASSWORD = 'chalk Driver Passw0rd!!';
const THEMES = (process.env.THEMES || 'green,light,warmwhite,lcars,solarized-dark').split(',');

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) {
    const i = A.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpNow(secretB32) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', key).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

async function register(page, username) {
  await page.goto('/');
  await page.waitForSelector("[data-testid='password-login']", { timeout: 15000 });
  await page.locator('button.chalk-auth-link', { hasText: 'create an account' }).click();
  await page.waitForSelector("[data-testid='signup-wizard']", { timeout: 10000 });
  await page.locator("[data-testid='signup-username']").fill(username);
  await page.locator("[data-testid='signup-step-account'] input[type='email']").fill(`${username}@e2e.invalid`);
  await page.locator("[data-testid='signup-account-next']").click();
  await page.waitForSelector("[data-testid='signup-step-password']", { timeout: 10000 });
  const pw = page.locator("[data-testid='signup-step-password'] input[type='password']");
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.locator("[data-testid='signup-password-next']").click();
  const totpStep = page.locator("[data-testid='signup-step-totp']");
  await totpStep.waitFor({ timeout: 120000 });
  const secret = (await page.locator("[data-testid='signup-secret']").innerText()).trim();
  secrets[username] = secret;
  await totpStep.locator('input').fill(totpNow(secret));
  await page.locator("[data-testid='signup-finish']").click();
  await page.waitForSelector("[data-testid='recovery-screen']", { timeout: 30000 });
  await page.locator("[data-testid='recovery-ack']").check();
  const cont = page.locator("[data-testid='recovery-continue']");
  await cont.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector("[data-testid='recovery-continue']").disabled, null, { timeout: 20000 });
  await cont.click();
  await page.waitForSelector("[data-testid='identity-setup-generate']", { timeout: 30000 });
  const words = await page.locator("[data-testid='identity-phrase-words'] .chalk-recovery-word-text").allInnerTexts();
  await page.locator("[data-testid='identity-ack']").check();
  const inputs = page.locator("[data-testid='identity-challenge'] input[data-testid^='identity-challenge-']");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const idx = Number((await el.getAttribute('data-testid')).replace('identity-challenge-', ''));
    await el.fill(words[idx].trim());
  }
  await page.locator("[data-testid='identity-generate-confirm']").click();
  await page.waitForSelector("[data-state='open']", { timeout: 30000 });
  const whatsNew = page.locator("[data-testid='whats-new-dismiss']");
  await whatsNew.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await whatsNew.isVisible().catch(() => false)) await whatsNew.click();
  await page.waitForTimeout(1000);
  log('registered', username);
}

async function createChannel(page, name, group) {
  await page.locator("[data-testid='sidebar-new']").click();
  await page.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await page.locator("[data-testid='create-modal-name']").fill(name);
  // Pick the group if it exists. If not, select the last option (the one
  // that adds a group) and type the new group name.
  if (group) {
    const sel = page.locator("[data-testid='create-modal-group']");
    const options = await sel.locator('option').allTextContents();
    if (options.includes(group)) {
      await sel.selectOption(group);
    } else {
      await sel.selectOption({ index: options.length - 1 });
      await page.locator("[data-testid='create-modal-group-new']").fill(group);
    }
  }
  await page.locator("[data-testid='friend-picker-item']", { hasText: ub }).first().click();
  await page.locator("[data-testid='create-modal-submit']").click();
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function clearOverlaysEarly(page) {
  await page.waitForTimeout(300);
  for (const sel of ["[data-testid='whats-new-dismiss']", "[data-testid='avatar-nudge-later']", "[data-testid='avatar-nudge-close']"]) {
    const el = page.locator(sel);
    if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); await page.waitForTimeout(300); }
  }
}
// 129-17: the season demo. A fake clock sets the date, an init script makes a
// visit due at once, and the loop reloads until the wanted scene shows.
const SEASON_DATES = {
  neutral: [2026, 10, 10, 9],
  'late-autumn': [2026, 10, 28, 13],
  christmas: [2026, 11, 10, 13],
  winterfest: [2027, 0, 15, 13],
  'new-year': [2026, 11, 31, 13],
  'spring-bloom': [2026, 2, 15, 13],
  'green-season': [2026, 4, 10, 13],
  midsummer: [2026, 6, 1, 13],
  'harvest-festival': [2026, 8, 10, 13],
  'spooky-season': [2026, 9, 20, 13],
};
// Returns the scene names of the key, in table order. The names of neutral come
// from offseason.ts, the names of christmas come from christmas.ts, and the
// names of new-year come from newyear.ts. The other names come from the rows in
// scene.ts.
function sceneNames(key) {
  const scripted = { neutral: ['offseason.ts', 'OFFSEASON'], christmas: ['christmas.ts', 'CHRISTMAS'], 'new-year': ['newyear.ts', 'NEWYEAR'] }[key];
  if (scripted) {
    const off = readFileSync(new URL(`../../../web/src/season/${scripted[0]}`, import.meta.url), 'utf8');
    const list = off.slice(off.indexOf(`export const ${scripted[1]}`));
    return [...list.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  }
  const src = readFileSync(new URL('../../../web/src/season/scene.ts', import.meta.url), 'utf8');
  const head = /^[a-z]+$/.test(key) ? `  ${key}: [` : `  "${key}": [`;
  const at = src.indexOf(head);
  if (at < 0) return [];
  const body = src.slice(at, src.indexOf('\n  ],', at));
  return [...body.matchAll(/row\("([^"]+)"/g)].map((m) => m[1]);
}
async function seasonDemo(key, only, secs) {
  if (!SEASON_DATES[key]) {
    console.error(`unknown season: ${key} (known: ${Object.keys(SEASON_DATES).join(', ')})`);
    process.exit(2);
  }
  const names = sceneNames(key);
  if (only && !names.includes(only)) {
    console.error(`unknown scene for ${key}: ${only} (known: ${names.join(', ')})`);
    process.exit(2);
  }
  const targets = only ? [only] : names;
  await A.clock.install({ time: new Date(...SEASON_DATES[key]) });
  await A.addInitScript(() => {
    const now = Date.now();
    const d = new Date(now);
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    try {
      localStorage.removeItem('chalk.season.visits.v1');
      localStorage.setItem('chalk.season.neutral.v1', JSON.stringify({ day, at: [now - 1000, now - 1000], done: [false, false] }));
    } catch {}
  });
  const canvas = A.locator("[data-testid='season-scene']");
  for (let i = 0; ; i = (i + 1) % targets.length) {
    let shown = '';
    for (let tries = 0; tries < 25 && shown !== targets[i]; tries++) {
      await A.reload();
      await A.waitForSelector("[data-testid='season-anchor']", { timeout: 20000 });
      await clearOverlaysEarly(A);
      await A.clock.fastForward(13000);
      await A.waitForSelector("[data-testid='season-scene'][data-visible]", { timeout: 10000 }).catch(() => {});
      shown = (await canvas.getAttribute('data-scene').catch(() => null)) || '';
      log('season demo', key, 'want', targets[i], 'got', shown || '(none)');
    }
    console.log(`SCENE ${key}: ${shown || '(none)'}${shown === targets[i] ? '' : ` (wanted ${targets[i]})`}`);
    await A.evaluate((t) => {
      let tag = document.getElementById('demo-theme-tag');
      if (!tag) { tag = document.createElement('div'); tag.id = 'demo-theme-tag'; tag.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:6px;font:600 14px monospace;background:#000c;color:#fff;pointer-events:none'; document.body.appendChild(tag); }
      tag.textContent = t;
    }, `${key} · ${shown || 'no visit'}`).catch(() => {});
    await A.waitForTimeout(secs * 1000);
  }
}
const VOICE = process.env.VOICE === '1';
const MEDIA = ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'];
const browser = await chromium.launch({ headless: !HEADED, args: VOICE ? MEDIA : ['--no-sandbox'] });
const ctxA = await browser.newContext({ baseURL: BASE, viewport: HEADED ? null : { width: 1280, height: 800 }, permissions: VOICE ? ['camera', 'microphone'] : [] });
const ctxB = await (HEADED ? (await chromium.launch({ args: VOICE ? MEDIA : ['--no-sandbox'] })) : browser).newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 }, permissions: VOICE ? ['camera', 'microphone'] : [] });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errors = [];
A.on('pageerror', (e) => errors.push(String(e)));

const ua = `ann${RUN}`, ub = `bob${RUN}`;
await register(A, ua);
await A.locator('main.chalk-main').screenshot({ path: OUT + 'no-channel.png' }).catch((e) => log('no-channel shot', e));
await register(B, ub);

await A.locator("[data-testid='sidebar-add-friend']").click();
await A.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await A.locator("[data-testid='friends-directory-row']", { hasText: ub }).locator("[data-testid='friends-directory-add']").click();
await A.waitForTimeout(600);
await A.locator("[data-testid='friends-panel-close']").click();
await B.locator("[data-testid='sidebar-add-friend']").click();
await B.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await B.locator("[data-testid='friends-tab-pending']").click();
await B.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await B.waitForTimeout(600);
await B.locator("[data-testid='friends-panel-close']").click();


// Extra users (--users=5 adds cat, dan, and eve to ann and bob). Each one is
// a friend of ann, so the voice room can hold more than two people.
const USERS = Math.max(2, Number(process.env.USERS || 2));
const extras = [];
if (USERS > 2) {
  const xb = HEADED ? await chromium.launch({ args: VOICE ? MEDIA : ['--no-sandbox'] }) : browser;
  const names = ['cat', 'dan', 'eve', 'fay', 'gus', 'hal'].slice(0, USERS - 2).map((n) => `${n}${RUN}`);
  extras.push(...(await Promise.all(names.map(async (n) => {
    const ctx = await xb.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 }, permissions: VOICE ? ['camera', 'microphone'] : [] });
    const P = await ctx.newPage();
    await register(P, n);
    return { P, n };
  }))));
  await A.locator("[data-testid='sidebar-add-friend']").click();
  await A.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
  for (const { n } of extras) {
    await A.locator("[data-testid='friends-directory-row']", { hasText: n }).locator("[data-testid='friends-directory-add']").click();
    await A.waitForTimeout(400);
  }
  await A.locator("[data-testid='friends-panel-close']").click();
  for (const { P } of extras) {
    await clearOverlaysEarly(P);
    await P.locator("[data-testid='sidebar-add-friend']").click();
    await P.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
    await P.locator("[data-testid='friends-tab-pending']").click();
    await P.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
    await P.waitForTimeout(400);
    await P.locator("[data-testid='friends-panel-close']").click();
  }
  log('extras', names.join(' '));
}
await createChannel(A, 'general');
await A.locator("[data-testid='composer-input']").fill('hello from ann, a line of ordinary chat');
await A.locator("[data-testid='composer-send']").click();
await A.waitForSelector("[data-testid='message-body']", { timeout: 8000 });
await createChannel(A, 'random');
await createChannel(A, 'quiet');
// Channels in groups, for a look at chaos mode (one activity list with group tags).
const GROUPS = process.env.GROUPS === '1';
if (GROUPS) {
  for (const [name, group] of [
    ['frontend', 'dev'],
    ['backend', 'dev'],
    ['tracks', 'music'],
    ['infrastructure-migration', 'operations'],
    ['boardgames', 'friday-boardgame-night'],
    ['alerts', 'ops'],
  ]) {
    await createChannel(A, name, group);
    log('created', name, 'in', group);
  }
}

// Bob posts into general while ann is in quiet, so general has an unread.
await B.waitForTimeout(1500);
await B.locator('.chalk-sidebar-item', { hasText: 'general' }).first().click();
await B.locator("[data-testid='composer-input']").fill('hi ann, this one is unread for you');
await B.locator("[data-testid='composer-send']").click();
if (GROUPS) {
  // Dismiss the avatar nudge first. Its backdrop intercepts the click on the sidebar row.
  await B.waitForTimeout(800);
  await clearOverlaysEarly(B);
  await B.locator('.chalk-sidebar-item', { hasText: 'infrastructure-migration' }).first().click();
  await B.locator("[data-testid='composer-input']").fill('the migration window moved to friday');
  await B.locator("[data-testid='composer-send']").click();
}
await A.waitForTimeout(2000);

async function clearOverlays(page) {
  await page.locator("[data-testid='avatar-nudge-backdrop']").waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  for (const sel of ["[data-testid='whats-new-dismiss']", "[data-testid='avatar-nudge-later']", "[data-testid='avatar-nudge-close']"]) {
    const el = page.locator(sel);
    if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); await page.waitForTimeout(300); }
  }
}
if (VOICE) {
  await clearOverlays(A);
  await clearOverlays(B);
  await A.locator("[data-testid='sidebar-new']").click();
  await A.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await A.locator("[data-testid='create-modal-name']").fill('lounge');
  await A.locator("[data-testid='create-modal-voice']").check();
  { const items = A.locator("[data-testid='friend-picker-item']"); const k = await items.count(); for (let i = 0; i < k; i++) await items.nth(i).click(); }
  await A.locator("[data-testid='create-modal-submit']").click();
  await A.waitForSelector("[data-testid='call-rail-foot']", { timeout: 20000 });
  await B.waitForTimeout(1500);
  for (const sel of ["[data-testid='whats-new-dismiss']", "[data-testid='avatar-nudge-close']", "[data-testid='avatar-nudge-later']"]) {
    const el = B.locator(sel);
    if (await el.isVisible().catch(() => false)) { await el.click(); await B.waitForTimeout(300); }
  }
  await B.locator("[data-testid='sidebar-item']", { hasText: 'lounge' }).first().click();
  await B.locator("[data-testid='voice-join']").click({ timeout: 10000 }).catch((e) => log('B join', e));
  for (const { P } of extras) {
    await clearOverlays(P);
    await P.locator("[data-testid='sidebar-item']", { hasText: 'lounge' }).first().click();
    await P.locator("[data-testid='voice-join']").click({ timeout: 5000 }).catch(() => {});
  }
  await A.waitForTimeout(extras.length ? 4000 : 0);
  await A.waitForTimeout(2000);
  log('voice joined');
  await clearOverlays(A);
  await A.screenshot({ path: OUT + 'voice-now.png' });
  await B.screenshot({ path: OUT + 'voice-friend.png' });
  if (process.env.SWEEP_VOICE === '1') {
    const info = (P) => P.evaluate(() => {
      const s = document.querySelector("[data-testid='voice-stage']");
      const r = (q) => [...document.querySelectorAll(q)].map((e) => { const b = e.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); });
      return { mode: s?.dataset.stageMode, clipped: !!s && (s.scrollHeight > s.clientHeight + 1 || [...s.querySelectorAll('.chalk-voice-peer')].some((e) => e.getBoundingClientRect().bottom > s.getBoundingClientRect().bottom + 0.5)), cards: r('.chalk-voice-peer--card'), speakingCards: document.querySelectorAll('.chalk-voice-peer--card .chalk-voice-speak-dot').length, videos: r('.chalk-voice-videos .chalk-voice-peer'), big: r('.chalk-voice-peer--big'), strip: r('.chalk-voice-peer--strip') };
    });
    console.log('cards (A view)', JSON.stringify(await info(A)));
    const atSizes = async (label) => {
      const out = [];
      for (const [w, h] of [[1280, 800], [1229, 790], [1229, 700], [1440, 900]]) {
        await A.setViewportSize({ width: w, height: h });
        await A.waitForTimeout(700);
        const i = await info(A);
        out.push(`${w}x${h}:${i.clipped ? 'CLIPPED' : 'ok'} v=${i.videos.join(',') || '-'} c=${i.cards.length}`);
        if (w === 1229) await A.screenshot({ path: `${OUT}vs-${label}-1229x700.png` });
      }
      await A.setViewportSize({ width: 1280, height: 800 });
      await A.waitForTimeout(500);
      console.log(label.padEnd(10), out.join(' | '));
    };
    for (const t of ['green', 'light', 'warmwhite', 'cyberpunk', 'solarized-dark', 'lcars']) {
      await A.evaluate((x) => { if (x === 'green') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', x); }, t);
      await A.waitForTimeout(250);
      await A.screenshot({ path: `${OUT}vs-${t}.png` });
    }
    await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await clearOverlays(B);
    await A.locator("[data-testid='call-rail-mute']").click();
    await B.waitForTimeout(3000);
    console.log('speaking (B view)', JSON.stringify(await info(B)));
    await B.screenshot({ path: OUT + 'vs-speaking-B.png' });
    await A.locator("[data-testid='composer-input']").fill('link to the doc we talked about');
    await A.locator("[data-testid='composer-send']").click();
    await A.waitForTimeout(1000);
    await A.locator("[data-testid='call-rail-cam']").click();
    await A.waitForTimeout(3000);
    await atSizes('one-cam');
    await B.locator("[data-testid='call-rail-cam']").click().catch((e) => log('B cam', e));
    await A.waitForTimeout(4000);
    await atSizes('two-cams');
    await A.screenshot({ path: OUT + 'vs-two-cams.png' });
    if (extras.length) {
      await extras[0].P.locator("[data-testid='call-rail-cam']").click().catch((e) => log('cam', e));
      await A.waitForTimeout(4000);
      await atSizes('three-cams');
      await A.screenshot({ path: OUT + 'vs-three-cams.png' });
      for (const { P } of extras.slice(1)) await P.locator("[data-testid='call-rail-cam']").click().catch((e) => log('cam', e));
      await A.waitForTimeout(5000);
      await atSizes('all-cams');
      await A.locator("[data-testid='voice-layout-toggle']").click();
      await A.waitForTimeout(800);
      await atSizes('forced-grid');
      await A.locator("[data-testid='voice-layout-toggle']").click();
      await A.locator("[data-testid='voice-layout-toggle']").click();
      await A.waitForTimeout(800);
      await A.screenshot({ path: OUT + 'vs-all-cams.png' });
      await A.setViewportSize({ width: 390, height: 760 });
      await A.waitForTimeout(800);
      await A.screenshot({ path: OUT + 'vs-all-cams-phone.png' });
      await A.setViewportSize({ width: 1280, height: 800 });
    }
    await A.locator("[data-testid='call-rail-share']").click().catch((e) => log('share', e));
    await A.waitForTimeout(4000);
    console.log('share (A view)', JSON.stringify(await info(A)));
    console.log('share (B view)', JSON.stringify(await info(B)));
    await A.screenshot({ path: OUT + 'vs-share-A.png' });
    await B.screenshot({ path: OUT + 'vs-share-B.png' });
    await B.setViewportSize({ width: 390, height: 760 });
    await B.waitForTimeout(800);
    await B.screenshot({ path: OUT + 'vs-share-B-phone.png' });
    await browser.close();
    process.exit(0);
  }
  const stageInfo = () => A.evaluate(() => { const s = document.querySelector("[data-testid='voice-stage']"); const r = (q) => [...document.querySelectorAll(q)].map((e) => { const b = e.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); }); return { mode: s?.dataset.stageMode, clipped: !!s && (s.scrollHeight > s.clientHeight + 1 || [...s.querySelectorAll('.chalk-voice-peer')].some((e) => e.getBoundingClientRect().bottom > s.getBoundingClientRect().bottom + 0.5)), cards: r('.chalk-voice-peer--card'), videos: r('.chalk-voice-videos .chalk-voice-peer'), feed: r('.chalk-messages--ephemeral') }; });
  console.log('cards', JSON.stringify(await stageInfo()));
  await A.setViewportSize({ width: 390, height: 760 });
  await A.waitForTimeout(600);
  await A.screenshot({ path: OUT + 'voice-phone-cards.png' });
  await A.setViewportSize({ width: 1280, height: 800 });
  await A.waitForTimeout(400);
  await A.locator("[data-testid='composer-input']").fill('link to the doc we talked about');
  await A.locator("[data-testid='composer-send']").click();
  await A.waitForTimeout(1200);
  console.log('caption', await A.locator("[data-testid='voice-scratch-note']").isVisible());
  await A.screenshot({ path: OUT + 'voice-note.png' });
  await A.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await A.waitForTimeout(300);
  await A.screenshot({ path: OUT + 'voice-light.png' });
  await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await A.locator("[data-testid='call-rail-cam']").click();
  await A.waitForTimeout(3000);
  console.log('mixed', JSON.stringify(await stageInfo()));
  await A.screenshot({ path: OUT + 'voice-mixed.png' });
  await A.setViewportSize({ width: 390, height: 760 });
  await A.waitForTimeout(800);
  await A.screenshot({ path: OUT + 'voice-phone-mixed.png' });
  await A.locator("[data-testid='voice-cam']").first().click().catch(() => {});
  await A.waitForTimeout(1500);
  await A.screenshot({ path: OUT + 'voice-phone.png' });
  await A.setViewportSize({ width: 1280, height: 800 });
  if (process.env.VOICE_ONLY === '1') { await browser.close(); process.exit(0); }
}

const nudge = A.locator("[data-testid='avatar-nudge-later']");
await nudge.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
if (await nudge.isVisible().catch(() => false)) { await nudge.click(); await A.waitForTimeout(500); }

if (HEADED) {
  writeFileSync(OUT + 'credentials.txt', `base: ${BASE}\nuser: ${ua}\nfriend: ${ub}\npassword: ${PASSWORD}\ntotp secret ${ua}: ${secrets[ua]}\ntotp secret ${ub}: ${secrets[ub]}\n` + extras.map(({ n }) => `totp secret ${n}: ${secrets[n]}\n`).join(''));
  console.log('READY', ua, 'credentials in', OUT + 'credentials.txt');
  if (!VOICE) await ctxB.close();
  if (process.env.SEASON) await seasonDemo(process.env.SEASON, process.env.SCENE, Number(process.env.SCENE_SECS || 30));
  if (process.env.CYCLE === '1') {
    await A.locator('.chalk-sidebar-item', { hasText: 'general' }).first().click().catch(() => {});
    const all = ['green','light','snazzy-light','warmwhite','vscode-light','catppuccin-latte','cyberpunk','solarized-dark','tokyo-night','lcars','blade-runner','azeroth','darkord','exchalk','catppuccin-mocha'];
    const secs = Number(process.env.CYCLE_SECS || 5);
    for (let i = 0; ; i = (i + 1) % all.length) {
      await A.evaluate((t) => {
        if (t === 'green') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', t);
        let tag = document.getElementById('demo-theme-tag');
        if (!tag) { tag = document.createElement('div'); tag.id = 'demo-theme-tag'; tag.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:6px;font:600 14px monospace;background:#000c;color:#fff;pointer-events:none'; document.body.appendChild(tag); }
        tag.textContent = 'theme: ' + t;
      }, all[i]).catch(() => {});
      await A.waitForTimeout(secs * 1000);
    }
  }
  await new Promise(() => {});
}
const shots = [];
for (const theme of THEMES) {
  await A.evaluate((t) => {
    if (t === 'green') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await A.mouse.move(1000, 700);
  await A.waitForTimeout(300);
  const file = `${OUT}${theme}.png`;
  await A.screenshot({ path: file });
  await A.locator('.chalk-sidebar-item', { hasText: 'random' }).first().hover();
  await A.waitForTimeout(200);
  const hov = `${OUT}${theme}-hover-sidebar.png`;
  await A.locator('aside.chalk-sidebar').screenshot({ path: hov });
  shots.push(file, hov);
}

await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await A.locator('.chalk-sidebar-item', { hasText: 'random' }).first().focus();
await A.keyboard.press('Tab');
await A.keyboard.press('Shift+Tab');
await A.waitForTimeout(200);
await A.locator('aside.chalk-sidebar').screenshot({ path: `${OUT}focus-row.png` });
await A.locator("[data-testid='channel-search-button']").focus();
await A.keyboard.press('Shift+Tab');
await A.keyboard.press('Tab');
await A.waitForTimeout(200);
await A.screenshot({ path: `${OUT}focus-search.png`, clip: { x: 900, y: 50, width: 380, height: 70 } });

// 133-7: Every theme again, on a channel with messages.
await A.locator('.chalk-sidebar-item', { hasText: 'general' }).first().click();
await A.waitForTimeout(1000);
for (const theme of THEMES) {
  await A.evaluate((t) => {
    if (t === 'green') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await A.mouse.move(700, 300);
  await A.waitForTimeout(250);
  await A.screenshot({ path: `${OUT}${theme}-feed.png` });
}
await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
if (process.env.PHONE === '1') {
  await A.setViewportSize({ width: 390, height: 760 });
  await A.waitForTimeout(600);
  await A.screenshot({ path: OUT + 'phone-feed.png' });
  await A.locator("[data-testid='nav-toggle']").click();
  await A.waitForTimeout(600);
  await A.screenshot({ path: OUT + 'phone-drawer.png' });
  await A.keyboard.press('Escape');
  await A.setViewportSize({ width: 1280, height: 800 });
}
if (process.env.SWEEP_ONLY === '1') { await browser.close(); process.exit(0); }

// 133-5: The composer: empty, typed, in an edit, and at phone width.
const hdr = () => A.evaluate(() => Math.round(document.querySelector('.chalk-header').getBoundingClientRect().height));
console.log('header before composer', await hdr());
await A.locator('.chalk-sidebar-item', { hasText: 'general' }).first().click();
await A.waitForTimeout(800);
const footer = () => A.locator('footer.chalk-footer').screenshot({ path: `${OUT}composer-${shot++}.png` });
let shot = 0;
const input = A.locator("[data-testid='composer-input']");
const fieldX = async () => Math.round((await input.boundingBox()).x);
await footer();
await input.fill('a draft that makes send active');
await footer();
await input.fill('');
const xBefore = await fieldX();
await input.focus();
await A.keyboard.press('ArrowUp');
await A.waitForTimeout(500);
const editing = await A.locator('.chalk-composer--editing').count();
const xEdit = await fieldX();
await footer();
await A.keyboard.press('Escape');
await A.waitForTimeout(300);
for (const theme of ['light', 'cyberpunk', 'solarized-dark']) {
  await A.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await input.fill('typed');
  await A.waitForTimeout(150);
  await A.locator('footer.chalk-footer').screenshot({ path: `${OUT}composer-${theme}.png` });
}
await input.fill('');
await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await A.setViewportSize({ width: 390, height: 800 });
await A.waitForTimeout(500);
await A.locator('footer.chalk-footer').screenshot({ path: `${OUT}composer-phone.png` });
await A.setViewportSize({ width: 1280, height: 800 });
console.log('composer', JSON.stringify({ editing, xBefore, xEdit }));
console.log('header after resize', await hdr());
await A.reload(); await A.waitForSelector("[data-state='open']", { timeout: 30000 }); await A.waitForTimeout(2500);
console.log('header after reload', await hdr());
await A.locator('footer.chalk-footer').screenshot({ path: `${OUT}composer-edit-after.png` });

const m = await A.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width) }; };
  return {
    header: r('.chalk-header'),
    channelHeader: r('.chalk-channel-headwrap'),
    row: r('.chalk-sidebar-list--channels .chalk-sidebar-item'),
    friendRow: r('.chalk-sidebar-item--friend'),
    sidebar: r('aside.chalk-sidebar'),
  };
});
writeFileSync(OUT + 'metrics.json', JSON.stringify(m, null, 2));
console.log('metrics', JSON.stringify(m));
console.log('shots', shots.length, 'in', OUT);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();

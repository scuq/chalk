// 115: the flair demo -- a campfire to watch. Kept, not a probe: it asserts
// nothing, it puts the animated mode in front of a person.
//
// Registers you (a headed window that stays open, signed in) plus four bots
// (headless), makes everyone friends, puts all five in a channel, turns
// flair on for you with a short threshold (3 messages in 1 minute, so the
// flame visibly comes and goes), gives three bots a picture and a frame,
// then runs forever:
//   * three bots chat in bursts in "campfire", then go quiet, so the flame
//     lights and goes out;
//   * one bot flips away/online every half minute, so its name waves;
//   * one bot sends you a DM now and then, so its name waves too (and its
//     row gets a flame when the DMs pile up).
//
// Run from the repo root with the dev stack up (the flair-demo skill has the
// launch line); kill the node process to stop. Credentials for all five
// accounts, TOTP secrets included, land in /tmp/chalk-demo/credentials.txt:
//   node .claude/skills/run-chalk/flair-demo.mjs
//
// Two things a run taught: the frame picker's native radio is hidden by the
// theme-picker CSS, so the label is what gets clicked; and a fresh channel
// can miss a bot's picture (112's fan-out skips a channel whose key has not
// arrived yet), which is why the channel is created and left alone for a
// few seconds before the pictures go up.
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const OUT = '/tmp/chalk-demo/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'demo.log';
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' ');
  appendFileSync(LOG, line + '\n');
  console.log(line);
};

const BASE = 'http://localhost:8443';
const RUN = Date.now() % 10000;
const VIEWER = `scuq${RUN}`;
const BOTS = [`ada${RUN}`, `bea${RUN}`, `cid${RUN}`, `dot${RUN}`];
const PASSWORD = 'chalk Driver Passw0rd!!';
const CHANNEL = 'campfire';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const creds = [];

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
  await totpStep.waitFor({ timeout: 240000 });
  const secret = (await page.locator("[data-testid='signup-secret']").innerText()).trim();
  creds.push(`${username}  password: ${PASSWORD}  totp secret: ${secret}`);
  await totpStep.locator('input').fill(totpNow(secret));
  await page.locator("[data-testid='signup-finish']").click();
  await page.waitForSelector("[data-testid='recovery-screen']", { timeout: 30000 });
  await page.locator("[data-testid='recovery-ack']").check();
  const cont = page.locator("[data-testid='recovery-continue']");
  await cont.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='recovery-continue']").disabled,
    null, { timeout: 20000 });
  await cont.click();
  await page.waitForSelector("[data-testid='identity-setup-generate']", { timeout: 30000 });
  const words = await page
    .locator("[data-testid='identity-phrase-words'] .chalk-recovery-word-text").allInnerTexts();
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
  await page.waitForTimeout(800);
  log('registered', username);
}

const dismissNudge = async (page) => {
  const nudge = page.locator("[data-testid='avatar-nudge-later']");
  if (await nudge.isVisible().catch(() => false)) {
    await nudge.click();
    await page.waitForTimeout(400);
  }
};
const openChannel = async (page, name) => {
  await dismissNudge(page);
  await page.locator("[data-testid='sidebar-item']", { hasText: name }).first().click();
  await page.waitForTimeout(600);
};
const send = async (page, text) => {
  const input = page.locator("[data-testid='composer-input']");
  await input.fill(text);
  await input.press('Enter');
};
const openSettings = async (page, tab) => {
  await dismissNudge(page);
  await page.locator("[data-testid='status-user-menu-trigger']").click();
  await page.waitForTimeout(300);
  await page.locator("[data-testid='status-user-menu-profile']").click();
  await page.waitForSelector("[data-testid='profile-panel']", { timeout: 8000 });
  await page.locator(`[data-testid='profile-tab-${tab}']`).click();
  await page.waitForTimeout(400);
};
const closeSettings = async (page) => {
  await page.locator("[data-testid='profile-panel-close']").click();
  await page.waitForTimeout(400);
};

const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) { console.error('chalkd not reachable'); process.exit(1); }

// ---- everyone registers at once -------------------------------------------
const headed = await chromium.launch({ headless: false, args: ['--no-sandbox', '--window-size=1400,900'] });
const headless = await chromium.launch({ args: ['--no-sandbox'] });
const viewerCtx = await headed.newContext({ baseURL: BASE, viewport: null });
const viewer = await viewerCtx.newPage();
viewer.on('pageerror', (e) => log('viewer page error:', String(e)));
const bots = [];
for (const name of BOTS) {
  const ctx = await headless.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'page error:', String(e)));
  bots.push({ name, page });
}
log('registering five accounts in parallel (Argon2id: a minute or two)…');
await Promise.all([register(viewer, VIEWER), ...bots.map((b) => register(b.page, b.name))]);
writeFileSync(OUT + 'credentials.txt', creds.join('\n') + '\n');

// ---- friends ----------------------------------------------------------------
await dismissNudge(viewer);
await viewer.locator("[data-testid='sidebar-add-friend']").click();
await viewer.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
for (const b of bots) {
  await viewer.locator("[data-testid='friends-directory-row']", { hasText: b.name })
    .locator("[data-testid='friends-directory-add']").click();
  await viewer.waitForTimeout(500);
}
await viewer.locator("[data-testid='friends-panel-close']").click();
for (const b of bots) {
  await dismissNudge(b.page);
  await b.page.locator("[data-testid='sidebar-add-friend']").click();
  await b.page.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
  await b.page.locator("[data-testid='friends-tab-pending']").click();
  await b.page.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
  await b.page.waitForTimeout(500);
  await b.page.locator("[data-testid='friends-panel-close']").click();
}
log('friends made');

// ---- the channel ------------------------------------------------------------
await viewer.locator("[data-testid='sidebar-new']").click();
await viewer.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
await viewer.locator("[data-testid='create-modal-name']").fill(CHANNEL);
const picks = viewer.locator("[data-testid='friend-picker-item']");
const n = await picks.count();
for (let i = 0; i < n; i++) await picks.nth(i).click();
await viewer.locator("[data-testid='create-modal-submit']").click();
await viewer.waitForSelector("[data-testid='create-modal']", { state: 'detached', timeout: 15000 });
await viewer.waitForTimeout(3000);
log('channel', CHANNEL, 'created with', n, 'members');

// ---- your flair -------------------------------------------------------------
await openSettings(viewer, 'appearance');
await viewer.locator("[data-testid='display-show-roster-avatars']").check();
await viewer.locator("[data-testid='display-show-avatars']").check();
await viewer.locator("[data-testid='flair-on']").check();
await viewer.waitForTimeout(200);
await viewer.locator("[data-testid='flair-burst-count']").fill('3');
await viewer.locator("[data-testid='flair-burst-count']").press('Tab');
await viewer.locator("[data-testid='flair-burst-minutes']").fill('1');
await viewer.locator("[data-testid='flair-burst-minutes']").press('Tab');
await viewer.waitForTimeout(300);
await closeSettings(viewer);
log('flair on for', VIEWER, '(3 messages in 1 minute)');

// ---- pictures and frames for three bots --------------------------------------
const png = OUT + 'face.png';
await bots[0].page.screenshot({ path: png });
const frames = ['ember', 'aurora', 'pulse'];
for (let i = 0; i < 3; i++) {
  const b = bots[i];
  try {
    await openSettings(b.page, 'account');
    await b.page.locator("[data-testid='profile-avatar-input']").setInputFiles(png);
    await b.page.waitForSelector("[data-testid='avatar-crop']", { timeout: 10000 });
    await b.page.locator("[data-testid='banner-cropper-all']").click().catch(() => {});
    await b.page.locator("[data-testid='banner-cropper-apply']").click();
    await b.page.waitForSelector("[data-testid='avatar-crop']", { state: 'detached', timeout: 30000 });
    await b.page.waitForFunction(() => !document.querySelector("[data-testid='profile-avatar-busy']"), null, { timeout: 60000 });
    await b.page.locator("[data-testid='profile-tab-appearance']").click();
    await b.page.waitForTimeout(300);
    await b.page.locator(`label:has([data-testid='frame-option-${frames[i]}'])`).click();
    await b.page.waitForTimeout(600);
    await closeSettings(b.page);
    log(b.name, 'wears', frames[i]);
  } catch (err) {
    log(b.name, 'picture/frame skipped:', String(err).split('\n')[0]);
    await closeSettings(b.page).catch(() => {});
  }
}

// A reload re-reads the directory, so the frames show up for you.
await viewer.reload();
await viewer.waitForSelector("[data-testid='sidebar-list']", { timeout: 30000 });
await viewer.waitForTimeout(3000);
await dismissNudge(viewer);
await openChannel(viewer, CHANNEL);
for (const b of bots) await openChannel(b.page, CHANNEL);
log('everyone is in', CHANNEL, '-- watch the window. Ctrl-C (or kill node) to stop.');

// ---- the show ---------------------------------------------------------------
const LINES = [
  'anyone around?', 'just pushed the fix', 'ha, nice', 'wait what', 'ok that works',
  'brb coffee', 'lol', 'ship it', 'one more thing', 'did you see that?', 'yes!!',
  'who broke the build', 'not me', 'it was me', 'classic', 'ok ok', 'testing the flame',
];
const chatters = [bots[0], bots[1], bots[3]];
const rand = (a, b) => a + Math.random() * (b - a);

const chat = async () => {
  for (;;) {
    const burst = 4 + Math.floor(Math.random() * 3);
    log(`burst of ${burst}`);
    for (let i = 0; i < burst; i++) {
      const b = chatters[Math.floor(Math.random() * chatters.length)];
      await send(b.page, LINES[Math.floor(Math.random() * LINES.length)]).catch((e) => log('send failed', String(e)));
      await sleep(rand(2000, 5000));
    }
    log('quiet for ~100s -- the flame should go out about a minute after the last message');
    await sleep(100000);
  }
};
const flip = async () => {
  const b = bots[3];
  await sleep(15000);
  for (;;) {
    try {
      await b.page.locator("[data-testid='presence-trigger']").click();
      await b.page.locator("[data-testid='presence-menu-away']").click();
      log(b.name, 'went away');
      await sleep(20000);
      await b.page.locator("[data-testid='presence-trigger']").click();
      await b.page.locator("[data-testid='presence-menu-online']").click();
      log(b.name, 'is back online -- name waves');
    } catch (e) { log('flip failed', String(e).split('\n')[0]); }
    await sleep(35000);
  }
};
const dm = async () => {
  const b = bots[2];
  await sleep(30000);
  try {
    await dismissNudge(b.page);
    await b.page.locator("[data-testid='sidebar-friend-item']", { hasText: VIEWER }).first().click();
    await b.page.waitForTimeout(1500);
  } catch (e) { log('dm open failed', String(e).split('\n')[0]); return; }
  for (;;) {
    await send(b.page, 'psst, got a minute?').catch((e) => log('dm failed', String(e)));
    log(b.name, 'sent you a DM -- name waves');
    await sleep(rand(50000, 70000));
  }
};
await Promise.all([chat(), flip(), dm()]);

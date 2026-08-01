// README screenshot run: two users, a real conversation, reaction + thread,
// captured on desktop and iPhone-14 emulation. Based on run-chalk/driver.mjs.
//
// Output lands in /tmp/chalk-driver/readme/; copy the PNGs to
// docs/screenshots/ when they look right. USER_A/USER_B are registered fresh
// through the full signup, so both handles must not exist yet — pick new ones
// (or wipe the old rows) before re-running.
import { chromium, devices } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8443';
const OUT = '/tmp/chalk-driver/readme/';
mkdirSync(OUT, { recursive: true });

const RUN = Date.now() % 1000;
const PASSWORD = 'chalk Driver Passw0rd!!';

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
  await totpStep.waitFor({ timeout: 120000 }).catch(async (e) => {
    const banner = await page.locator("[data-testid='signup-banner']").innerText().catch(() => '(none)');
    throw new Error(`TOTP step never showed (banner: ${banner}). ${e.message}`);
  });
  const secret = (await page.locator("[data-testid='signup-secret']").innerText()).trim();
  await totpStep.locator('input').fill(totpNow(secret));
  await page.locator("[data-testid='signup-finish']").click();

  await page.waitForSelector("[data-testid='recovery-screen']", { timeout: 30000 });
  await page.locator("[data-testid='recovery-ack']").check();
  const cont = page.locator("[data-testid='recovery-continue']");
  await cont.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='recovery-continue']").disabled,
    null, { timeout: 20000 },
  );
  await cont.click();

  await page.waitForSelector("[data-testid='identity-setup-generate']", { timeout: 30000 });
  const words = await page
    .locator("[data-testid='identity-phrase-words'] .chalk-recovery-word-text")
    .allInnerTexts();
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
  await page.waitForTimeout(1000);
  console.log(`registered ${username}`);
}

const openDrawer = async (page) => {
  const t = page.locator("[data-testid='nav-toggle']");
  if (await t.isVisible().catch(() => false)) { await t.click(); await page.waitForTimeout(400); }
};

const openChannel = async (page, name) => {
  await openDrawer(page);
  await page.locator("[data-testid='sidebar-item']", { hasText: name }).first().click();
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 10000 });
  await page.waitForTimeout(400);
};

const send = async (page, text) => {
  await page.locator("[data-testid='composer-input']").first().fill(text);
  await page.locator("[data-testid='composer-send']").first().click();
  await page.waitForTimeout(700);
};

// ---- main ------------------------------------------------------------
const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) { console.error('chalkd not reachable'); process.exit(1); }

const USER_A = 'ada';
const USER_B = 'kai';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({
  viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, baseURL: BASE,
});
const ctxB = await browser.newContext({ ...devices['iPhone 14'], baseURL: BASE });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
pageA.on('pageerror', e => console.log('A pageerror:', String(e).slice(0, 200)));
pageB.on('pageerror', e => console.log('B pageerror:', String(e).slice(0, 200)));

console.log('registering both users (Argon2id — slow)...');
await register(pageA, USER_A);
await register(pageB, USER_B);

// Friend the two: A adds from the directory, B accepts.
await openDrawer(pageA);
await pageA.locator("[data-testid='sidebar-add-friend']").click();
await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageA.locator("[data-testid='friends-directory-row']")
  .filter({ has: pageA.getByText(`@${USER_B}`, { exact: true }) })
  .locator("[data-testid='friends-directory-add']").click();
await pageA.waitForTimeout(600);
await pageA.locator("[data-testid='friends-panel-close']").click();

await openDrawer(pageB);
await pageB.locator("[data-testid='sidebar-add-friend']").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await pageB.waitForTimeout(600);
await pageB.locator("[data-testid='friends-panel-close']").click();

// Two channels so the sidebar looks lived-in.
const createChannel = async (name) => {
  await openDrawer(pageA);
  await pageA.locator("[data-testid='sidebar-new']").click();
  await pageA.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await pageA.locator("[data-testid='create-modal-name']").fill(name);
  await pageA.locator("[data-testid='friend-picker-item']").first().click();
  await pageA.locator("[data-testid='create-modal-submit']").click();
  await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });
  await pageA.waitForTimeout(400);
};
console.log('creating channels');
await createChannel('gamenight');
await createChannel('general');

// The conversation, alternating desktop (A) and mobile (B).
console.log('holding the conversation');
await send(pageA, 'morning ☕ — anyone up for the climbing gym tonight?');

await openChannel(pageB, 'general');
await send(pageB, 'in! 7pm? I want another go at the yellow overhang');
await send(pageA, "7 works — I'll bring the new rope");
await send(pageB, 'legend 🙌 see you there');
await send(pageA, `@${USER_B} don't forget your belay card this time`);
await send(pageB, '😤 that was ONE time');
await send(pageA, 'also: new routes on the slab wall since this morning');
await send(pageB, 'ooh, dibs on naming the pink one');
await send(pageA, 'too late, the setters called it "cheese grater"');
await send(pageB, 'perfect. no notes');
await pageA.waitForTimeout(500);

// React to B's last message from desktop: right-click → quick emoji.
console.log('adding a reaction');
try {
  const target = pageA.locator("[data-testid='message']", { hasText: 'legend' }).last();
  await target.click({ button: 'right' });
  await pageA.waitForSelector("[data-testid='message-menu']", { timeout: 3000 });
  await pageA.locator("[data-testid='message-menu-quick'] button").first().click();
  await pageA.waitForTimeout(600);
  await pageA.keyboard.press('Escape').catch(() => {});
} catch (e) { console.log('reaction skipped:', e.message.slice(0, 120)); }

try {
  const target = pageA.locator("[data-testid='message']", { hasText: 'no notes' }).last();
  await target.click({ button: 'right' });
  await pageA.waitForSelector("[data-testid='message-menu']", { timeout: 3000 });
  await pageA.locator("[data-testid='message-menu-quick'] button").nth(1).click();
  await pageA.waitForTimeout(600);
  await pageA.keyboard.press('Escape').catch(() => {});
} catch (e) { console.log('reaction 2 skipped:', e.message.slice(0, 120)); }

// Thread reply on the overhang message.
console.log('starting a thread');
let threadOpen = false;
try {
  const target = pageA.locator("[data-testid='message']", { hasText: 'yellow overhang' }).first();
  await target.click({ button: 'right' });
  await pageA.waitForSelector("[data-testid='message-menu']", { timeout: 3000 });
  await pageA.locator("[data-testid='message-menu-reply']").click();
  await pageA.waitForSelector("[data-testid='thread-panel']", { timeout: 5000 });
  const tp = pageA.locator("[data-testid='thread-panel']");
  await tp.locator("[data-testid='composer-input']").fill('beta: heel hook before the second bolt, then it\'s easy');
  await tp.locator("[data-testid='composer-send']").click();
  await pageA.waitForTimeout(600);
  await tp.locator("[data-testid='composer-input']").fill('and clip from the jug, not the sloper 😅');
  await tp.locator("[data-testid='composer-send']").click();
  await pageA.waitForTimeout(800);
  threadOpen = true;
} catch (e) { console.log('thread skipped:', e.message.slice(0, 120)); }

if (threadOpen) {
  await pageA.screenshot({ path: OUT + 'chat-thread.png' });
  console.log('shot: chat-thread.png');
  await pageA.locator("[data-testid='thread-panel-close']").click().catch(() => {});
  await pageA.waitForTimeout(400);
}

await pageA.mouse.move(0, 0);
await pageA.waitForTimeout(300);
await pageA.screenshot({ path: OUT + 'chat-desktop.png' });
console.log('shot: chat-desktop.png');

// Mobile: B looks at the same channel.
await pageB.waitForTimeout(800);
await pageB.screenshot({ path: OUT + 'chat-mobile.png' });
console.log('shot: chat-mobile.png');

writeFileSync(OUT + 'credentials.txt',
  `base: ${BASE}\nuser A: ${USER_A}\nuser B: ${USER_B}\npassword: ${PASSWORD}\n`);
console.log('done →', OUT);
await browser.close();

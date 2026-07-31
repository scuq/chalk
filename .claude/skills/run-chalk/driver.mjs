// run-chalk driver — launch-independent UI harness.
//
// Drives the REAL chalk SPA against a running dev server (see SKILL.md for
// the launch line): registers a fresh user through the auth-v2 signup wizard
// (password + live TOTP computed here + identity phrase), lands in the chat
// UI, screenshots along the way. With --friend it registers a second user,
// friends the two via the directory one-click add, creates a channel (which
// REQUIRES >=1 friend as member), and sends a message.
//
// Usage:
//   node .claude/skills/run-chalk/driver.mjs [--mobile] [--friend] [--base URL]
//
// Screenshots + credentials of the created user(s) land in /tmp/chalk-driver/.
import { chromium, devices } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const MOBILE = args.includes('--mobile');
const FRIEND = args.includes('--friend');
const BASE = args.includes('--base')
  ? args[args.indexOf('--base') + 1]
  : 'http://localhost:8443'; // localhost, not 127.0.0.1: matches CHALK_RP_ORIGINS

const OUT = '/tmp/chalk-driver/';
mkdirSync(OUT, { recursive: true });

const RUN = Date.now() % 100000;
const USER_A = `probe${RUN}`;
const USER_B = `friend${RUN}`;
// Server policy: >=20 chars, 4 classes (space counts as special).
const PASSWORD = 'chalk Driver Passw0rd!!';

// ---- TOTP (what an authenticator app does) ---------------------------
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

let shot = 0;
async function ss(page, name) {
  const file = `${OUT}${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  console.log('  screenshot:', file);
}

// register drives signup wizard + recovery ack + identity setup to the chat
// UI. The password step runs client-side Argon2id (256 MiB) — allow minutes,
// not seconds.
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
    throw new Error(`TOTP step never showed (banner: ${banner}). ` +
      `An "HTTP 500" banner usually means chalkd is missing CHALK_TOTP_ENC_KEY. ${e.message}`);
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

  // Identity gate: 24 words shown, a random subset asked back. Needs
  // WebCrypto Ed25519 (Chromium >= 137).
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
  console.log(`  registered ${username} (password: ${PASSWORD})`);
}

const openDrawer = async (page) => {
  const t = page.locator("[data-testid='nav-toggle']");
  if (await t.isVisible().catch(() => false)) { await t.click(); await page.waitForTimeout(400); }
};

// ---- main ------------------------------------------------------------
const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) {
  console.error(`chalkd not reachable at ${BASE} — start it first (see SKILL.md launch line)`);
  process.exit(1);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({
  ...(MOBILE ? devices['iPhone 14'] : {}),
  baseURL: BASE,
});
const pageA = await ctxA.newPage();
const errors = [];
pageA.on('pageerror', e => errors.push(String(e)));

console.log(`registering ${USER_A}${MOBILE ? ' (iPhone 14 emulation)' : ''}`);
await register(pageA, USER_A);
await ss(pageA, 'chat');

if (FRIEND) {
  console.log(`registering ${USER_B} and friending`);
  const ctxB = await browser.newContext({ baseURL: BASE });
  const pageB = await ctxB.newPage();
  await register(pageB, USER_B);

  // A sends the request from the server directory (one-click add)...
  await openDrawer(pageA);
  await pageA.locator("[data-testid='sidebar-add-friend']").click();
  await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
  await pageA.locator("[data-testid='friends-directory-row']", { hasText: USER_B })
    .locator("[data-testid='friends-directory-add']").click();
  await pageA.waitForTimeout(600);
  await pageA.locator("[data-testid='friends-panel-close']").click();

  // ...B accepts from the pending tab.
  await openDrawer(pageB);
  await pageB.locator("[data-testid='sidebar-add-friend']").click();
  await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
  await pageB.locator("[data-testid='friends-tab-pending']").click();
  await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
  await pageB.waitForTimeout(600);
  await pageB.locator("[data-testid='friends-panel-close']").click();

  // Channel create needs the friend selected as member — submit is disabled
  // with zero friends picked.
  console.log('creating channel + sending a message');
  await openDrawer(pageA);
  await pageA.locator("[data-testid='sidebar-new']").click();
  await pageA.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await pageA.locator("[data-testid='create-modal-name']").fill('driver-probe');
  await pageA.locator("[data-testid='friend-picker-item']").first().click();
  await pageA.locator("[data-testid='create-modal-submit']").click();
  await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });

  await pageA.locator("[data-testid='composer-input']").fill('driver probe message');
  await pageA.locator("[data-testid='composer-send']").click();
  await pageA.waitForSelector("[data-testid='message-body']", { timeout: 8000 });
  await pageA.waitForTimeout(800);
  await ss(pageA, 'channel-message');
}

writeFileSync(OUT + 'credentials.txt',
  `base: ${BASE}\nuser: ${USER_A}\n${FRIEND ? `user B: ${USER_B}\n` : ''}password: ${PASSWORD}\n`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.log(`done. output in ${OUT} (credentials.txt has the login)`);
await browser.close();

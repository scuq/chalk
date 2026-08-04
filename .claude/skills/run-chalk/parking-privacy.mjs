// parking-privacy -- regression cover for the privacy screen (53-5) and the
// way back off the parking lot (53-4).
//
// Kept because the node suite cannot hold it: the reducer and the key's guard
// are unit-tested in parking.test.ts / reducer-parking.test.ts, but the claim
// that actually protects the user is a CSS one — "every direct child of the
// shell except the parked pane is blurred" — and web/test.mjs has no DOM to
// ask. This asks the computed style instead: whether the header and the
// sidebar really are blurred, whether the parked pane really is not, and
// whether it all comes off again on the way back.
//
// Run it against a live stack (see SKILL.md for the launch line):
//   node .claude/skills/run-chalk/parking-privacy.mjs
// 15 checks; every one must print PASS.
//
// Drives: register -> turn the setting on -> F9 (park) -> F9 immediately
// (must be swallowed by the guard) -> F9 after the guard (must come back).
// Summary to stdout, noise to /tmp/chalk-probe/probe.log.
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const BASE = 'http://localhost:8443';
const OUT = '/tmp/chalk-probe/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';
const log = (...a) => appendFileSync(LOG, a.join(' ') + '\n');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const RUN = Date.now() % 100000;
const USER = `park${RUN}`;
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

let shot = 0;
async function ss(page, name) {
  const file = `${OUT}${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  log('screenshot', file);
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
  await totpStep.waitFor({ timeout: 180000 });
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
  log('registered', username);
}

// What the shell says about itself right now.
const shell = (page) => page.evaluate(() => {
  const filterOf = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).filter : '(missing)';
  };
  return {
    screened: !!document.querySelector('.chalk-app')?.classList.contains('chalk-app--screened'),
    parked: !!document.querySelector("[data-testid='parking-lot']"),
    header: filterOf('.chalk-header'),
    sidebar: filterOf('.chalk-sidebar'),
    main: filterOf('.chalk-main'),
    footer: filterOf('.chalk-app > footer'),
    title: document.title,
  };
});

// ---- main ------------------------------------------------------------
const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) { console.error('chalkd not reachable at', BASE); process.exit(1); }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ baseURL: BASE });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('pageerror:', String(e)));

try {
  console.log(`# registering ${USER} (client-side Argon2id: slow) …`);
  await register(page, USER);

  // Turn the privacy screen on: user menu -> profile -> chat tab.
  await page.locator("[data-testid='status-user-menu-trigger']").click();
  await page.locator("[data-testid='status-user-menu-profile']").click();
  await page.waitForSelector("[data-testid='profile-panel']", { timeout: 10000 });
  await page.locator("[data-testid='profile-tab-chat']").click();
  const box = page.locator("[data-testid='parking-screen']");
  await box.waitFor({ timeout: 10000 });
  check('the setting is where a person would look for it', true, 'settings → chat → parking lot');
  await ss(page, 'setting');
  await box.check();
  await page.waitForTimeout(400);
  check('the setting takes', await box.isChecked());
  await page.locator("[data-testid='profile-panel-close']").click();
  await page.waitForTimeout(400);

  // Every session starts parked and nothing has been opened, so the screen
  // should be on the moment the panel closes.
  let s = await shell(page);
  log('after settings', JSON.stringify(s));
  check('parked with the setting on is screened', s.screened && s.parked, JSON.stringify(s));
  check('the header blurs (your own handle is in it)', /blur/.test(s.header), s.header);
  check('the roster blurs', /blur/.test(s.sidebar), s.sidebar);
  check('the parked pane itself does NOT blur', s.main === 'none', s.main);
  await ss(page, 'parked-screened');

  // The session is parked because it started that way, which by design does
  // NOT arm the guard -- so this press comes straight back off the lot.
  await page.keyboard.press('F9');
  await page.waitForTimeout(400);
  s = await shell(page);
  check('parking the app did not arm the guard, so F9 leaves at once', !s.parked, JSON.stringify(s));
  check('leaving clears the blur', s.header === 'none' && s.sidebar === 'none',
    `${s.header} / ${s.sidebar}`);
  await ss(page, 'unparked');

  // Something on screen worth coming back to: the thread inbox panel, which
  // parking closes because it renders message text.
  await page.locator("[data-testid='sidebar-threads']").click();
  await page.waitForTimeout(500);
  const panelBefore = await page.locator(".chalk-threadinbox-panel").isVisible().catch(() => false);
  check('a side panel is open before parking', panelBefore);

  // Park with the key: THAT arms the guard.
  await page.keyboard.press('F9');
  await page.waitForTimeout(400);
  s = await shell(page);
  check('F9 parks', s.parked && s.screened, JSON.stringify(s));
  check('parking closed the panel',
    !(await page.locator(".chalk-threadinbox-panel").isVisible().catch(() => false)));
  await ss(page, 'parked-screened-2');

  // The panicked double-tap, well inside the 600ms guard.
  await page.keyboard.press('F9');
  await page.waitForTimeout(150);
  s = await shell(page);
  check('a press right after the key parked is swallowed', s.parked, JSON.stringify(s));

  // And after the guard, the way back -- with the panel where it was.
  await page.waitForTimeout(900);
  await page.keyboard.press('F9');
  await page.waitForTimeout(600);
  s = await shell(page);
  log('after unpark', JSON.stringify(s));
  check('F9 after the guard brings chalk back', !s.parked, JSON.stringify(s));
  check('coming back clears the blur', s.header === 'none' && s.sidebar === 'none',
    `${s.header} / ${s.sidebar}`);
  check('and puts the side panel back',
    await page.locator(".chalk-threadinbox-panel").isVisible().catch(() => false));
  await ss(page, 'restored');
} catch (e) {
  check('probe completed without exception', false, String(e).slice(0, 300));
  await ss(page, 'failure');
} finally {
  await browser.close();
}

writeFileSync(OUT + 'credentials.txt', `base: ${BASE}\nuser: ${USER}\npassword: ${PASSWORD}\n`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Log: ${LOG}`);
process.exit(failed.length ? 1 : 0);

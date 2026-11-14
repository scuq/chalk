// README screenshot run: three users, a real conversation, a reaction, and a thread.
// The script writes four PNGs to /tmp/chalk-driver/readme/:
// chat-desktop.png, chat-thread.png, chat-mobile.png, and chat-mobile-list.png.
// Based on run-chalk/driver.mjs.
//
// Copy the PNGs to docs/screenshots/ when they look right.
// The handles come from the environment variables README_USER_A, README_USER_B,
// and README_USER_C. The defaults are ada, kai, and noa.
// The script registers each user through the full signup,
// so each handle must not exist yet on the dev database.
// Before a re-run, set three new handles or delete the old rows.
//
// An overlay (the what's-new note or the avatar nudge) can open after sign-in.
// A locator handler closes it before each action.
// A handler runs only before an action, so the script also clears overlays before each screenshot.
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

// The what's-new note and the avatar nudge open at an unknown time after
// sign-in, and their backdrops block every click and cover a screenshot.
async function guard(page) {
  await page.addLocatorHandler(page.locator("[data-testid='whats-new-backdrop']"), async () => {
    await page.locator("[data-testid='whats-new-dismiss']").dispatchEvent('click').catch(() => {});
  }, { noWaitAfter: true });
  await page.addLocatorHandler(page.locator("[data-testid='avatar-nudge-backdrop']"), async () => {
    await page.locator("[data-testid='avatar-nudge-later'], [data-testid='avatar-nudge-close']").first().dispatchEvent('click').catch(() => {});
  }, { noWaitAfter: true });
}

// A locator handler runs only before an action, so a screenshot taken after
// a wait can still catch an overlay. This closes each overlay that is open.
async function clearOverlays(page) {
  for (const sel of ["[data-testid='whats-new-dismiss']", "[data-testid='avatar-nudge-later']", "[data-testid='avatar-nudge-close']"]) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.dispatchEvent('click'); await page.waitForTimeout(300); }
  }
}

async function shoot(page, name) {
  await clearOverlays(page);
  await page.screenshot({ path: OUT + name });
  console.log('shot:', name);
}

async function register(page, username) {
  await guard(page);
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

// 135-1: the phone has no drawer. Its roster is the chat list, so this goes
// back to the list if a chat is open. On desktop it does nothing.
const openDrawer = async (page) => {
  const back = page.locator("[data-testid='zucker-back']:visible");
  if (await back.count()) { await back.first().click(); await page.waitForTimeout(400); }
};
// 135-1: on the phone a new channel does not open by itself. Open its row.
const openNewChannel = async (page, name) => {
  const row = page.locator("[data-testid='zucker-row']:visible", { hasText: name });
  await row.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await row.count()) await row.first().click();
};

const openChannel = async (page, name) => {
  await openDrawer(page);
  await page.locator(":is([data-testid='sidebar-item'], [data-testid='zucker-row']):visible", { hasText: name }).first().click();
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

const USER_A = process.env.README_USER_A || 'ada';
const USER_B = process.env.README_USER_B || 'kai';
const USER_C = process.env.README_USER_C || 'noa';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({
  viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, baseURL: BASE,
});
const ctxB = await browser.newContext({ ...devices['iPhone 14'], baseURL: BASE });
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const pageC = await ctxC.newPage();
pageA.on('pageerror', e => console.log('A pageerror:', String(e).slice(0, 200)));
pageB.on('pageerror', e => console.log('B pageerror:', String(e).slice(0, 200)));

console.log('registering three users (Argon2id — slow)...');
await register(pageA, USER_A);
await register(pageB, USER_B);
await register(pageC, USER_C);

// Friend the two: A adds from the directory, B accepts.
await openDrawer(pageA);
await pageA.locator(":is([data-testid='sidebar-add-friend'], [data-testid='zucker-add-friend']):visible").click();
await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageA.locator("[data-testid='friends-directory-row']")
  .filter({ has: pageA.getByText(`@${USER_B}`, { exact: true }) })
  .locator("[data-testid='friends-directory-add']").click();
await pageA.waitForTimeout(600);
await pageA.locator("[data-testid='friends-panel-close']").click();

await openDrawer(pageB);
await pageB.locator(":is([data-testid='sidebar-add-friend'], [data-testid='zucker-add-friend']):visible").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await pageB.waitForTimeout(600);
await pageB.locator("[data-testid='friends-panel-close']").click();

// Two channels so the sidebar looks lived-in.
const createChannel = async (name) => {
  await openDrawer(pageA);
  await pageA.locator(":is([data-testid='sidebar-new'], [data-testid='zucker-new-channel']):visible").click();
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

// Thread reply on the overhang message. An overlay can open in the middle of
// the step, so the step clears overlays first and tries once more on failure.
console.log('starting a thread');
let threadOpen = false;
for (let attempt = 1; attempt <= 2 && !threadOpen; attempt++) {
  try {
    await clearOverlays(pageA);
    const tp = pageA.locator("[data-testid='thread-panel']");
    if (!(await tp.isVisible().catch(() => false))) {
      const target = pageA.locator("[data-testid='message']", { hasText: 'yellow overhang' }).first();
      await target.click({ button: 'right' });
      await pageA.waitForSelector("[data-testid='message-menu']", { timeout: 3000 });
      await pageA.locator("[data-testid='message-menu-reply']").click();
      await pageA.waitForSelector("[data-testid='thread-panel']", { timeout: 5000 });
    }
    for (const text of ["beta: heel hook before the second bolt, then it's easy", 'and clip from the jug, not the sloper 😅']) {
      if (await tp.locator("[data-testid='message']", { hasText: text.slice(0, 20) }).count()) continue;
      await clearOverlays(pageA);
      await tp.locator("[data-testid='composer-input']").fill(text);
      await tp.locator("[data-testid='composer-send']").click({ timeout: 10000 });
      await pageA.waitForTimeout(700);
    }
    threadOpen = true;
  } catch (e) { console.log(`thread attempt ${attempt} failed:`, e.message.split('\n')[0].slice(0, 120)); }
}

if (threadOpen) await shoot(pageA, 'chat-thread.png');
// The desktop shot shows the feed alone, so the panel closes whatever happened above.
await pageA.locator("[data-testid='thread-panel-close']").click().catch(() => {});
await pageA.waitForTimeout(400);

await pageA.mouse.move(0, 0);
await pageA.waitForTimeout(300);
await shoot(pageA, 'chat-desktop.png');

// Mobile: B looks at the same channel.
await pageB.waitForTimeout(800);
await shoot(pageB, 'chat-mobile.png');

// 137: the phone's conversation list. User C becomes the second friend of user B
// and writes in a direct conversation. User A posts in the other channel.
// The list then shows two friend chips, a direct conversation row with its
// status dot, and an unread channel.
console.log('staging the phone list');
await pageC.locator("[data-testid='sidebar-add-friend']:visible").click();
await pageC.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageC.locator("[data-testid='friends-directory-row']")
  .filter({ has: pageC.getByText(`@${USER_B}`, { exact: true }) })
  .locator("[data-testid='friends-directory-add']").click();
await pageC.waitForTimeout(600);
await pageC.locator("[data-testid='friends-panel-close']").click();
await openDrawer(pageB);
await pageB.locator("[data-testid='zucker-add-friend']:visible").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await pageB.waitForTimeout(600);
await pageB.locator("[data-testid='friends-panel-close']").click();
await pageB.waitForTimeout(800);
await pageB.locator("[data-testid='zucker-friend-chip']", { hasText: USER_C }).first().click();
await pageB.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });
await send(pageB, 'still on for the market on saturday?');
await openDrawer(pageB);
await pageC.waitForTimeout(1500);
// On desktop, a friend row opens the direct conversation with that friend.
await pageC.locator("[data-testid='sidebar-friend-item']:visible", { hasText: USER_B }).first().click();
await pageC.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });
await send(pageC, 'yes! 9am at the fountain 🍓');
await ctxC.close();
await openChannel(pageA, 'gamenight');
await send(pageA, 'who has the expansion box?');
await pageB.waitForTimeout(2500);
await shoot(pageB, 'chat-mobile-list.png');

writeFileSync(OUT + 'credentials.txt',
  `base: ${BASE}\nuser A: ${USER_A}\nuser B: ${USER_B}\nuser C: ${USER_C}\npassword: ${PASSWORD}\n`);
console.log('done →', OUT);
await browser.close();

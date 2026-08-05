// 42-10: does the thread pane pick up replies that landed while the socket was
// down? The reported bug, from a phone: you see from outside that a thread has
// something new, open it, and the replies are not there.
//
// fetch_thread was gated on state.threadLoaded, which nothing ever cleared, so
// a thread's replies were fetched once per session and after that only grew by
// live pushes. Backgrounding a phone kills the socket, and replies landing in
// that window are neither pushed nor fetched -- the panel stays frozen while
// the feed's "N replies" line, refreshed by the reconnect history page, goes on
// naming a newer reply than the panel holds.
//
// Two cases, each on desktop and under iPhone 14 emulation:
//   A. thread CLOSED across the offline window, then reopened
//   B. thread left OPEN across the offline window
// plus the mismatch the report was actually about: the feed's summary preview
// naming a reply the pane does not contain.
//
// THE LEVER, and the reason this is a kept script rather than a scratch probe:
// `context.setOffline(true)` does NOT touch an established WebSocket. Pushes
// flow straight through it, so with setOffline the whole thing passes 8/8
// against the BUGGY build -- it never stages the failure at all. Proxying the
// socket with routeWebSocket, dropping the live one and refusing reconnects is
// what actually reproduces backgrounding a phone. Verified as a real regression
// test by restoring the old threadLoaded guard: 2/8 before the fix, 8/8 after.
//
// Run from the repo root:  node .claude/skills/run-chalk/thread-refresh.mjs
// Needs the dev stack up (see SKILL.md). Fresh handles every run.
import { chromium, devices } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const BASE = 'http://localhost:8443';
const OUT = '/tmp/chalk-threadrefresh/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';

const log = (...a) => appendFileSync(LOG, a.join(' ') + '\n');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

const RUN = Date.now() % 100000;
const PASSWORD = 'chalk Driver Passw0rd!!';

// ---- TOTP, cribbed from driver.mjs -----------------------------------
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
  log(`registered ${username}`);
}

const openDrawer = async (page) => {
  const t = page.locator("[data-testid='nav-toggle']");
  if (await t.isVisible().catch(() => false)) { await t.click(); await page.waitForTimeout(400); }
};

// Open the row menu and pick "reply", which opens the thread panel on that head.
async function replyInThread(page, bodyText, reply) {
  await page.locator("[data-testid='message-body']", { hasText: bodyText }).first()
    .click({ button: 'right' });
  await page.waitForSelector("[data-testid='message-menu']", { timeout: 5000 });
  await page.locator("[data-testid='message-menu-reply']").click();
  await page.waitForSelector("[data-testid='thread-panel']", { timeout: 8000 });
  const box = page.locator("[data-testid='thread-panel'] [data-testid='composer-input']");
  // click before fill: filling without focusing first loses the Enter.
  await box.click();
  await box.fill(reply);
  await page.waitForTimeout(300);
  await box.press('Enter');
  await page.waitForTimeout(1500);
  const sent = await page.locator("[data-testid='thread-panel-body'] [data-testid='message-body']").allInnerTexts();
  log(`  reply "${reply}" -> pane now: ${JSON.stringify(sent)}`);
  if (!sent.some((t) => t.includes(reply))) {
    await page.screenshot({ path: `${OUT}send-failed-${reply.replace(/\W+/g, '-')}.png` });
    throw new Error(`reply "${reply}" never appeared in the sender's own pane`);
  }
}

const paneBodies = (page) =>
  page.locator("[data-testid='thread-panel-body'] [data-testid='message-body']").allInnerTexts();

async function scenario(browser, mobile) {
  const tag = mobile ? 'mobile' : 'desktop';
  log(`\n===== ${tag} =====`);
  const userA = `pa${tag[0]}${RUN}`;
  const userB = `pb${tag[0]}${RUN}`;

  const ctxA = await browser.newContext({ ...(mobile ? devices['iPhone 14'] : {}), baseURL: BASE });
  const ctxB = await browser.newContext({ baseURL: BASE });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on('pageerror', (e) => log(`[A pageerror] ${e}`));

  // A real socket cut. context.setOffline() does NOT touch an established
  // WebSocket -- pushes keep flowing straight through it, so it cannot stage
  // this bug at all. Proxying the socket lets us drop the live one and refuse
  // the reconnects, which is what backgrounding a phone actually does.
  let wsBlocked = false;
  const liveSockets = new Set();
  await ctxA.routeWebSocket('**/ws', (ws) => {
    if (wsBlocked) { ws.close({ code: 1006 }); return; }
    ws.connectToServer();
    liveSockets.add(ws);
    ws.onClose(() => liveSockets.delete(ws));
  });
  const cutSocket = async () => {
    wsBlocked = true;
    for (const ws of [...liveSockets]) ws.close({ code: 1006 });
    await pageA.waitForTimeout(1500);
    log(`${tag} A ws after cut: ` +
      await pageA.locator("[data-testid='status-bar']").getAttribute('data-state'));
  };
  const restoreSocket = async () => {
    wsBlocked = false;
    await pageA.waitForFunction(
      () => document.querySelector("[data-testid='status-bar']")?.dataset.state === 'open',
      null, { timeout: 60000 },
    );
    log(`${tag} A ws restored`);
  };

  await register(pageA, userA);
  await register(pageB, userB);

  // Friend them, then A creates the channel (needs >=1 friend as member).
  await openDrawer(pageA);
  await pageA.locator("[data-testid='sidebar-add-friend']").click();
  await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
  await pageA.locator("[data-testid='friends-directory-row']", { hasText: userB })
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

  await openDrawer(pageA);
  await pageA.locator("[data-testid='sidebar-new']").click();
  await pageA.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await pageA.locator("[data-testid='create-modal-name']").fill(`thr-${tag}-${RUN}`);
  await pageA.locator("[data-testid='friend-picker-item']").first().click();
  await pageA.locator("[data-testid='create-modal-submit']").click();
  await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 15000 });

  const HEAD = 'thread head';
  await pageA.locator("[data-testid='composer-input']").first().fill(HEAD);
  await pageA.locator("[data-testid='composer-send']").first().click();
  await pageA.waitForSelector("[data-testid='message-body']", { timeout: 8000 });

  // B joins the channel view and starts the thread.
  await openDrawer(pageB);
  await pageB.locator("[data-testid='sidebar-item']", { hasText: `thr-${tag}-${RUN}` })
    .first().click();
  await pageB.waitForSelector("[data-testid='message-body']", { timeout: 15000 });
  await replyInThread(pageB, HEAD, 'reply one');
  await pageB.locator("[data-testid='thread-panel-close']").click();
  await pageA.waitForTimeout(1200);

  // A opens the thread once, sees reply one, closes it. This is what sets the
  // sticky loaded flag the bug lived on.
  await pageA.screenshot({ path: `${OUT}${tag}-before-first-open.png` });
  log(`${tag} A feed: ` + JSON.stringify(await pageA.locator("[data-testid='message-body']").allInnerTexts()));
  log(`${tag} A indicators: ` + await pageA.locator("[data-testid^='thread-indicator-']").count());
  await pageA.locator("[data-testid^='thread-indicator-']").first().click({ timeout: 15000 });
  await pageA.waitForSelector("[data-testid='thread-panel']", { timeout: 8000 });
  await pageA.waitForTimeout(1200);
  const first = await paneBodies(pageA);
  check(`${tag}: first open shows the existing reply`,
    first.some((t) => t.includes('reply one')), JSON.stringify(first));
  await pageA.locator("[data-testid='thread-panel-close']").click();
  await pageA.waitForTimeout(400);

  // ---- case A: closed across the offline window ----
  await cutSocket();
  await replyInThread(pageB, HEAD, 'offline reply two');
  await replyInThread(pageB, HEAD, 'offline reply three');
  await pageB.locator("[data-testid='thread-panel-close']").click();
  await restoreSocket();
  await pageA.waitForTimeout(3000); // let the reconnect's refetches land

  await pageA.locator("[data-testid^='thread-indicator-']").first().click();
  await pageA.waitForSelector("[data-testid='thread-panel']", { timeout: 8000 });
  await pageA.waitForTimeout(2500);
  const afterClosed = await paneBodies(pageA);
  check(`${tag}/closed: reopened thread has the replies missed offline`,
    afterClosed.some((t) => t.includes('offline reply two')) &&
    afterClosed.some((t) => t.includes('offline reply three')),
    JSON.stringify(afterClosed));
  await pageA.screenshot({ path: `${OUT}${tag}-closed-reopened.png` });

  // ---- case B: left open across the offline window ----
  await cutSocket();
  await replyInThread(pageB, HEAD, 'offline reply four');
  await pageB.locator("[data-testid='thread-panel-close']").click();
  await restoreSocket();
  await pageA.waitForTimeout(4000); // reconnect alone must refetch; no reopen

  const afterOpen = await paneBodies(pageA);
  check(`${tag}/open: a thread left open catches up on reconnect`,
    afterOpen.some((t) => t.includes('offline reply four')),
    JSON.stringify(afterOpen));
  await pageA.screenshot({ path: `${OUT}${tag}-open-reconnect.png` });

  // ---- the pane agrees with the feed's summary line ----
  await pageA.locator("[data-testid='thread-panel-close']").click();
  await pageA.waitForTimeout(800);
  const preview = await pageA.locator("[data-testid^='thread-preview-']").first()
    .innerText().catch(() => '(no preview)');
  const paneTail = afterOpen[afterOpen.length - 1] ?? '(empty)';
  check(`${tag}: feed preview names the pane's newest reply`,
    preview.includes(paneTail.trim()), `preview=${preview} paneTail=${paneTail}`);

  await ctxA.close();
  await ctxB.close();
}

// ---- main ------------------------------------------------------------
const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) {
  console.error(`chalkd not reachable at ${BASE} — start it first (see SKILL.md)`);
  process.exit(1);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  await scenario(browser, false);
  await scenario(browser, true);
} catch (e) {
  log(`THREW ${e.stack}`);
  check('probe ran to completion', false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
}

writeFileSync(OUT + 'summary.txt', results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n'));
console.log('\n--- 42-10 thread refresh ---');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`      ${r.detail.slice(0, 300)}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed. detail: ${LOG}`);
process.exit(failed ? 1 : 0);

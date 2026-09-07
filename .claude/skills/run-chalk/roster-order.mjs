// 114: roster order — does the real sidebar honour it? 14 checks.
//
// Registers two users, builds four channels across two groups, then asks the
// live DOM what the pure tests cannot: does the group header's menu open and
// move the group, does the channel menu's order row move a row, does a mouse
// drag reorder within a group and across into another (insertion line and
// all), does Escape cancel one, does the account-default picker reach the
// prefs, and does the whole order survive a reload — it is account state, so
// it must.
//
// Run from the repo root with the dev stack up (see SKILL.md):
//   node .claude/skills/run-chalk/roster-order.mjs
//
// Two findings worth keeping, both of which cost a run to learn:
//   * the 112 "add a picture?" nudge reappears after a reload and its modal
//     backdrop swallows every pointer event aimed at the sidebar. Dismiss it
//     or the drags silently hit the backdrop instead of a row.
//   * a drag needs the intermediate move: Playwright's mouse.move(steps: n)
//     is what pushes it past the 4px threshold. down() + one move() lands as
//     a click.
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const OUT = '/tmp/chalk-roster-order/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';
const log = (...a) => appendFileSync(LOG, a.join(' ') + '\n');

const BASE = 'http://localhost:8443';
const RUN = Date.now() % 100000;
const USER_A = `ord${RUN}`;
const USER_B = `mate${RUN}`;
const PASSWORD = 'chalk Driver Passw0rd!!';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

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
const ss = async (page, name) => {
  const file = `${OUT}${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log('screenshot', file);
};

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

async function makeChannel(page, name, group) {
  await page.locator("[data-testid='sidebar-new']").click();
  await page.waitForSelector("[data-testid='create-modal']", { timeout: 5000 });
  await page.locator("[data-testid='create-modal-name']").fill(name);
  const sel = page.locator("[data-testid='create-modal-group']");
  const options = await sel.locator('option').allTextContents();
  if (options.includes(group)) {
    await sel.selectOption(group);
  } else {
    await sel.selectOption({ index: options.length - 1 }); // "+ new group…"
    await page.locator("[data-testid='create-modal-group-new']").fill(group);
  }
  await page.locator("[data-testid='friend-picker-item']").first().click();
  await page.locator("[data-testid='create-modal-submit']").click();
  await page.waitForSelector("[data-testid='create-modal']", { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(700);
  log('created', name, 'in', group);
}

// The roster as rendered: group headers in order, each followed by its rows.
const roster = (page) => page.evaluate(() => {
  const ul = document.querySelector("[data-testid='sidebar-list'].chalk-sidebar-list--channels");
  if (!ul) return [];
  const out = [];
  for (const el of ul.querySelectorAll('[data-group],[data-channel-id]')) {
    const g = el.getAttribute('data-group');
    if (g !== null) out.push('#' + g);
    else if (el.getAttribute('data-hidden') !== 'true') {
      out.push(el.querySelector('.chalk-sidebar-item-name')?.textContent?.trim()
        ?? el.textContent.trim().split('\n')[0]);
    }
  }
  return out;
});

// A mouse drag, the way the pointer handlers expect it: down, a few moves
// past the threshold, up.
const recorder = () => {
  window.__ev = [];
  if (window.__recording) return;
  window.__recording = true;
  const d = (e) => {
    const t = e.target;
    return `${e.type}:${t?.getAttribute?.('data-channel-id')?.slice(0, 4) ?? t?.getAttribute?.('data-group') ?? t?.tagName ?? '?'}`;
  };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture',
    'lostpointercapture', 'click', 'dragstart', 'selectstart']) {
    document.addEventListener(type, (e) => window.__ev.push(d(e)), true);
  }
  let moves = 0;
  document.addEventListener('pointermove', (e) => {
    moves++;
    if (moves % 4 === 1) window.__ev.push(d(e) + '@' + Math.round(e.clientY));
  }, true);
};

async function dragRow(page, fromSel, toY, label = 'drag') {
  await page.evaluate(recorder);
  const box = await page.locator(fromSel).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  log(label, 'hit test', await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    const chain = [];
    for (let e = el; e && chain.length < 5; e = e.parentElement) {
      chain.push(`${e.tagName}.${e.className || ''}`.slice(0, 60));
    }
    return chain.join(' < ');
  }, [x, y]));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 6, { steps: 2 });
  await page.mouse.move(x, toY, { steps: 8 });
  await page.waitForTimeout(150);
  const line = await page.locator("[data-testid='sidebar-dropline']").count();
  const lineBox = line
    ? await page.locator("[data-testid='sidebar-dropline']").boundingBox()
    : null;
  const rows = await page.evaluate(() => {
    const ul = document.querySelector("[data-testid='sidebar-list'].chalk-sidebar-list--channels");
    return [...ul.querySelectorAll('[data-group],[data-channel-id]')].map((el) => ({
      what: el.getAttribute('data-group') ?? el.getAttribute('data-channel-id')?.slice(0, 6),
      name: el.textContent.trim().split('\n')[0].slice(0, 12),
      top: Math.round(el.getBoundingClientRect().top),
      bottom: Math.round(el.getBoundingClientRect().bottom),
    }));
  });
  log(label, 'pointer at y=' + toY, 'dropline=' + JSON.stringify(lineBox && Math.round(lineBox.y)),
    'rows=' + JSON.stringify(rows),
    'events=' + JSON.stringify(await page.evaluate(() => window.__ev)));
  await page.mouse.up();
  await page.waitForTimeout(700);
  return line;
}

const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) { console.error('chalkd not reachable'); process.exit(1); }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const errors = [];
pageA.on('pageerror', (e) => errors.push(String(e)));
pageA.on('console', (m) => log('console:', m.type(), m.text()));

await register(pageA, USER_A);
const ctxB = await browser.newContext({ baseURL: BASE });
const pageB = await ctxB.newPage();
await register(pageB, USER_B);

// friend them
await pageA.locator("[data-testid='sidebar-add-friend']").click();
await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageA.locator("[data-testid='friends-directory-row']", { hasText: USER_B })
  .locator("[data-testid='friends-directory-add']").click();
await pageA.waitForTimeout(600);
await pageA.locator("[data-testid='friends-panel-close']").click();
await pageB.locator("[data-testid='sidebar-add-friend']").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 5000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await pageB.waitForTimeout(600);
await pageB.locator("[data-testid='friends-panel-close']").click();

// Two groups, two channels each. Creation order is the roster's default
// order, newest first -- so "alpha" ends up last in its group.
await makeChannel(pageA, 'alpha', 'General');
await makeChannel(pageA, 'bravo', 'General');
await makeChannel(pageA, 'charlie', 'work');
await makeChannel(pageA, 'delta', 'work');
await pageA.waitForTimeout(500);
await ss(pageA, 'roster');

const base = await roster(pageA);
log('base roster', JSON.stringify(base));
check('roster renders two groups newest-first',
  JSON.stringify(base) === JSON.stringify(['#general', 'bravo', 'alpha', '#work', 'delta', 'charlie']),
  JSON.stringify(base));

// ---- the group header menu ------------------------------------------------
await pageA.locator("[data-testid='sidebar-group-header'][data-group='work']").click({ button: 'right' });
const menuOpen = await pageA.locator("[data-testid='group-menu']").isVisible().catch(() => false);
check('right-clicking a group header opens its menu', menuOpen);
await ss(pageA, 'group-menu');
if (menuOpen) {
  const sortOptions = await pageA.locator("[data-testid='group-menu-sort'] option").allTextContents();
  check('the sort picker offers three modes with the account default marked',
    sortOptions.length === 3 && sortOptions.some((o) => o.includes('(default)')),
    JSON.stringify(sortOptions));
  // move the group to the top
  await pageA.locator("[data-testid='group-menu-move-top']").click();
  await pageA.waitForTimeout(700);
}
const moved = await roster(pageA);
check('moving a group to the top reorders the roster',
  moved[0] === '#work', JSON.stringify(moved));

// ---- the channel menu's order row -----------------------------------------
await pageA.locator("body").click({ position: { x: 700, y: 500 } });
await pageA.waitForTimeout(200);
await pageA.locator("[data-testid='sidebar-item']", { hasText: 'alpha' }).first().click({ button: 'right' });
const chMenu = await pageA.locator("[data-testid='channel-menu']").isVisible().catch(() => false);
const orderRow = await pageA.locator("[data-testid='channel-menu-move-top']").count();
check('the channel menu carries an order row', chMenu && orderRow === 1);
await ss(pageA, 'channel-menu');
if (orderRow) {
  await pageA.locator("[data-testid='channel-menu-move-top']").click();
  await pageA.waitForTimeout(700);
}
const afterMove = await roster(pageA);
check('"to top" puts the channel first in its group',
  afterMove.indexOf('alpha') === afterMove.indexOf('#general') + 1, JSON.stringify(afterMove));

// the group is manual now, so the menu offers the way back
await pageA.locator("body").click({ position: { x: 700, y: 500 } });
await pageA.waitForTimeout(200);
await pageA.locator("[data-testid='sidebar-item']", { hasText: 'alpha' }).first().click({ button: 'right' });
const resetSeen = await pageA.locator("[data-testid='channel-menu-order-reset']").count();
check('a hand-ordered group offers a reset', resetSeen === 1);
await pageA.locator("body").click({ position: { x: 700, y: 500 } });
await pageA.waitForTimeout(200);

// ---- the order survives a reload ------------------------------------------
await pageA.reload();
await pageA.waitForSelector("[data-testid='sidebar-list']", { timeout: 30000 });
await pageA.waitForTimeout(3500);
// 112: the "add a picture?" nudge shows up after a reload and its backdrop
// covers the sidebar -- dismiss it or every pointer test hits the backdrop.
const nudge = pageA.locator("[data-testid='avatar-nudge-later']");
if (await nudge.isVisible().catch(() => false)) {
  await nudge.click();
  await pageA.waitForTimeout(500);
}
log('modal after reload', await pageA.evaluate(() => {
  const m = document.querySelector('.chalk-modal-backdrop');
  return m ? (m.getAttribute('data-testid') ?? m.className) + ' :: ' + m.textContent.slice(0, 120) : 'none';
}));
const reloaded = await roster(pageA);
check('the order comes back on reload (it is account prefs)',
  JSON.stringify(reloaded) === JSON.stringify(afterMove), JSON.stringify(reloaded));

// ---- drag within a group ---------------------------------------------------
// work is first; drag "charlie" above "delta".
const deltaBox = await pageA.locator("[data-testid='sidebar-item']", { hasText: 'delta' }).first().boundingBox();
const lineSeen = await dragRow(
  pageA,
  "[data-testid='sidebar-item']:has-text('charlie')",
  deltaBox.y + 2,
  'drag-within',
);
check('a drag shows an insertion line', lineSeen === 1);
const dragged = await roster(pageA);
check('dragging a row within its group reorders it',
  dragged.indexOf('charlie') < dragged.indexOf('delta'), JSON.stringify(dragged));
await ss(pageA, 'after-drag');

// ---- drag across into the other group -------------------------------------
const generalHeader = await pageA.locator("[data-testid='sidebar-group-header'][data-group='general']").boundingBox();
await dragRow(pageA, "[data-testid='sidebar-item']:has-text('charlie')", generalHeader.y + generalHeader.height + 4, 'drag-cross');
const crossed = await roster(pageA);
const gi = crossed.indexOf('#general');
const inGeneral = crossed.slice(gi + 1);
check('dragging a row across moves it into the other group',
  inGeneral.includes('charlie') && crossed.indexOf('charlie') > gi, JSON.stringify(crossed));
await ss(pageA, 'after-cross-drag');

// ---- escape cancels --------------------------------------------------------
const before = await roster(pageA);
const box = await pageA.locator("[data-testid='sidebar-item']", { hasText: 'alpha' }).first().boundingBox();
await pageA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await pageA.mouse.down();
await pageA.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 6 });
await pageA.keyboard.press('Escape');
await pageA.mouse.up();
await pageA.waitForTimeout(500);
const after = await roster(pageA);
check('Escape cancels a drag with nothing moved',
  JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

// ---- the account default in settings ---------------------------------------
await pageA.locator("[data-testid='status-user-menu-trigger']").click();
await pageA.waitForTimeout(300);
await pageA.locator("[data-testid='status-user-menu-profile']").click();
await pageA.waitForTimeout(800);
await pageA.locator("[data-testid='profile-tab-chat']").click();
await pageA.waitForTimeout(400);
await pageA.locator("[data-testid='roster-settings']").scrollIntoViewIfNeeded().catch(() => {});
await pageA.waitForTimeout(200);
const sortSetting = await pageA.locator("[data-testid='roster-channel-sort']").count();
const sortValues = sortSetting
  ? await pageA.locator("[data-testid='roster-channel-sort'] option").allTextContents()
  : [];
check('settings carries the account-wide sort picker', sortSetting === 1, JSON.stringify(sortValues));
if (sortSetting) {
  // Flipping it to activity must reach the roster: General is untouched by
  // the drags above, so its two channels re-sort by their last message.
  await pageA.locator("[data-testid='roster-channel-sort']").selectOption('activity');
  await pageA.waitForTimeout(800);
  const settingBack = await pageA.locator("[data-testid='roster-channel-sort']").inputValue();
  check('the account default sticks', settingBack === 'activity', settingBack);
}
await ss(pageA, 'settings');

writeFileSync(OUT + 'credentials.txt', `base: ${BASE}\nuser: ${USER_A}\nuser B: ${USER_B}\npassword: ${PASSWORD}\n`);
log('page errors', JSON.stringify(errors));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '));
console.log('output in', OUT);
await browser.close();

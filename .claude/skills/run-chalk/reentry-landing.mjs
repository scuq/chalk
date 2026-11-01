// reentry-landing -- regression cover for the second visit to a conversation.
//
// This is the 79-10 repro, kept because the node suite cannot hold it: the bug
// is a scroll write that the browser applies late, and web/test.mjs has no
// browser. The pure rule is tested in chat/history-paging.test.ts.
//
// MessageList unmounts on the way to the Zuckermode list screen, so every
// entry is a fresh mount. On a second visit the rows are already in state, so
// the landing write runs in the mount commit, in the same frame as the
// list-to-feed content swap.
//
// What it reproduces, on an iPhone 14 viewport in zucker mode:
//   - five steps: open a direct message, swipe back, open a group, swipe back,
//     open the same direct message again
//   - two steps: open the same direct message twice, with no group between
//
// What it records, one timeline per entry: the tap, the feed mounts, the
// websocket frames, every write to the scroller offset, the scroll events, the
// frame gaps, the long tasks, and the offset sampled over 3 s.
//
// PASS = every entry ends at the bottom.
//
// What Chromium showed: the landing write runs 10 ms after the mount with the
// right target, but the scroller reads offset zero for the next 10 ms to
// 200 ms, and then the offset jumps to the bottom. Chromium applied the write
// late. Before the fix, 5 of 5 entries ended at the bottom, so this probe
// shows the window and not the wrong position. The proof for WebKit is the
// phone: run both sequences on the iPhone.
//
// Run from the repo root:  node .claude/skills/run-chalk/reentry-landing.mjs
// Output: /tmp/chalk-probe/ (screenshots, probe.log, report.json)
import { chromium, devices } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const BASE = process.env.CHALK_BASE || 'http://localhost:8443';
const OUT = '/tmp/chalk-probe/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';
writeFileSync(LOG, '');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const say = (...a) => { console.log(...a); log(...a); };

const RUN = Date.now() % 100000;
const USER_A = `lprobe${RUN}`;
const USER_B = `lpeer${RUN}`;
const PASSWORD = 'chalk Driver Passw0rd!!';
const GROUP = 'grp' + RUN;

// ---- TOTP -------------------------------------------------------------
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

// ---- PNG generator ----------------------------------------------------
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = ~0; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePNG(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = (x + seed) % 256; raw[p + 1] = (y * 2 + seed) % 256; raw[p + 2] = (seed * 37) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const imgFile = (name, w, h, seed) => { const p = OUT + name; writeFileSync(p, makePNG(w, h, seed)); return p; };

// ---- registration -----------------------------------------------------
async function register(page, username) {
  await page.goto('/');
  await page.waitForSelector("[data-testid='password-login']", { timeout: 20000 });
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
  await page.waitForSelector("[data-state='open']", { timeout: 40000 });
  const whatsNew = page.locator("[data-testid='whats-new-dismiss']");
  if (await whatsNew.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) await whatsNew.click();
  await page.waitForTimeout(1000);
  say(`  registered ${username}`);
}
const dismissNudge = async (page, wait = 2500) => {
  const later = page.locator("[data-testid='avatar-nudge-later']");
  if (await later.waitFor({ timeout: wait }).then(() => true).catch(() => false)) { await later.click(); await page.waitForTimeout(300); }
};
// The nudge can come back at any time; a quick look before every pointer action.
const clearNudge = async (page) => {
  const later = page.locator("[data-testid='avatar-nudge-later']");
  if (await later.isVisible().catch(() => false)) { await later.click(); await page.waitForTimeout(300); }
};
const dismissWhatsNew = async (page, wait = 4000) => {
  const w = page.locator("[data-testid='whats-new-dismiss']");
  if (await w.waitFor({ timeout: wait }).then(() => true).catch(() => false)) { await w.click(); await page.waitForTimeout(300); }
};

// ---- in-page instrumentation ------------------------------------------
// One timeline in window.__ev, page clock. Installed before every reload.
const INSTRUMENT = () => {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  window.__ev = [];
  const push = (e) => { window.__ev.push({ t: now(), ...e }); };
  window.__mark = (ev) => push({ ev });
  const rowsNow = () => document.querySelectorAll('[data-message-id]').length;
  const isMain = (el) => !!(el && el.classList && el.classList.contains('chalk-main'));
  const stackOf = () => (new Error().stack || '').split('\n').slice(3, 7)
    .map((s) => s.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//g, '')).join(' < ');
  const rec = (kind, el, value, extra) => {
    if (!isMain(el)) return;
    push({ ev: kind, value, extra, before: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, rows: rowsNow(), stack: stackOf() });
  };
  const origScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    const o = args.length && typeof args[0] === 'object' ? args[0] : { top: args[1] };
    rec('scrollTo', this, Math.round(o.top ?? NaN), o.behavior ?? 'auto');
    return origScrollTo.apply(this, args);
  };
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true, enumerable: desc.enumerable, get: desc.get,
    set(v) { rec('scrollTop=', this, Math.round(v), null); return desc.set.call(this, v); },
  });
  const origSIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    const sc = this.closest && this.closest('.chalk-main');
    if (sc) rec('scrollIntoView', sc, -1, JSON.stringify(a[0] ?? null));
    return origSIV.apply(this, a);
  };
  document.addEventListener('scroll', (e) => {
    if (!isMain(e.target)) return;
    push({ ev: 'scroll-event', value: Math.round(e.target.scrollTop), sh: e.target.scrollHeight, ch: e.target.clientHeight, rows: rowsNow() });
  }, true);
  // Feed mounts and unmounts. The observer hangs on document itself: an init
  // script runs before <html> exists.
  const feedIn = (n) => n.nodeType === 1 && (n.matches('[data-testid="messages"]') || !!n.querySelector('[data-testid="messages"]'));
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (feedIn(n)) push({ ev: 'feed-mounted', rows: rowsNow() });
      for (const n of m.removedNodes) if (feedIn(n)) push({ ev: 'feed-unmounted' });
    }
  }).observe(document, { childList: true, subtree: true });
  // Frames: a gap over 40 ms is a stall of the rendering pipeline, which is
  // what defers every effect that waits for the next frame.
  let lastFrame = performance.now(), frames = 0;
  const tick = (ts) => {
    requestAnimationFrame(tick);
    frames++;
    if (ts - lastFrame > 40) push({ ev: 'frame-gap', ms: Math.round(ts - lastFrame), frames });
    lastFrame = ts;
  };
  requestAnimationFrame(tick);
  // Websocket frames by type: when the history fetch goes out and comes back.
  const WS = window.WebSocket;
  const origSend = WS.prototype.send;
  WS.prototype.send = function (data) {
    try { const f = JSON.parse(data); if (/history|mark_read/.test(f.type ?? '')) push({ ev: 'ws-send', type: f.type, rows: rowsNow() }); } catch {}
    return origSend.call(this, data);
  };
  const onIn = (e) => {
    try {
      const f = JSON.parse(e.data);
      if (/history|mark_read|key/.test(f.type ?? '')) push({ ev: 'ws-recv', type: f.type, n: Array.isArray(f.payload?.messages) ? f.payload.messages.length : undefined, rows: rowsNow() });
    } catch {}
  };
  const od = Object.getOwnPropertyDescriptor(WS.prototype, 'onmessage');
  Object.defineProperty(WS.prototype, 'onmessage', {
    configurable: true, get: od.get,
    set(fn) { return od.set.call(this, function (e) { onIn(e); return fn && fn.call(this, e); }); },
  });
  const origAEL = WS.prototype.addEventListener;
  WS.prototype.addEventListener = function (type, fn, ...rest) {
    if (type === 'message') { const wrapped = function (e) { onIn(e); return fn.call(this, e); }; return origAEL.call(this, type, wrapped, ...rest); }
    return origAEL.call(this, type, fn, ...rest);
  };
  try {
    new PerformanceObserver((list) => { for (const en of list.getEntries()) push({ ev: 'long-task', ms: Math.round(en.duration) }); }).observe({ type: 'longtask', buffered: true });
  } catch {}
};
const RESET = () => { window.__ev = []; };
const SNAPSHOT = () => {
  const sc = document.querySelector('.chalk-main');
  const root = document.querySelector('[data-testid="messages"]');
  if (!sc || !root) return { error: 'no feed', rows: 0 };
  const rows = Array.from(root.querySelectorAll('[data-message-id]'));
  const r = sc.getBoundingClientRect();
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : null);
  let topRow = null;
  for (const el of rows) { if (el.getBoundingClientRect().bottom > r.top + 60) { topRow = el; break; } }
  const last = rows[rows.length - 1] || null;
  const lr = last ? last.getBoundingClientRect() : null;
  return {
    rows: rows.length,
    scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight,
    fromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
    newestVisible: !!(lr && lr.top < r.bottom && lr.bottom > r.top),
    divider: !!root.querySelector('[data-testid="unread-divider"]'),
    topRow: txt(topRow), newest: txt(last),
  };
};

let shot = 0;
const ss = async (page, name) => {
  const f = `${OUT}${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f }).catch(() => {});
  log('  screenshot: ' + f);
};

// ---- sending ----------------------------------------------------------
async function sendText(page, body) {
  await clearNudge(page);
  await page.locator("[data-testid='composer-input']").fill(body);
  await page.locator("[data-testid='composer-send']").click();
  await page.waitForTimeout(180);
}
async function sendImages(page, files, caption) {
  await clearNudge(page);
  await page.locator("[data-testid='composer-file-input']").setInputFiles(files);
  await page.waitForSelector("[data-testid='composer-chip']", { timeout: 15000 });
  if (caption) await page.locator("[data-testid='composer-input']").fill(caption);
  await page.waitForFunction(() => !document.querySelector("[data-testid='composer-chip-progress']"), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator("[data-testid='composer-send']").click();
  await page.waitForFunction(() => !document.querySelector("[data-testid='composer-chip']"), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(600);
}

// ---- touch ------------------------------------------------------------
async function touchDrag(cdp, from, to, steps = 12, stepMs = 14) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await new Promise((r) => setTimeout(r, stepMs));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// ---- main -------------------------------------------------------------
const report = { run: RUN, users: { a: USER_A, b: USER_B }, entries: [] };
process.on('uncaughtException', (e) => {
  log('FATAL: ' + (e?.stack ?? e));
  try { writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 2)); } catch {}
  console.error('probe failed: ' + (e?.message ?? e) + ` (partial results in ${OUT})`);
  process.exit(1);
});

const res = await fetch(BASE + '/api/auth/config').catch(() => null);
if (!res?.ok) { console.error('chalkd not reachable at ' + BASE); process.exit(1); }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({ ...devices['iPhone 14'], baseURL: BASE });
const ctxB = await browser.newContext({ baseURL: BASE, viewport: { width: 1400, height: 950 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
pageA.on('pageerror', (e) => log('pageerror(A): ' + e));
pageA.on('console', (m) => { if (m.type() === 'error') log('console(A): ' + m.text()); });

say(`registering ${USER_A} (iPhone 14) and ${USER_B} (desktop)`);
await register(pageA, USER_A);
await register(pageB, USER_B);

say('friending');
await dismissNudge(pageA, 3000);
await pageA.locator("[data-testid='nav-toggle']").click();
await pageA.waitForTimeout(400);
await pageA.locator("[data-testid='sidebar-add-friend']").click();
await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 8000 });
await pageA.locator("[data-testid='friends-directory-row']", { hasText: USER_B }).locator("[data-testid='friends-directory-add']").click();
await pageA.waitForTimeout(700);
await pageA.locator("[data-testid='friends-panel-close']").click();
await dismissNudge(pageB, 3000);
await pageB.locator("[data-testid='sidebar-add-friend']").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 8000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 10000 });
await pageB.waitForTimeout(700);
await pageB.locator("[data-testid='friends-panel-close']").click();

say('enabling zuckermode on the phone');
await pageA.locator("[data-testid='status-user-menu-trigger']").click();
await pageA.waitForTimeout(300);
await pageA.locator("[data-testid='status-user-menu-profile']").click();
await pageA.waitForSelector("[data-testid='profile-panel']", { timeout: 8000 });
await pageA.locator("[data-testid='profile-tab-chat']").click();
await pageA.waitForTimeout(300);
await pageA.locator("[data-testid='roster-zuckermode']").check();
await pageA.waitForTimeout(600);
await pageA.locator("[data-testid='profile-panel-close']").click();
await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 15000 });
await pageA.waitForTimeout(500);

const cdpA = await ctxA.newCDPSession(pageA);
const vp = pageA.viewportSize();
const MIDY = Math.round(vp.height * 0.55);

async function backToList() {
  await clearNudge(pageA);
  for (let attempt = 0; attempt < 2; attempt++) {
    await touchDrag(cdpA, { x: 70, y: MIDY }, { x: 320, y: MIDY + 8 });
    try {
      await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 4000 });
      await pageA.waitForTimeout(500);
      return 'swipe';
    } catch { log('  ! swipe did not navigate, retrying'); }
  }
  await pageA.locator("[data-testid='zucker-back']").click();
  await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 8000 });
  await pageA.waitForTimeout(500);
  return 'button';
}
async function openDM() {
  await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 15000 });
  await clearNudge(pageA);
  const friendRow = pageA.locator("[data-testid='zucker-friend']", { hasText: USER_B });
  if (!(await friendRow.isVisible().catch(() => false))) {
    await pageA.locator("[data-testid='zucker-friends']").tap();
    await pageA.waitForTimeout(400);
  }
  await friendRow.first().tap();
  await pageA.waitForSelector("[data-testid='messages'], [data-testid='composer-input']", { timeout: 20000 });
}
async function openRow(name) {
  await pageA.waitForSelector("[data-testid='zucker-row']", { timeout: 15000 });
  await clearNudge(pageA);
  await pageA.locator("[data-testid='zucker-row']", { hasText: name }).first().tap();
  await pageA.waitForSelector("[data-testid='messages'], [data-testid='composer-input']", { timeout: 20000 });
}

// ---- seeding ----------------------------------------------------------
const IMGS = [imgFile('img-a.png', 900, 1200, 11), imgFile('img-b.png', 1200, 700, 47)];
say('seeding the direct message (60 short rows)');
await openDM();
await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
await pageA.waitForTimeout(800);
for (let n = 1; n <= 60; n++) await sendText(pageA, `dm ${n}: short line`);
await backToList();

say(`seeding group ${GROUP} (with two images)`);
await pageA.locator("[data-testid='zucker-new-channel']").tap();
await pageA.waitForSelector("[data-testid='create-modal']", { timeout: 8000 });
await pageA.locator("[data-testid='create-modal-name']").fill(GROUP);
await pageA.locator("[data-testid='friend-picker-item']").first().click();
await pageA.locator("[data-testid='create-modal-submit']").click();
// On the zucker list a new group does not open by itself: wait for its row,
// then enter it like a reader would.
await pageA.waitForTimeout(1500);
if (!(await pageA.locator("[data-testid='composer-input']").isVisible().catch(() => false))) {
  await pageA.waitForSelector(`[data-testid='zucker-row']:has-text("${GROUP}")`, { timeout: 20000 });
  await openRow(GROUP);
}
await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
await pageA.waitForTimeout(800);
for (let n = 1; n <= 20; n++) await sendText(pageA, `${GROUP} ${n}: backlog line`);
await sendImages(pageA, [IMGS[0]], `${GROUP}: picture one`);
for (let n = 21; n <= 36; n++) await sendText(pageA, `${GROUP} ${n}: backlog line`);
await sendImages(pageA, [IMGS[1]], `${GROUP}: picture two`);
for (let n = 37; n <= 40; n++) await sendText(pageA, `${GROUP} ${n}: backlog line`);
await backToList();
say('  seeded');

// ---- the measured entries --------------------------------------------
async function freshStart() {
  await pageA.addInitScript(INSTRUMENT);
  await pageA.reload();
  await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 40000 });
  await dismissWhatsNew(pageA, 3000);
  await dismissNudge(pageA, 2000);
  await pageA.waitForTimeout(1500);
}

async function enter(label, open) {
  await pageA.evaluate(RESET);
  await pageA.evaluate(() => window.__mark('tap'));
  const t0 = Date.now();
  await open();
  const samples = [];
  for (const at of [0, 50, 100, 200, 300, 500, 700, 1000, 1500, 2000, 3000]) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await pageA.waitForTimeout(wait);
    samples.push({ at, ...(await pageA.evaluate(SNAPSHOT)), pt: await pageA.evaluate(() => Math.round(performance.now())) });
  }
  const ev = await pageA.evaluate(() => window.__ev);
  const end = samples[samples.length - 1];
  const firstAtBottom = samples.find((s) => s.rows > 0 && s.fromBottom <= 40);
  const firstWithRows = samples.find((s) => s.rows > 0);
  const ok = end.newestVisible && end.fromBottom <= 40;
  say(`${ok ? 'OK  ' : 'BAD '} ${label}: fromBottom=${end.fromBottom} rows=${end.rows} rowsAt=${firstWithRows?.at}ms bottomAt=${firstAtBottom?.at}ms divider=${end.divider}`);
  log(`--- samples [${label}]`);
  for (const s of samples) log(`  at=${String(s.at).padStart(5)} pt=${s.pt} top=${s.scrollTop} sh=${s.scrollHeight} ch=${s.clientHeight} fb=${s.fromBottom} rows=${s.rows} newestVisible=${s.newestVisible} topRow="${s.topRow}"`);
  log(`--- events [${label}] (${ev.length})`);
  for (const e of ev) log('  ' + JSON.stringify(e));
  await ss(pageA, label.replace(/[^a-z0-9]+/gi, '-'));
  report.entries.push({ label, ok, samples, ev });
  return ok;
}

say('');
say('=== sequence 1: DM, back, group with images, back, DM ===');
await freshStart();
await enter('s1 DM first', openDM);
log('back: ' + (await backToList()));
await enter('s1 group first', () => openRow(GROUP));
log('back: ' + (await backToList()));
await enter('s1 DM second', openDM);

say('=== sequence 2: DM, back, DM ===');
await freshStart();
await enter('s2 DM first', openDM);
log('back: ' + (await backToList()));
await enter('s2 DM second', openDM);

writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 2));
writeFileSync(OUT + 'credentials.txt', `user: ${USER_A}\nuser B: ${USER_B}\npassword: ${PASSWORD}\n`);
const bad = report.entries.filter((e) => !e.ok).length;
say('');
say(`${report.entries.length - bad}/${report.entries.length} entries landed at the bottom. log: ${LOG}`);
await browser.close();
process.exit(bad ? 1 : 0);

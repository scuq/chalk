// unread-landing -- regression cover for where opening a channel puts the view.
//
// This is the 79-2 repro, kept because the node suite cannot hold it: the bug
// is a DOM measurement that changes value between two frames, and web/test.mjs
// has no DOM. The pure halves of the rule are tested in
// chat/history-paging.test.ts; this is the half that needs a real browser, a
// real attachment decrypt and a real phone-shaped viewport.
//
// scuq's original repro, step for step:
//   6 channels, mixed text + images
//   enter channel 1 (image a few messages back, only slightly visible)
//   swipe back
//   enter channel 2, scroll
//   swipe back
//   enter channel 1 again  ->  "jumped back where the image started"
//
// MessageList unmounts on the way to the Zuckermode list screen (ZuckerList
// replaces the whole conversation branch in App.tsx), so every entry runs the
// landing afresh. Before 79-2 the landing chose "newest message" while the
// unread run's photo was still a "decrypting…" strip, then the held anchor
// re-judged the now-taller run and dragged the reader up to the divider.
//
// What makes it show up, and why each piece is here:
//   - the unread run is short (photo + 2 lines), so it fits the screen while
//     the photo is a strip and does not once it isn't -- that flip IS the bug
//   - the peer sends it while the phone is on the list screen, so a divider is
//     actually in front of the landing
//   - attachment GETs are held back 2.5s and the link is throttled, because on
//     loopback the photo decrypts before the landing ever runs
//
// PASS = all three entries settle with the newest message visible
// (fromBottom <= 40px). A "BAD" line with the divider at ~63px and the picture
// filling the screen is 79-2 back again.
//
// Run from the repo root:  node .claude/skills/run-chalk/unread-landing.mjs
// Output: /tmp/chalk-probe/ (screenshots + probe.log + report.json)

import { chromium, devices } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

const BASE = 'http://localhost:8443';
const OUT = '/tmp/chalk-probe/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const LOG = OUT + 'probe.log';
writeFileSync(LOG, '');

const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  appendFileSync(LOG, line + '\n');
};
const say = (...a) => { console.log(...a); log(...a); };

const RUN = Date.now() % 100000;
const USER_A = `zprobe${RUN}`;   // the phone
const USER_B = `zpeer${RUN}`;    // needed only so channels can be created
const PASSWORD = 'chalk Driver Passw0rd!!';

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

// ---- PNG generator (real images, real heights) ------------------------
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
    raw[off] = 0;
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
const imgFile = (name, w, h, seed) => {
  const p = OUT + name;
  writeFileSync(p, makePNG(w, h, seed));
  return p;
};

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
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='recovery-continue']").disabled,
    null, { timeout: 20000 });
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
  await page.waitForTimeout(1200);
  say(`  registered ${username}`);
}

// ---- the in-page measurement ------------------------------------------
const SNAPSHOT = () => {
  const root = document.querySelector('[data-testid="messages"]');
  if (!root) return { error: 'no feed mounted' };
  let sc = root.parentElement;
  while (sc) {
    const oy = getComputedStyle(sc).overflowY;
    if (oy === 'auto' || oy === 'scroll') break;
    sc = sc.parentElement;
  }
  if (!sc) return { error: 'no scroller' };
  const r = sc.getBoundingClientRect();
  const rows = Array.from(root.querySelectorAll('[data-message-id]'));
  const last = rows[rows.length - 1] || null;
  const lastRect = last ? last.getBoundingClientRect() : null;
  const div = root.querySelector('[data-testid="unread-divider"]');
  const dRect = div ? div.getBoundingClientRect() : null;
  let hdrH = 0;
  for (const child of Array.from(sc.children)) {
    if (getComputedStyle(child).position !== 'sticky') continue;
    hdrH = Math.max(hdrH, child.getBoundingClientRect().height);
  }
  let topRow = null;
  for (const el of rows) {
    const b = el.getBoundingClientRect();
    if (b.bottom > r.top + hdrH + 2) { topRow = el; break; }
  }
  const txt = (el) => {
    if (!el) return null;
    const b = el.querySelector('[data-testid="message-body"]');
    return (b ? b.textContent : el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  };
  // Where each rendered attachment image sits relative to the scrollport --
  // the whole question is whether the view ends up parked on one of them.
  const images = Array.from(root.querySelectorAll('[data-testid="attachment-img"]')).map((i) => {
    const b = i.getBoundingClientRect();
    return { top: Math.round(b.top - r.top), h: Math.round(b.height) };
  });
  return {
    rows: rows.length,
    scrollTop: Math.round(sc.scrollTop),
    scrollHeight: Math.round(sc.scrollHeight),
    clientHeight: Math.round(sc.clientHeight),
    distanceFromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
    newestVisible: !!(lastRect && lastRect.top < r.bottom && lastRect.bottom > r.top),
    newestText: txt(last),
    topRowText: txt(topRow),
    divider: !!div,
    dividerOffsetFromTop: dRect ? Math.round(dRect.top - r.top) : null,
    headerHeight: Math.round(hdrH),
    // 76-3's test, measured live: the unread run only earns a scroll once it
    // is taller than the screen, and an undecrypted attachment makes it look
    // far shorter than it will be.
    unreadRunPx: dRect && lastRect ? Math.round(lastRect.bottom - dRect.top) : null,
    unreadRunFits: dRect && lastRect
      ? Math.round(lastRect.bottom - dRect.top) + 48 <= Math.round(sc.clientHeight)
      : null,
    images,
    imagesPending: root.querySelectorAll('[data-testid="attachment-loading"],[data-testid="attachment-img-placeholder"]').length,
    header: document.querySelector('.chalk-channel-header-name')?.textContent ?? null,
  };
};

// A scroll listener beats sampling: a jump that happens and is corrected
// between two evaluate() calls is exactly the thing being hunted, and polling
// would miss it. Re-installed after every reload.
// A per-frame recorder, not a scroll listener: the question is whether the
// landing goes to the newest message and is then yanked back up, or never
// goes there at all, and consecutive programmatic scrolls in one frame
// coalesce into a single scroll event that cannot tell those apart.
const TRACE = () => {
  window.__trace = [];
  const t0 = performance.now();
  let prev = '';
  const tick = () => {
    requestAnimationFrame(tick);
    const root = document.querySelector('[data-testid="messages"]');
    if (!root) { prev = ''; return; }
    let sc = root.parentElement;
    while (sc && !['auto', 'scroll'].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    if (!sc) return;
    const div = root.querySelector('[data-testid="unread-divider"]');
    const rows = root.querySelectorAll('[data-message-id]');
    const last = rows[rows.length - 1];
    const r = sc.getBoundingClientRect();
    const run = div && last
      ? Math.round(last.getBoundingClientRect().bottom - div.getBoundingClientRect().top)
      : null;
    const s = {
      top: Math.round(sc.scrollTop),
      h: Math.round(sc.scrollHeight),
      fb: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
      run,
      divTop: div ? Math.round(div.getBoundingClientRect().top - r.top) : null,
      pend: root.querySelectorAll('[data-testid="attachment-loading"],[data-testid="attachment-img-placeholder"]').length,
      img: root.querySelectorAll('[data-testid="attachment-img"]').length,
    };
    const key = JSON.stringify(s);
    if (key === prev) return;
    prev = key;
    window.__trace.push({ t: Math.round(performance.now() - t0), ...s });
    if (window.__trace.length > 6000) window.__trace.shift();
  };
  requestAnimationFrame(tick);
};

let shot = 0;
const ss = async (page, name) => {
  const f = `${OUT}${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f });
  log('  screenshot: ' + f);
};

// ---- sending ----------------------------------------------------------
async function sendText(page, body) {
  await page.locator("[data-testid='composer-input']").fill(body);
  await page.locator("[data-testid='composer-send']").click();
  await page.waitForTimeout(250);
}

async function sendImages(page, files, caption) {
  await page.locator("[data-testid='composer-file-input']").setInputFiles(files);
  await page.waitForSelector("[data-testid='composer-chip']", { timeout: 15000 });
  if (caption) await page.locator("[data-testid='composer-input']").fill(caption);
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='composer-chip-progress']"),
    null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator("[data-testid='composer-send']").click();
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='composer-chip']"),
    null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(600);
}

// ---- touch (playwright's touchscreen only taps) -----------------------
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

async function settle(page, label, ms = 9000, step = 300) {
  await page.evaluate(() => { window.__trace = []; });
  const series = [];
  for (let t = 0; t <= ms; t += step) {
    series.push({ t, ...(await page.evaluate(SNAPSHOT)) });
    await page.waitForTimeout(step);
  }
  const trace = await page.evaluate(() => window.__trace ?? []);
  log(`--- settle series [${label}]`);
  for (const s of series) {
    log(`  t=${String(s.t).padStart(5)} top=${String(s.scrollTop).padStart(6)} ` +
      `h=${String(s.scrollHeight).padStart(6)} fromBottom=${String(s.distanceFromBottom).padStart(6)} ` +
      `rows=${s.rows} pending=${s.imagesPending} imgs=${JSON.stringify(s.images)} ` +
      `newestVisible=${s.newestVisible} divider=${s.divider}@${s.dividerOffsetFromTop} ` +
      `run=${s.unreadRunPx}px fits=${s.unreadRunFits} top="${s.topRowText}"`);
  }
  log(`--- scroll trace [${label}] (${trace.length} events)`);
  for (const e of trace) log('  ' + JSON.stringify(e));
  return Object.assign(series, { trace });
}

// ---- main -------------------------------------------------------------
const report = { run: RUN, users: { a: USER_A, b: USER_B }, phases: [] };
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
const errorsA = [];
pageA.on('pageerror', (e) => { errorsA.push(String(e)); log('pageerror(A): ' + e); });
pageA.on('console', (m) => { if (m.type() === 'error') log('console(A): ' + m.text()); });

say(`registering ${USER_A} (iPhone 14) and ${USER_B} (desktop)`);
await register(pageA, USER_A);
await register(pageB, USER_B);

say('friending');
await pageA.locator("[data-testid='nav-toggle']").click();
await pageA.waitForTimeout(400);
await pageA.locator("[data-testid='sidebar-add-friend']").click();
await pageA.waitForSelector("[data-testid='friends-panel']", { timeout: 8000 });
await pageA.locator("[data-testid='friends-directory-row']", { hasText: USER_B })
  .locator("[data-testid='friends-directory-add']").click();
await pageA.waitForTimeout(700);
await pageA.locator("[data-testid='friends-panel-close']").click();

await pageB.locator("[data-testid='sidebar-add-friend']").click();
await pageB.waitForSelector("[data-testid='friends-panel']", { timeout: 8000 });
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 10000 });
await pageB.waitForTimeout(700);
await pageB.locator("[data-testid='friends-panel-close']").click();

// ---- 6 channels, mixed text + images ----------------------------------
// The phone creates them and lays down read history; the PEER then sends the
// tail, so each channel has a short unread run whose last few messages are an
// image plus a couple of lines -- scuq's "image a few messages back, just
// slightly visible".
const IMGS = [
  imgFile('img-a.png', 900, 1200, 11),
  imgFile('img-b.png', 1200, 700, 47),
  imgFile('img-c.png', 800, 800, 91),
];
const CHANNELS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const LOREM =
  'the quick brown fox jumps over the lazy dog while the phone sits in a ' +
  'pocket and the scroll position quietly goes somewhere nobody asked for. ';

for (const [i, name] of CHANNELS.entries()) {
  say(`seeding channel ${name}`);
  await pageA.locator("[data-testid='nav-toggle']").click();
  await pageA.waitForTimeout(400);
  await pageA.locator("[data-testid='sidebar-new']").click();
  await pageA.waitForSelector("[data-testid='create-modal']", { timeout: 8000 });
  await pageA.locator("[data-testid='create-modal-name']").fill(name);
  await pageA.locator("[data-testid='friend-picker-item']").first().click();
  await pageA.locator("[data-testid='create-modal-submit']").click();
  await pageA.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await pageA.waitForTimeout(800);

  // A real backlog: several screens of scrollback with images scattered
  // through it, so the feed is long enough for history paging and for late
  // image growth to have somewhere to strand the view.
  for (let n = 1; n <= 12; n++) {
    await sendText(pageA, n % 4 === 0 ? `${name} ${n}: ${LOREM}${LOREM}` : `${name} ${n}: backlog line`);
  }
  await sendImages(pageA, [IMGS[i % IMGS.length]], `${name}: early picture`);
  for (let n = 13; n <= 22; n++) {
    await sendText(pageA, n % 5 === 0 ? `${name} ${n}: ${LOREM}` : `${name} ${n}: backlog line`);
  }
  await sendImages(pageA, [IMGS[(i + 1) % IMGS.length]], `${name}: middle picture`);
  for (let n = 23; n <= 30; n++) await sendText(pageA, `${name} ${n}: backlog line`);
}
say('  read history seeded');

// ---- Zuckermode -------------------------------------------------------
say('enabling zuckermode');
await pageA.locator("[data-testid='status-user-menu-trigger']").click();
await pageA.waitForTimeout(300);
await pageA.locator("[data-testid='status-user-menu-profile']").click();
await pageA.waitForSelector("[data-testid='profile-panel']", { timeout: 8000 });
await pageA.locator("[data-testid='profile-tab-chat']").click();
await pageA.waitForTimeout(300);
await pageA.locator("[data-testid='roster-zuckermode']").check();
await pageA.waitForTimeout(600);
await pageA.locator("[data-testid='profile-panel-close']").click();
await pageA.waitForTimeout(600);

// Reload: start from the list screen with a warm IndexedDB cache, which is
// the state the phone is actually in when scuq hits this.
await pageA.addInitScript(TRACE);
await pageA.reload();
await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 40000 });
await pageA.waitForTimeout(3000);
await ss(pageA, 'zucker-list');

// ---- the peer sends the unread tail, phone sitting on the list --------
// A short run: the image plus a few lines. Short enough that while the
// attachment is still a one-line "decrypting…" strip the run FITS the screen
// (so the landing goes to the newest message), and tall enough that once the
// image decrypts into its real box it does not.
say('peer sends the unread tail into every channel');
for (const [i, name] of CHANNELS.entries()) {
  await pageB.locator("[data-testid='sidebar-item']", { hasText: name }).first().click();
  await pageB.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await pageB.waitForTimeout(700);
  await sendImages(pageB, [IMGS[(i + 2) % IMGS.length]], `${name}: THE picture`);
  await sendText(pageB, `${name}: right after the picture`);
  await sendText(pageB, `${name}: another line`);
  await sendText(pageB, `${name}: one more line`);
  await sendText(pageB, `${name}: last message`);
}
await pageA.waitForTimeout(2500);
await ss(pageA, 'zucker-list-with-unread');

const cdpA = await ctxA.newCDPSession(pageA);
const vp = pageA.viewportSize();

// A phone on cellular. This is not decoration: the whole question is what the
// landing measures while the attachments are still one-line "decrypting…"
// strips, and on a loopback server they resolve before the first sample.
await cdpA.send('Network.enable');
await cdpA.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 150,
  downloadThroughput: (400 * 1024) / 8,
  uploadThroughput: (400 * 1024) / 8,
});
say('network throttled to ~400kbit/150ms');
const MIDY = Math.round(vp.height * 0.55);

async function openRow(name) {
  await pageA.waitForSelector("[data-testid='zucker-row']", { timeout: 15000 });
  await pageA.locator("[data-testid='zucker-row']", { hasText: name }).first().tap();
  await pageA.waitForSelector("[data-testid='messages']", { timeout: 20000 });
}

// Rightward, horizontally dominant, well past the trigger.
async function swipeBack() {
  for (let attempt = 0; attempt < 2; attempt++) {
    await touchDrag(cdpA, { x: 70, y: MIDY }, { x: 320, y: MIDY + 8 });
    try {
      await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 5000 });
      await pageA.waitForTimeout(600);
      return;
    } catch { log('  ! swipe did not navigate, retrying'); }
  }
  // The gesture is not what this probe is measuring; the header button does
  // the same navigation, so a missed swipe must not cost the run.
  await pageA.locator("[data-testid='zucker-back']").click();
  await pageA.waitForSelector("[data-testid='zucker-list']", { timeout: 8000 });
  await pageA.waitForTimeout(600);
  log('  ! fell back to the zucker-back button');
}

say('');
say('--- step 1: enter alpha ---');
await openRow('alpha');
const s1 = await settle(pageA, 'alpha, first entry', 12000, 100);
await ss(pageA, 'alpha-first-entry');
report.phases.push({ name: 'alpha-first-entry', series: s1 });

say('--- step 2: swipe back to the list ---');
await swipeBack();
await ss(pageA, 'list-after-swipe-1');

say('--- step 3: enter bravo and scroll ---');
await openRow('bravo');
await pageA.waitForTimeout(3000);
// Drag the content down (finger down = scroll up through history), then part
// of the way back. A finger, not scrollTop: touchstart is what releases the
// landing anchor, and the bug report involves a channel that was scrolled.
await touchDrag(cdpA, { x: Math.round(vp.width / 2), y: 260 }, { x: Math.round(vp.width / 2), y: 620 }, 14, 16);
await pageA.waitForTimeout(800);
await touchDrag(cdpA, { x: Math.round(vp.width / 2), y: 560 }, { x: Math.round(vp.width / 2), y: 300 }, 14, 16);
await pageA.waitForTimeout(1200);
const sB = await pageA.evaluate(SNAPSHOT);
log('bravo after scrolling: ' + JSON.stringify(sB));
report.phases.push({ name: 'bravo-after-scroll', snap: sB });
await ss(pageA, 'bravo-after-scroll');

say('--- step 4: swipe back ---');
await swipeBack();
await ss(pageA, 'list-after-swipe-2');

// A phone with six live channels has new messages waiting when it comes back,
// so alpha gets a fresh short run while the reader is off in bravo. This is
// what puts a divider in front of the re-entry landing.
say('--- step 4b: peer tops alpha up while the phone is away ---');
await pageB.locator("[data-testid='sidebar-item']", { hasText: 'alpha' }).first().click();
await pageB.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
await pageB.waitForTimeout(700);
await sendImages(pageB, [IMGS[0]], 'alpha: fresh picture');
await sendText(pageB, 'alpha: fresh line one');
await sendText(pageB, 'alpha: fresh line two');
await pageA.waitForTimeout(2000);

// Hold the ciphertext back so the attachment is still a one-line
// "decrypting…" strip when the landing measures the unread run -- the state a
// phone is genuinely in, and the one the loopback server never reproduces.
await ctxA.route('**/api/attachments/**', async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});
say('  attachment fetches delayed by 2.5s');

say('--- step 5: re-enter alpha ---');
await openRow('alpha');
const s2 = await settle(pageA, 'alpha, re-entry', 12000, 100);
await ss(pageA, 'alpha-re-entry');
report.phases.push({ name: 'alpha-re-entry', series: s2 });

// One more round trip, to see whether it compounds.
say('--- step 6: swipe back, enter charlie, swipe back, re-enter alpha ---');
await swipeBack();
await openRow('charlie');
await pageA.waitForTimeout(3000);
await swipeBack();
await openRow('alpha');
const s3 = await settle(pageA, 'alpha, third entry', 12000, 100);
await ss(pageA, 'alpha-third-entry');
report.phases.push({ name: 'alpha-third-entry', series: s3 });

// ---- summary ----------------------------------------------------------
report.pageErrors = errorsA.slice(0, 10);
writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 2));

const verdict = (name, series) => {
  const end = series[series.length - 1];
  const first = series.find((s) => s.rows && !s.imagesPending) ?? series[1] ?? series[0];
  const ok = end.newestVisible && end.distanceFromBottom <= 40;
  return `${ok ? 'OK  ' : 'BAD '} ${name}: fromBottom=${String(end.distanceFromBottom).padStart(5)}px ` +
    `(settled from ${first.distanceFromBottom}px) newestVisible=${end.newestVisible} ` +
    `divider=${end.divider}@${end.dividerOffsetFromTop} run=${end.unreadRunPx}px fits=${end.unreadRunFits} ` +
    `imgs=${JSON.stringify(end.images)} topRow="${end.topRowText}" newest="${end.newestText}"`;
};

say('');
say('================ SUMMARY ================');
say(verdict('alpha 1st entry', s1));
say(verdict('alpha re-entry ', s2));
say(verdict('alpha 3rd entry', s3));
say('');
say(`output in ${OUT} (probe.log has the settle series, report.json the raw snapshots)`);
writeFileSync(OUT + 'credentials.txt', `user: ${USER_A}\nuser B: ${USER_B}\npassword: ${PASSWORD}\n`);
await browser.close();

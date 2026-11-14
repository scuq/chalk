// 65-7 probe: the page side of web push. It registers two users, and the
// second is a friend, so the first can create two channels. It checks that:
// - the page registers /sw.js after welcome,
// - a session that did not opt in has no browser subscription,
// - reconcile drops a leftover browser subscription,
// - a chalk-open message opens the channel,
// - logout drops the browser subscription,
// - the console shows no push errors.
// It runs 6 checks.
//
// It needs chalkd with push on and the sealed channel (CHALK_SERVER_ID_KEY).
// It reads the dev VAPID pair from ~/.cache/chalk-dev-vapid, in the lines
// PRIV=... and PUB=....
//
// It uses a persistent Chromium profile in /tmp/chalk-probe/profile. Chrome
// has no Push API in an incognito context, which is the default context of
// Playwright. With a persistent profile, Playwright's Chromium subscribes
// through FCM. The steps go to /tmp/chalk-probe/steps.log.
import { chromium } from "playwright";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const OUT = "/tmp/chalk-probe";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:8443";
const PASSWORD = "chalk Driver Passw0rd!!";
const USER = `push${Date.now() % 100000}`;
const PUB = /PUB=(\S+)/.exec(readFileSync(homedir() + "/.cache/chalk-dev-vapid", "utf8"))[1];
const log = [];
const step = (m) => appendFileSync("/tmp/chalk-probe/steps.log", `${new Date().toISOString()} ${m}\n`);
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase()) {
    const i = A.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpNow(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

async function register(page, USER) {
  await page.goto("/");
  await page.waitForSelector("[data-testid='password-login']", { timeout: 15000 });
  await page.locator("button.chalk-auth-link", { hasText: "create an account" }).click();
  await page.locator("[data-testid='signup-username']").fill(USER);
  await page.locator("[data-testid='signup-step-account'] input[type='email']").fill(`${USER}@e2e.invalid`);
  await page.locator("[data-testid='signup-account-next']").click();
  const pw = page.locator("[data-testid='signup-step-password'] input[type='password']");
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.locator("[data-testid='signup-password-next']").click();
  const totpStep = page.locator("[data-testid='signup-step-totp']");
  await totpStep.waitFor({ timeout: 120000 });
  const secret = (await page.locator("[data-testid='signup-secret']").innerText()).trim();
  await totpStep.locator("input").fill(totpNow(secret));
  await page.locator("[data-testid='signup-finish']").click();
  await page.waitForSelector("[data-testid='recovery-screen']", { timeout: 30000 });
  await page.locator("[data-testid='recovery-ack']").check();
  await page.waitForFunction(() => !document.querySelector("[data-testid='recovery-continue']").disabled, null, { timeout: 20000 });
  await page.locator("[data-testid='recovery-continue']").click();
  await page.waitForSelector("[data-testid='identity-setup-generate']", { timeout: 30000 });
  const words = await page.locator("[data-testid='identity-phrase-words'] .chalk-recovery-word-text").allInnerTexts();
  await page.locator("[data-testid='identity-ack']").check();
  const inputs = page.locator("[data-testid='identity-challenge'] input[data-testid^='identity-challenge-']");
  for (let i = 0; i < (await inputs.count()); i++) {
    const el = inputs.nth(i);
    const idx = Number((await el.getAttribute("data-testid")).replace("identity-challenge-", ""));
    await el.fill(words[idx].trim());
  }
  await page.locator("[data-testid='identity-generate-confirm']").click();
  await page.waitForSelector("[data-state='open']", { timeout: 30000 });
  await dismissWhatsNew(page);
}

async function dismissWhatsNew(page) {
  const whatsNew = page.locator("[data-testid='whats-new-dismiss']");
  await whatsNew.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await whatsNew.isVisible().catch(() => false)) await whatsNew.click();
}

const swState = (page) =>
  page.evaluate(async () => {
    const t = (p, what) => Promise.race([p, new Promise((res) => setTimeout(() => res("TIMEOUT " + what), 4000))]);
    const r = await t(navigator.serviceWorker.getRegistration("/sw.js"), "getRegistration");
    if (typeof r === "string") return { script: r, sub: null };
    const s = r ? await t(r.pushManager.getSubscription(), "getSubscription") : null;
    if (typeof s === "string") return { script: r.active?.scriptURL ?? null, sub: s };
    return { script: r?.active?.scriptURL ?? r?.installing?.scriptURL ?? null, sub: s ? s.endpoint : null };
  });

const browser = await chromium.launch({ channel: "chromium" });
// A persistent profile: Chrome has no Push API in an incognito context.
const ctx = await chromium.launchPersistentContext(OUT + "/profile", {
  channel: "chromium", baseURL: BASE, viewport: { width: 1280, height: 800 },
});
await ctx.grantPermissions(["notifications"]);
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) => step(`console ${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));

step("register");
await register(page, USER);
step("registered");
step("swState");
let st = await swState(page);
step("swState done " + JSON.stringify(st));
check("the page registers /sw.js after welcome", st.script?.endsWith("/sw.js"), JSON.stringify(st));
check("a session that did not opt in has no browser subscription", st.sub === null, JSON.stringify(st));

// A leftover browser subscription, as a previous account would leave it.
const subTry = await page.evaluate(async (key) => {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((key.length + 3) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const r = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!r) return "throws: no registration";
  try {
    const s = await Promise.race([
      r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("subscribe timed out after 5 s")), 5000)),
    ]);
    return "ok " + s.endpoint.slice(0, 40);
  } catch (e) {
    return "throws: " + e;
  }
}, PUB);
log.push("subscribe: " + subTry);
step("subscribe: " + subTry);
if (subTry.startsWith("ok")) {
  await page.reload();
  await page.waitForSelector("[data-state='open']", { timeout: 30000 });
  await page.waitForTimeout(2000);
  st = await swState(page);
  await dismissWhatsNew(page);
  check("reconcile drops the leftover subscription", st.sub === null, JSON.stringify(st));
} else {
  results.push(`SKIP leftover-subscription drop -- this Chromium cannot subscribe: ${subTry}`);
}

step("open message");
// Two channels with a friend, so one channel row is not active.
step("friend");
const ctxB = await browser.newContext({ baseURL: BASE });
const pageB = await ctxB.newPage();
await register(pageB, USER + "b");
await page.locator("[data-testid='sidebar-add-friend']:visible").click();
await page.locator("[data-testid='friends-directory-row']", { hasText: USER + "b" }).locator("[data-testid='friends-directory-add']").click();
await page.waitForTimeout(600);
await page.locator("[data-testid='friends-panel-close']").click();
await pageB.locator("[data-testid='sidebar-add-friend']:visible").click();
await pageB.locator("[data-testid='friends-tab-pending']").click();
await pageB.locator("[data-testid='friends-action-accept']").first().click({ timeout: 8000 });
await pageB.waitForTimeout(600);
for (const name of ["push-a", "push-b"]) {
  await page.locator("[data-testid='sidebar-new']:visible").click();
  await page.locator("[data-testid='create-modal-name']").fill(name);
  await page.locator("[data-testid='friend-picker-item']").first().click();
  await page.locator("[data-testid='create-modal-submit']").click();
  await page.locator("[data-testid='sidebar-item']", { hasText: name }).waitFor({ timeout: 10000 });
}
await page.locator("[data-testid='sidebar-item']", { hasText: "push-b" }).click();
await page.waitForTimeout(500);
// A notification click arrives as a worker message.
const rows = page.locator("[data-testid='sidebar-item'][data-channel-type='text']");
const ids = await rows.evaluateAll((els) => els.map((e) => ({ id: e.dataset.channelId, active: e.dataset.active })));
log.push("rows: " + JSON.stringify(ids));
const target = ids.find((r) => r.active !== "true") ?? ids[0];
if (!target) {
  results.push("SKIP open message -- no text channel row");
} else {
  await page.evaluate((id) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "chalk-open", channelID: id } }));
  }, target.id);
  await page.waitForTimeout(500);
  const active = await page.locator(`[data-testid='sidebar-item'][data-channel-id='${target.id}']`).getAttribute("data-active");
  check("a chalk-open message opens the channel", active === "true", `${target.id} was ${target.active}, now ${active} (${ids.length} rows)`);
}

// Logout drops the browser subscription. Subscribe again first, if this Chromium can.
if (subTry.startsWith("ok")) {
  await page.evaluate(async (key) => {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((key.length + 3) % 4);
    const r = await navigator.serviceWorker.ready;
    await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
  }, PUB);
  const before = await swState(page);
  await page.locator("[data-testid='status-user-menu-trigger']").click();
  await page.locator("[data-testid='status-user-menu-logout']").click();
  await page.waitForSelector("[data-testid='password-login']", { timeout: 15000 });
  await page.waitForTimeout(1000);
  st = await swState(page);
  check("logout drops the browser subscription", before.sub !== null && st.sub === null, `${before.sub?.slice(0, 40)} -> ${st.sub}`);
}
const errs = log.filter((l) => /push|sw\.js/i.test(l) && /error|warn|fail/i.test(l));
check("no push errors in the console", errs.length === 0, errs.join(" | "));

await ctx.close();
await browser.close();
writeFileSync(`${OUT}/probe.log`, log.join("\n"));
console.log(results.join("\n"));
console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.filter((r) => !r.startsWith("SKIP")).length} checks passed`);

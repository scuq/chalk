// 65-6: the service worker against a running dev stack. The probe registers
// /sw.js, delivers pushes through CDP (ServiceWorker.deliverPushMessage),
// and reads the notifications that the worker showed. It needs no login,
// because the worker belongs to the origin and not to a session.
//
// It needs the full Chromium build (channel "chromium"). The default
// headless shell has no notification permission, so showNotification
// throws there. The probe does not cover the click path (notificationclick),
// because CDP cannot click a notification. 11 checks.
//
//   node .claude/skills/run-chalk/sw-push.mjs
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = "/tmp/chalk-probe";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:8443";
const log = [];
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
};

const browser = await chromium.launch({ channel: "chromium" });
const ctx = await browser.newContext();
await ctx.grantPermissions(["notifications"]);
const page = await ctx.newPage();
page.on("console", (m) => log.push(`console: ${m.text()}`));
await page.goto(BASE + "/");

const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return { scope: r.scope, active: !!r.active, script: r.active?.scriptURL };
});
check("worker registers and activates", reg.active && reg.scope.endsWith("/"), JSON.stringify(reg));

const cdp = await ctx.newCDPSession(page);
let regId = null;
cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
  for (const r of e.registrations) if (r.scopeURL.startsWith(BASE)) regId = r.registrationId;
});
await cdp.send("ServiceWorker.enable");
for (let i = 0; i < 50 && !regId; i++) await page.waitForTimeout(100);
check("CDP sees the registration", !!regId, String(regId));

const perm = await page.evaluate(() => Notification.permission);
check("notification permission is granted", perm === "granted", perm);
const deliver = async (data) => {
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: BASE, registrationId: regId, data });
  await page.waitForTimeout(500);
};
const notes = () =>
  page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const ns = await r.getNotifications();
    return ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, data: n.data }));
  });

await deliver(JSON.stringify({ v: 1, kind: "message", channel_id: "c1", message_id: "m1",
  sender_handle: "alice", channel_name: "general", is_dm: false, unread: 2 }));
let ns = await notes();
const ch = ns.find((n) => n.tag === "chalk-ch-c1");
check("channel push shows a notification", ch && ch.title === "@alice in #general" && ch.body === "New message",
  JSON.stringify(ns));
check("notification uses the hashed icon", ch && /\/icons\/icon-192-[A-F0-9]+\.png$/.test(ch.icon), ch?.icon);
check("notification carries the open target", ch && ch.data?.channelID === "c1", JSON.stringify(ch?.data));

await deliver(JSON.stringify({ v: 1, kind: "message", channel_id: "c1", message_id: "m2",
  sender_handle: "bob", channel_name: "general", is_dm: false, unread: 3 }));
ns = await notes();
check("a second push for the channel replaces the first", ns.filter((n) => n.tag === "chalk-ch-c1").length === 1 &&
  ns.find((n) => n.tag === "chalk-ch-c1").title === "@bob in #general", JSON.stringify(ns));

await deliver("not json at all");
ns = await notes();
check("an unreadable push still shows a notification", ns.some((n) => n.tag === "chalk-push" && n.title === "chalk"),
  JSON.stringify(ns));

await deliver(JSON.stringify({ v: 1, kind: "message", channel_id: "d1", message_id: "m3",
  sender_handle: "carol", is_dm: true, thread_id: "t9", unread: 1 }));
ns = await notes();
check("a DM thread reply uses the thread tag and the sender title",
  ns.some((n) => n.tag === "chalk-th-t9" && n.title === "@carol" && n.body === "New reply in a thread"), JSON.stringify(ns));

// The worker has no fetch handler, so the page still loads from the network.
const resp = await page.reload();
check("page still loads with the worker installed", resp && resp.status() === 200, String(resp?.status()));
const fetchHandled = await page.evaluate(async () => {
  const r = await fetch("/api/auth/config", { cache: "no-store" });
  return r.status;
});
check("fetches go to the server", fetchHandled === 200, String(fetchHandled));

await browser.close();
writeFileSync(`${OUT}/probe.log`, log.join("\n"));
console.log(results.join("\n"));
console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} checks passed`);

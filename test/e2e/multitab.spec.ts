// chalk phase 09a step 5 Playwright spec.
//
// Proves the multi-tab hub change end-to-end in a real browser.
// Phase 09a step 4 removed the same-deviceID eviction: two browser
// tabs sharing localStorage (and therefore the same chalk.deviceId)
// no longer evict each other on Register. Step 3's connID-keyed
// echo-suppression means each tab's send reaches the OTHER tab but
// not itself.
//
// What we verify in the browser:
//   1. Two tabs from the same context both reach state=open
//   2. A message sent from tab A appears in tab A (via the SPA's
//      optimistic-append) and ALSO appears in tab B (via server
//      fan-out)
//   3. The reverse: a message from tab B appears in tab B and tab A
//   4. Tab A does NOT see its own message duplicated (would happen
//      if the server failed to suppress its echo)
//   5. Tab B does NOT see its own message duplicated
//
// We use two pages in ONE BrowserContext so localStorage is shared
// (== same chalk.deviceId). This is the multi-tab scenario; in
// channels.spec.ts the two pages are in DIFFERENT contexts and
// represent different users.

import { test, expect, type Page } from "@playwright/test";

const ALICE_DEVICE = "11111111-1111-1111-1111-111111111111";

const HTTP_1 = process.env.CHALK_TEST_HTTP_1 ?? "http://127.0.0.1:38679";

// loadInTab navigates an existing page to the SPA and waits for the
// WebSocket to reach state=open (i.e., the hello/welcome handshake
// is complete and the connection is registered on the hub).
async function loadInTab(page: Page, baseURL: string, deviceID: string) {
  await page.addInitScript((dev) => {
    window.localStorage.setItem("chalk.deviceId", dev);
  }, deviceID);
  await page.goto(baseURL + "/");
  // Wait for WS open. data-state on the status bar.
  await expect(page.locator("[data-testid='status-bar']")).toHaveAttribute(
    "data-state",
    "open",
    { timeout: 10_000 },
  );
  // The user_id slice shows up once the welcome lands.
  await expect(page.locator("[data-testid='status-user']")).toBeVisible();
}

// countMessagesContaining returns how many rendered message bodies
// contain the given substring. Used to detect echo duplication
// (count should be exactly 1 per send per tab).
async function countMessagesContaining(page: Page, phrase: string): Promise<number> {
  return page
    .locator("[data-testid='message-body']", { hasText: phrase })
    .count();
}

test.describe("chalk phase 09a multi-tab", () => {
  test("two tabs same device: messages cross between tabs without echo dupes", async ({
    browser,
  }) => {
    // ONE context: localStorage shared, so both tabs auto-pick up
    // the same chalk.deviceId on first load. This is the scenario
    // that was broken before phase 09a step 4: opening the SPA in
    // a second tab evicted the first.
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    await loadInTab(tabA, HTTP_1, ALICE_DEVICE);
    await loadInTab(tabB, HTTP_1, ALICE_DEVICE);

    // Sanity: both tabs report alice as the connected user. Phase
    // 08c renders status-user as "you (<handle>)" once the welcome
    // frame's handle field is processed; alice's handle is "alice".
    for (const tab of [tabA, tabB]) {
      await expect(tab.locator("[data-testid='status-user']")).toHaveText(
        "you (alice)",
      );
    }

    // Both tabs should still be open. Before step 4, opening tabB
    // would have evicted tabA (closed its WS, dropped its state to
    // "closed" or "reconnecting"). Assert tabA is still open after
    // tabB has fully connected.
    await expect(tabA.locator("[data-testid='status-bar']")).toHaveAttribute(
      "data-state",
      "open",
    );

    // ---- Round 1: tabA sends, both tabs render it once. -----------
    const phraseA = "from-tab-a-" + Date.now();
    await tabA.locator("[data-testid='composer-input']").fill(phraseA);
    await tabA.locator("[data-testid='composer-send']").click();

    // tabA renders the message via optimistic-append (the SPA dispatches
    // a local message_dispatched action with a locally-generated id
    // before the WS frame goes out; the server then suppresses the
    // echo back to tabA's conn).
    await expect(
      tabA.locator("[data-testid='message-body']", { hasText: phraseA }),
    ).toBeVisible({ timeout: 5_000 });

    // tabB renders the message via the server's fan-out (it's NOT
    // suppressed for tabB because its connID is different from tabA's).
    await expect(
      tabB.locator("[data-testid='message-body']", { hasText: phraseA }),
    ).toBeVisible({ timeout: 5_000 });

    // Crucial echo-suppression check: tabA must show phraseA EXACTLY
    // ONCE. If the server failed to suppress the echo, tabA would
    // render the message twice (once via optimistic-append, once via
    // the wire). Step 3's connID suppression is what prevents this.
    // Give the wire a moment to arrive before asserting -- otherwise
    // we'd be racing the network.
    await tabA.waitForTimeout(500);
    const tabACountA = await countMessagesContaining(tabA, phraseA);
    expect(tabACountA, "tabA rendered its own send N times").toBe(1);

    // tabB should also show phraseA exactly once.
    const tabBCountA = await countMessagesContaining(tabB, phraseA);
    expect(tabBCountA, "tabB rendered the message from tabA N times").toBe(1);

    // ---- Round 2: tabB sends, both tabs render it once. -----------
    const phraseB = "from-tab-b-" + Date.now();
    await tabB.locator("[data-testid='composer-input']").fill(phraseB);
    await tabB.locator("[data-testid='composer-send']").click();

    await expect(
      tabB.locator("[data-testid='message-body']", { hasText: phraseB }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      tabA.locator("[data-testid='message-body']", { hasText: phraseB }),
    ).toBeVisible({ timeout: 5_000 });

    await tabB.waitForTimeout(500);
    const tabBCountB = await countMessagesContaining(tabB, phraseB);
    expect(tabBCountB, "tabB rendered its own send N times").toBe(1);

    const tabACountB = await countMessagesContaining(tabA, phraseB);
    expect(tabACountB, "tabA rendered the message from tabB N times").toBe(1);

    // ---- Final sanity: both tabs still open. ----------------------
    for (const tab of [tabA, tabB]) {
      await expect(tab.locator("[data-testid='status-bar']")).toHaveAttribute(
        "data-state",
        "open",
      );
    }

    await ctx.close();
  });
});

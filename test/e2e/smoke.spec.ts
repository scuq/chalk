// chalk phase 07 -- smoke spec
//
// Verifies the end-to-end shell:
//   1. The SPA loads at /
//   2. It opens a WebSocket to /ws and reaches state=open after the
//      hello/welcome exchange
//   3. The user can send a message via the composer
//   4. That message arrives back over the WebSocket and renders in
//      the message list
//
// This is the only spec phase 07 ships. Phase 13 will add the full
// cross-browser matrix and richer scenarios (multi-tab, reconnect,
// presence, etc.).
//
// Assumes chalkd is running and the SPA is served at CHALK_BASE_URL
// (set by the phase-07 bootstrap script after server_up_n).

import { test, expect } from "@playwright/test";

test.describe("chalk phase 07 shell", () => {
  test("loads SPA, connects WS, sends and receives a message", async ({ page }) => {
    // Page loads.
    await page.goto("/");
    await expect(page).toHaveTitle(/chalk/);

    // The root mounts.
    const root = page.locator("[data-testid='root']");
    await expect(root).toBeVisible();

    // Status bar appears.
    const statusBar = page.locator("[data-testid='status-bar']");
    await expect(statusBar).toBeVisible();

    // Wait for the connection to open. The status bar's data-state
    // attribute reflects ConnectionState.
    await expect(statusBar).toHaveAttribute("data-state", "open", { timeout: 10_000 });

    // The user_id slice shows up once we're connected.
    const userBadge = page.locator("[data-testid='status-user']");
    await expect(userBadge).toBeVisible();

    // Empty state initially.
    const messages = page.locator("[data-testid='messages']");
    await expect(messages).toBeVisible();
    const initialCount = await page.locator("[data-testid='message']").count();
    // It may be 0 in a fresh DB, or non-zero if the test runs against
    // a re-used environment; both are fine.

    // Type and send.
    const composer = page.locator("[data-testid='composer-input']");
    const sendBtn = page.locator("[data-testid='composer-send']");
    const phrase = `hello from phase 07 at ${Date.now()}`;
    await composer.fill(phrase);
    await sendBtn.click();

    // The send round-trips: server inserts + NOTIFYs + fan-out arrives
    // at our own connection. The message appears in the list.
    const messageBody = page.locator("[data-testid='message-body']", { hasText: phrase });
    await expect(messageBody).toBeVisible({ timeout: 5_000 });

    // The list now has at least one more message than before.
    const finalCount = await page.locator("[data-testid='message']").count();
    expect(finalCount).toBeGreaterThan(initialCount);
  });
});

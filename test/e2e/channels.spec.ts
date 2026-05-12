// chalk phase 08b Playwright spec.
//
// Two scenarios:
//
//   1) Single-tab: alice loads the SPA, sees the empty channel list,
//      opens the create modal, picks bob, submits, sees the new
//      channel selected and the message pane usable.
//
//   2) Multi-tab cross-instance: alice on chalkd #1 creates a channel
//      with bob. Bob's tab on chalkd #2 receives the channel_event,
//      automatically sends subscribe_channel, then alice sends a
//      message and bob's tab renders it. No reload.
//
// The chalkd instances and PG are spun up by the bootstrap script;
// this spec just dials the URLs from env.
//
// Each tab acts as a different user via the localStorage device_id
// trick: we pre-write a device_id known to belong to bob/carol BEFORE
// the page loads (page.addInitScript), so the ws-client picks up
// that device_id on first dial.

import { test, expect, type Page } from "@playwright/test";

// Fixed UUIDs from the bootstrap fixtures.
const ALICE_USER = "00000000-0000-0000-0000-00000000a11c";
const BOB_USER = "00000000-0000-0000-0000-000000000b0b";

const ALICE_DEVICE = "11111111-1111-1111-1111-111111111111";
const BOB_DEVICE = "22222222-2222-2222-2222-222222222222";

const HTTP_1 = process.env.CHALK_TEST_HTTP_1 ?? "http://127.0.0.1:38679";
const HTTP_2 = process.env.CHALK_TEST_HTTP_2 ?? HTTP_1;

async function loadAs(page: Page, baseURL: string, deviceID: string) {
  await page.addInitScript((dev) => {
    window.localStorage.setItem("chalk.deviceId", dev);
  }, deviceID);
  await page.goto(baseURL + "/");
  // Wait for WS to open and welcome to land.
  await expect(page.locator("[data-state='open']")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[data-testid='status-user']")).toBeVisible();
}

test.describe("chalk phase 08b channels SPA", () => {
  test("alice creates channel, message round-trips to bob on a different instance", async ({
    browser,
  }) => {
    // Two independent browser contexts -- own cookies, own localStorage,
    // own state. Treat them like two different users on two different
    // machines.
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    await loadAs(alice, HTTP_1, ALICE_DEVICE);
    await loadAs(bob, HTTP_2, BOB_DEVICE);

    // Sanity: both show their user UUID prefix in the status badge.
    // alice's user is 00000000..a11c -> prefix "00000000"
    await expect(alice.locator("[data-testid='status-user']")).toHaveText(
      ALICE_USER.slice(0, 8)
    );
    await expect(bob.locator("[data-testid='status-user']")).toHaveText(
      BOB_USER.slice(0, 8)
    );

    // Alice clicks the "+" to create a channel.
    await alice.locator("[data-testid='sidebar-new']").click();
    await expect(alice.locator("[data-testid='create-modal']")).toBeVisible();

    // Wait for friend list to populate (or "no friends" hint).
    // The bootstrap fixture seeds alice-bob friendship; the picker
    // should show bob.
    await expect(alice.locator("[data-testid='friend-picker']")).toBeVisible({ timeout: 5000 });
    const bobOption = alice
      .locator("[data-testid='friend-picker-item']")
      .filter({ hasText: BOB_USER.slice(0, 8) });
    await expect(bobOption).toBeVisible();

    // Fill out the form.
    await alice.locator("[data-testid='create-modal-name']").fill("e2e-test");
    await bobOption.click();

    // Submit.
    await alice.locator("[data-testid='create-modal-submit']").click();

    // Modal closes; the new channel appears in alice's sidebar and is active.
    await expect(alice.locator("[data-testid='create-modal']")).not.toBeVisible();
    const aliceChannelItem = alice
      .locator("[data-testid='sidebar-item']")
      .filter({ hasText: "e2e-test" });
    await expect(aliceChannelItem).toBeVisible();
    await expect(aliceChannelItem).toHaveAttribute("data-active", "true");

    // Bob's sidebar should pick up the new channel via channel_event.
    // (Phase 08b: client receives channel_event, dispatches channel_added,
    //  sends subscribe_channel; sidebar updates as soon as channel_added
    //  is dispatched.)
    const bobChannelItem = bob
      .locator("[data-testid='sidebar-item']")
      .filter({ hasText: "e2e-test" });
    await expect(bobChannelItem).toBeVisible({ timeout: 5000 });

    // Bob clicks the channel.
    await bobChannelItem.click();
    await expect(bobChannelItem).toHaveAttribute("data-active", "true");

    // Alice types a message and sends.
    const phrase = "hello from e2e " + Date.now();
    await alice.locator("[data-testid='composer-input']").fill(phrase);
    await alice.locator("[data-testid='composer-send']").click();

    // Bob's message list shows the message.
    await expect(
      bob.locator("[data-testid='message-body']").filter({ hasText: phrase })
    ).toBeVisible({ timeout: 5000 });
  });
});

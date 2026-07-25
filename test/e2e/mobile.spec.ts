// chalk 33-6 -- mobile layout spec.
//
// Covers the two things the 33-6 CSS changes can't be verified by the node
// suite (which has no DOM) and that are easy to regress by touching an
// unrelated media query:
//
//   1) The roster drawer is a narrow overlay, not most of the screen.
//   2) Row actions (reply / delete) are permanently visible on touch and
//      render glyph-only, so they don't eat the message row's width.
//
// Plus a desktop counterpart asserting the mobile rules did NOT leak: the
// actions stay hover-revealed and keep their text labels. That pairing is
// the actual regression guard -- 33-6 moved the reveal from the individual
// buttons onto a wrapping .chalk-message-actions group, and a mistake there
// shows up as either "always visible on desktop" or "never visible at all".
//
// Preconditions (shared with every other chat-UI spec in this suite):
//
//   * chalkd running and serving the SPA at CHALK_BASE_URL.
//   * An authenticated session in the browser context. Since auth v2 there
//     is no unauthenticated path to the chat UI -- the SPA renders the sign-
//     in card instead, and smoke.spec.ts fails at the same assertion this
//     spec does. Only admin.spec.ts carries login machinery (the password +
//     TOTP wizard); it has not been extracted into a shared fixture yet.
//   * A Chromium new enough for WebCrypto Ed25519 (>= 137), which the
//     identity gate needs before the chat UI mounts. @playwright/test 1.48
//     bundles Chromium 130, so the chat UI cannot be reached on the pinned
//     version -- admin.spec.ts skips its own chat-UI tests for this reason.
//
// Until those two are resolved this spec is written but unexecuted.

import { test, expect, devices, type Browser, type Page } from "@playwright/test";

const BASE =
  process.env.CHALK_BASE_URL ||
  process.env.CHALK_TEST_HTTP_1 ||
  "http://localhost:8443";

// Phone-sized touch device. isMobile drives Chromium's emulation of
// (hover: none) / (pointer: coarse), which is what both mobile rules key
// off -- a plain narrow viewport would NOT match them.
const PHONE = devices["Pixel 5"];

async function open(browser: Browser, opts: object): Promise<Page> {
  const ctx = await browser.newContext({ ...opts, baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/");
  // Wait for the SPA to settle into EITHER outcome, then name the failure.
  // Waiting only on the connected state times out with "element not found",
  // which says nothing about the (very likely) cause being a missing session.
  await page.waitForSelector("[data-state='open'], [data-testid='password-login']", {
    timeout: 10_000,
  });
  if (await page.locator("[data-testid='password-login']").isVisible()) {
    throw new Error(
      "SPA is showing the sign-in card: this spec needs an authenticated " +
        "context (see the preconditions at the top of this file)",
    );
  }
  await expect(page.locator("[data-state='open']")).toBeVisible({ timeout: 10_000 });
  return page;
}

// The row actions only exist once there's a message to hang them off.
// Returns a locator for the newest reply button.
async function sendOneMessage(page: Page, phrase: string) {
  await page.locator("[data-testid='composer-input']").fill(phrase);
  await page.locator("[data-testid='composer-send']").click();
  await expect(
    page.locator("[data-testid='message-body']", { hasText: phrase }),
  ).toBeVisible({ timeout: 5_000 });
}

function opacityOf(page: Page, selector: string) {
  return page
    .locator(selector)
    .last()
    .evaluate((el) => window.getComputedStyle(el).opacity);
}

test.describe("33-6 mobile layout", () => {
  test("roster drawer is a narrow overlay", async ({ browser }) => {
    const page = await open(browser, PHONE);

    const toggle = page.locator("[data-testid='nav-toggle']");
    await expect(toggle).toBeVisible();
    await toggle.click();

    const drawer = page.locator("#chalk-roster");
    await expect(drawer).toBeVisible();

    const box = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();

    // min(70vw, 270px). The absolute cap is the assertion that matters;
    // the proportional one documents why the cap exists -- a sliver of the
    // conversation has to stay visible to orient against and tap away on.
    expect(box!.width).toBeLessThanOrEqual(270);
    expect(box!.width).toBeLessThan(viewport!.width * 0.75);

    await page.locator("[data-testid='nav-close']").click();
    await expect(drawer).toBeHidden();

    await page.context().close();
  });

  test("row actions are always visible and glyph-only on touch", async ({ browser }) => {
    const page = await open(browser, PHONE);

    // Fail loudly rather than silently passing if the browser isn't
    // emulating a coarse pointer: every assertion below depends on the
    // (hover: none) branch being the one in effect.
    const coarse = await page.evaluate(() => window.matchMedia("(hover: none)").matches);
    expect(coarse, "(hover: none) must be emulated for this spec to mean anything").toBe(true);

    await sendOneMessage(page, `33-6 mobile probe ${Date.now()}`);

    // Permanently revealed -- there is no hover to reveal them with.
    // Checked via computed opacity because Playwright's toBeVisible()
    // treats an opacity:0 element as visible.
    expect(await opacityOf(page, ".chalk-message-actions")).toBe("1");

    const reply = page.locator("[data-testid^='message-reply-']").last();
    await expect(reply).toBeVisible();

    // The word is dropped; only the glyph remains.
    await expect(reply.locator(".chalk-message-action-word")).toBeHidden();
    await expect(reply).toHaveAttribute("aria-label", "reply in thread");

    // A labelled button was ~5rem wide and wrapped the body below it. The
    // glyph-only one is a compact tap target.
    const box = await reply.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(48);
    expect(box!.height).toBeGreaterThanOrEqual(20);

    await page.context().close();
  });

  test("desktop keeps hover-revealed, labelled row actions", async ({ browser }) => {
    const page = await open(browser, devices["Desktop Chrome"]);

    await sendOneMessage(page, `33-6 desktop probe ${Date.now()}`);

    const actions = page.locator(".chalk-message-actions").last();
    const row = page.locator("[data-testid='message']").last();

    // Hidden until the row is hovered.
    expect(await opacityOf(page, ".chalk-message-actions")).toBe("0");
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");

    // And the text label survives on a pointer device.
    const reply = page.locator("[data-testid^='message-reply-']").last();
    await expect(reply.locator(".chalk-message-action-word")).toBeVisible();
    await expect(reply).toContainText("reply");

    await page.context().close();
  });
});

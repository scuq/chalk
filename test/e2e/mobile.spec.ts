// chalk -- mobile layout spec.
//
// Covers what the node suite (which has no DOM) cannot verify and what is
// easy to regress by touching an unrelated media query:
//
//   1) The roster drawer is a narrow overlay, not most of the screen.
//   2) Touch gets no permanent row buttons and no ··· marker at all -- a
//      long press is the whole gesture, and the marker gutter is zeroed so
//      rows keep their full width.
//   3) Desktop reveals the marker on hover, and it sits strictly LEFT of the
//      body. That last assertion is the point of the whole design: the strip
//      this replaced was an overlay on the row's right edge, and it painted
//      over the text of any message whose first line ran long.
//   4) The menu folds itself back inside the viewport instead of being
//      clipped by the feed's scroller, which is what the old absolute menu
//      did on the last rows of a channel.
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

// The row menu only exists once there's a message to hang it off.
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

test.describe("mobile layout", () => {
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

  test("touch has no row buttons, and a long press opens the menu", async ({ browser }) => {
    const page = await open(browser, PHONE);

    // Fail loudly rather than silently passing if the browser isn't
    // emulating a coarse pointer: every assertion below depends on the
    // (hover: none) branch being the one in effect.
    const coarse = await page.evaluate(() => window.matchMedia("(hover: none)").matches);
    expect(coarse, "(hover: none) must be emulated for this spec to mean anything").toBe(true);

    await sendOneMessage(page, `mobile probe ${Date.now()}`);

    // Nothing permanent on the row, and no marker either: the press IS the
    // affordance. The gutter collapses to 0 with it, so the row keeps the
    // width the old button strip used to take.
    await expect(page.locator(".chalk-message-marker").last()).toBeHidden();
    const gutter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--chalk-msg-gutter").trim(),
    );
    expect(gutter).toBe("0px");

    const row = page.locator("[data-testid='message']").last();
    const box = (await row.boundingBox())!;
    await row.dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    const menu = page.locator("[data-testid='message-menu']");
    await expect(menu).toBeVisible({ timeout: 2_000 });
    await expect(menu).toHaveCSS("position", "fixed");

    await row.dispatchEvent("pointerup", { pointerType: "touch" });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.context().close();
  });

  test("desktop reveals the marker on hover, clear of the body text", async ({ browser }) => {
    const page = await open(browser, devices["Desktop Chrome"]);

    // Long enough that the old right-edge strip would have covered its tail.
    await sendOneMessage(
      page,
      `desktop probe ${Date.now()} https://developer.apple.com/documentation/xcode/installing-the-command-line-tools`,
    );

    const row = page.locator("[data-testid='message']").last();
    const marker = page.locator(".chalk-message-marker").last();

    // Hidden until the row is hovered. Checked via computed opacity because
    // Playwright's toBeVisible() treats an opacity:0 element as visible.
    expect(await opacityOf(page, ".chalk-message-marker")).toBe("0");
    await row.hover();
    await expect(marker).toHaveCSS("opacity", "1");

    // The assertion the whole change exists for: the trigger sits in the
    // row's left padding, so it cannot reach the text no matter how long the
    // message is.
    const m = (await marker.boundingBox())!;
    const body = (await page.locator("[data-testid='message-body']").last().boundingBox())!;
    expect(m.x + m.width).toBeLessThanOrEqual(body.x);

    await marker.click();
    const menu = page.locator("[data-testid='message-menu']");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("react...");
    await expect(menu).toContainText("copy text");

    await page.context().close();
  });

  test("the menu folds back inside the viewport", async ({ browser }) => {
    const page = await open(browser, devices["Desktop Chrome"]);

    await sendOneMessage(page, `viewport probe ${Date.now()}`);

    // The newest message sits at the bottom of the feed, which is where the
    // old absolute menu was clipped by .chalk-main's scroller.
    const row = page.locator("[data-testid='message']").last();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + box.width - 8, box.y + box.height - 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });

    const menu = page.locator("[data-testid='message-menu']");
    await expect(menu).toBeVisible();

    const mb = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.y).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width);
    expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height);

    await page.context().close();
  });
});

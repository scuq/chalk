// chalk e2e — admin claim + moderation panel
//
// Three serial tests in one describe block, sharing browser context
// so the session cookie persists across them:
//
//   A. Claim: visit ?admin_token=<token>, complete the password+TOTP
//      signup wizard against the seeded-but-unclaimed admin row,
//      confirm the recovery words, land in the chat UI as the admin.
//
//   B. Reach panel: open the StatusBar user menu, click "admin",
//      assert the URL is /admin and the panel renders the users tab.
//
//   C. Block + unblock cycle: search for bob, hover his row, click
//      block, assert the status pill turns "blocked", click unblock,
//      assert it returns to "active". Side-channel: chalkd's stderr
//      gets a "kicked N session(s)" log line — we don't assert that
//      from the spec but it's worth eyeballing in a manual run.
//
// Pre-flight expectations:
//   - chalkd running and reachable at CHALK_BASE_URL (default
//     http://localhost:8443).
//   - chalkd started with CHALK_ADMIN_BOOTSTRAP_TOKEN set, and the
//     SAME value exported into this test's environment. The token
//     lives in the server's environment and cannot be minted from
//     here — without it the whole describe block skips.
//   - Postgres reachable via docker exec chalk-dev-pg (the dev
//     setup's default container name).
//   - The "alice", "bob", "carol" fixture users exist (seeded by
//     tools/dev.sh).
//
// Setup approach:
//   The claim needs a seeded-but-unclaimed admin row: role='admin'
//   with no user_auth and no passkeys. chalkd creates exactly that on
//   first boot, but we cannot rely on process lifetime, so we recreate
//   it directly via SQL (with admin_delete_guard temporarily disabled
//   — the trigger refuses DELETE on admin rows by default).
//
//   The admin username must match the server's CHALK_ADMIN_USERNAME:
//   the claim is authorized for that name only.
//
// TOTP:
//   The wizard shows the base32 secret; we compute the current code
//   from it the same way an authenticator app would (HMAC-SHA1 over
//   the 30-second counter, dynamic truncation, 6 digits). No virtual
//   authenticator is involved — the claim is password + TOTP, not
//   WebAuthn.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";

// ---- Config ----------------------------------------------------------

// The claim only works for the server's configured admin username, so
// these come from the environment the server was started with.
const ADMIN_USERNAME = process.env.CHALK_ADMIN_USERNAME ?? "e2eadmin";
const ADMIN_EMAIL = process.env.CHALK_ADMIN_EMAIL ?? "admin@e2e.invalid";
const ADMIN_DISPLAY = "e2e admin";
const ADMIN_TOKEN = process.env.CHALK_ADMIN_BOOTSTRAP_TOKEN ?? "";

// Must satisfy the server's policy: >=20 chars, 4 classes.
const ADMIN_PASSWORD = "e2e Admin Passw0rd!!";

// Docker container running PG (matches tools/dev.sh default).
const PG_CONTAINER = process.env.CHALK_TEST_PG_CONTAINER ?? "chalk-dev-pg";
const PG_USER = process.env.CHALK_TEST_PG_USER ?? "chalk";
const PG_DB = process.env.CHALK_TEST_PG_DB ?? "chalk";

// ---- TOTP ------------------------------------------------------------

// base32Decode decodes RFC 4648 base32 (no padding needed) — the
// encoding the wizard shows the TOTP secret in.
function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// totpNow computes the current 6-digit TOTP code, exactly as an
// authenticator app would: HMAC-SHA1 over the big-endian 30-second
// counter, dynamic truncation, modulo 10^6.
function totpNow(secretB32: string): string {
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

// psql wrapper: run a single SQL statement, return stdout.
// Uses -t -A for tuple-only + unaligned output.
//
// We pipe the SQL via stdin instead of passing it through -c to
// avoid shell escaping pitfalls (newlines, single quotes inside
// SQL strings, etc). docker exec -i forwards stdin to the container
// command; psql reads SQL from stdin when no -c/-f argument is given.
function psql(sql: string): string {
  const out = execSync(
    `docker exec -i ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -t -A`,
    {
      encoding: "utf-8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return out.trim();
}

// ---- Helpers --------------------------------------------------------

// Wipe and re-seed the admin row in its UNCLAIMED shape: identity
// only, no user_auth and no passkeys. That absence of credentials is
// exactly what makes it claimable. Returns the new row's id.
function seedUnclaimedAdmin(): string {
  // The admin_delete_guard trigger refuses DELETE on admin rows.
  // Temporarily disable for the wipe. Wrapping in a single block keeps
  // the trigger off no longer than necessary; if the script dies
  // mid-block, the next run will catch it via the explicit ENABLE.
  psql(`
    ALTER TABLE users DISABLE TRIGGER admin_delete_guard;
    DELETE FROM users WHERE role='admin';
    ALTER TABLE users ENABLE TRIGGER admin_delete_guard;
  `);

  // Mirror BootstrapAdminUser's insert exactly: id (UUID), handle
  // (citext, matches username), username, display_name, email, role,
  // email_verified_at. gen_random_uuid() saves generating one here.
  const insertOut = psql(`
    INSERT INTO users (
      id, handle, username, display_name, email,
      role, email_verified_at
    ) VALUES (
      gen_random_uuid(), '${ADMIN_USERNAME}'::citext, '${ADMIN_USERNAME}'::citext,
      '${ADMIN_DISPLAY}', '${ADMIN_EMAIL}'::citext, 'admin', now()
    )
    RETURNING id::text
  `);
  const uuidLine = insertOut
    .split("\n")
    .map((s) => s.trim())
    .find((s) => /^[0-9a-f-]{36}$/.test(s));
  if (!uuidLine) {
    throw new Error(`failed to insert admin row; psql output was:\n${insertOut}`);
  }
  return uuidLine;
}

// Wait for the user-list to populate with at least one row whose
// username matches `username`. Returns the row locator.
async function findUserRowByUsername(page: Page, username: string) {
  // The cells don't expose data-username on themselves, but the row
  // has data-user-id; we can search via the username text cell.
  // Filter the username cells, then pick their parent <tr>.
  const row = page
    .locator("[data-testid='admin-users-row']")
    .filter({ has: page.locator(".chalk-admin-cell-username", { hasText: new RegExp(`^${username}$`) }) });
  await expect(row).toBeVisible({ timeout: 5_000 });
  return row;
}

// ---- The tests ------------------------------------------------------

test.describe.serial("chalk admin flow", () => {
  // Shared context across the three tests so the session cookie
  // from Test A is available in Test B + C.
  let context: BrowserContext;
  let page: Page;

  // The token lives in chalkd's environment; we cannot mint one from
  // here the way the old DB-token bootstrap allowed. Without it there
  // is nothing to test.
  test.skip(
    !ADMIN_TOKEN,
    "CHALK_ADMIN_BOOTSTRAP_TOKEN not set; export the same value chalkd was started with",
  );

  test.beforeAll(async ({ browser }) => {
    // Reset the admin row to its unclaimed shape so the run repeats.
    seedUnclaimedAdmin();

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
    // Best-effort cleanup so we don't leave a claimed admin in place.
    // Wrapped in try/catch because a mid-run failure may have left the
    // trigger disabled, and cleanup must not mask the real failure.
    try {
      psql(`
        ALTER TABLE users DISABLE TRIGGER admin_delete_guard;
        DELETE FROM users WHERE username='${ADMIN_USERNAME}';
        ALTER TABLE users ENABLE TRIGGER admin_delete_guard;
      `);
    } catch {
      // Cleanup failure is non-fatal; the next run will reseed.
    }
  });

  test("A. admin claim lands in chat as admin", async () => {
    // Visit the enrollment URL chalkctl prints.
    await page.goto(`/?admin_token=${ADMIN_TOKEN}`);

    // The wizard opens directly — no login screen in between. That is
    // the whole point of the URL, and the regression this guards.
    const wizard = page.locator("[data-testid='signup-wizard']");
    await expect(wizard).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator("[data-testid='signup-admin-claim-note']"),
    ).toBeVisible();

    // Username is prefilled with the configured admin name and locked.
    const usernameInput = page.locator("[data-testid='signup-username']");
    await expect(usernameInput).toHaveValue(ADMIN_USERNAME);
    await expect(usernameInput).toHaveAttribute("readonly", /.*/);

    // The token must SURVIVE in the URL: signupV2Begin re-reads it from
    // window.location.search when it posts. Scrubbing it here would
    // strip the wizard's authorization.
    expect(new URL(page.url()).searchParams.get("admin_token")).toBe(ADMIN_TOKEN);

    // Step 1: email (username is fixed).
    await page
      .locator("[data-testid='signup-step-account'] input[type='email']")
      .fill(ADMIN_EMAIL);
    await page.locator("[data-testid='signup-account-next']").click();

    // Step 2: password + confirm.
    const pwInputs = page.locator(
      "[data-testid='signup-step-password'] input[type='password']",
    );
    await pwInputs.nth(0).fill(ADMIN_PASSWORD);
    await pwInputs.nth(1).fill(ADMIN_PASSWORD);
    await page.locator("[data-testid='signup-password-next']").click();

    // Step 3: read the provisioned secret and answer with a live code.
    const totpStep = page.locator("[data-testid='signup-step-totp']");
    await expect(totpStep).toBeVisible({ timeout: 10_000 });
    const secret = (
      await page.locator("[data-testid='signup-secret']").innerText()
    ).trim();
    expect(secret.length).toBeGreaterThan(0);
    await totpStep.locator("input").fill(totpNow(secret));
    await page.locator("[data-testid='signup-finish']").click();

    // The recovery screen should appear with the words.
    const recovery = page.locator("[data-testid='recovery-screen']");
    await expect(recovery).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid='recovery-words']")).toBeVisible();

    // The claim is committed at this point — assert the identity before
    // clicking through, so the check does not depend on which gate
    // (migration, identity setup) renders next.
    const meResp = await page.request.get("/api/auth/me");
    expect(meResp.status()).toBe(200);
    const me = await meResp.json();
    expect(me.role).toBe("admin");
    expect(me.username).toBe(ADMIN_USERNAME);

    // Acknowledge + continue. The screen gates "continue" behind a
    // short countdown after the ack is checked.
    await page.locator("[data-testid='recovery-ack']").check();
    const cont = page.locator("[data-testid='recovery-continue']");
    await expect(cont).toBeEnabled({ timeout: 10_000 });
    await cont.click();

    // We should now be in the chat UI. The StatusBar's user widget
    // shows the username.
    const userWidget = page.locator("[data-testid='status-user-menu-trigger']");
    await expect(userWidget).toBeVisible({ timeout: 10_000 });
    await expect(userWidget).toContainText(ADMIN_USERNAME);
  });

  test("B. status-bar admin menu opens the moderation panel", async () => {
    // Open the user dropdown.
    await page.locator("[data-testid='status-user-menu-trigger']").click();

    // The admin menu item should be visible (gated on me.role).
    const adminItem = page.locator("[data-testid='status-user-menu-admin']");
    await expect(adminItem).toBeVisible({ timeout: 2_000 });

    // Click it. URL should become /admin and the panel mounts.
    await adminItem.click();
    await expect(page).toHaveURL(/\/admin$/, { timeout: 5_000 });

    const panel = page.locator("[data-testid='admin-panel']");
    await expect(panel).toBeVisible();

    // Default tab is users; the users tab content should be visible.
    const usersTab = page.locator("[data-testid='admin-users-tab']");
    await expect(usersTab).toBeVisible();

    // The fixture users (alice, bob, carol) plus the e2e admin
    // should be in the list. Total >= 4. (Other tests in this
    // run or stale fixtures may have added more, so use >=, not ==.)
    const pageLabel = page.locator("[data-testid='admin-users-page-label']");
    await expect(pageLabel).toBeVisible();
    const labelText = await pageLabel.textContent();
    const match = labelText?.match(/(\d+)\s+(user|users)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(4);
  });

  test("C. block then unblock a non-admin user (bob)", async () => {
    // Search for bob to narrow the list — much faster than scrolling.
    const search = page.locator("[data-testid='admin-users-search-input']");
    await search.fill("bob");

    // The search is debounced ~250ms in the reducer. Give it a moment
    // and then wait for the row to appear (or the empty-state if
    // somehow bob is missing).
    const bobRow = await findUserRowByUsername(page, "bob");

    // Initial state: bob should be active. Verify the status pill.
    const initialPill = bobRow.locator("[data-testid='admin-user-status-pill']");
    await expect(initialPill).toHaveText("active", { timeout: 5_000 });

    // Hover the row to reveal the action buttons. Playwright's
    // .hover() is synthetic but our CSS triggers off :hover which
    // works fine with synthetic input.
    await bobRow.hover();

    // Click "block". The reducer pendingActionUserID flips, the row
    // briefly shows the pending '…' indicator, then the list
    // refreshes and the pill flips to "blocked".
    await bobRow.locator("[data-testid='admin-user-action-block']").click();

    // Wait for the pill to update. We re-locate because the row
    // gets re-rendered after refresh.
    const blockedRow = await findUserRowByUsername(page, "bob");
    const blockedPill = blockedRow.locator("[data-testid='admin-user-status-pill']");
    await expect(blockedPill).toHaveText("blocked", { timeout: 5_000 });

    // Now unblock. Hover, click, wait for active.
    await blockedRow.hover();
    await blockedRow.locator("[data-testid='admin-user-action-unblock']").click();

    const restoredRow = await findUserRowByUsername(page, "bob");
    const restoredPill = restoredRow.locator("[data-testid='admin-user-status-pill']");
    await expect(restoredPill).toHaveText("active", { timeout: 5_000 });
  });
});

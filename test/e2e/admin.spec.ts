// chalk phase 09d e2e — admin bootstrap + moderation panel
//
// Three serial tests in one describe block, sharing browser context
// so the session cookie persists across them:
//
//   A. Bootstrap: visit ?admin_bootstrap=<token>, drive the WebAuthn
//      ceremony via Chromium's virtual authenticator, confirm the
//      recovery words, land in the chat UI as the admin.
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
//   - Postgres reachable via docker exec chalk-dev-pg (the dev
//     setup's default container name).
//   - The "alice", "bob", "carol" fixture users exist (seeded by
//     tools/dev.sh).
//
// Setup approach:
//   We bypass chalkd's startup banner (which only fires once per
//   process lifetime when CHALK_ADMIN_USERNAME is set + no admin
//   row exists). Instead we directly:
//     1. Wipe the existing admin row + admin_bootstrap_tokens
//        rows via SQL (with admin_delete_guard temporarily
//        disabled — the trigger refuses DELETE on admin rows by
//        default).
//     2. Insert a fresh admin row.
//     3. Mint a fresh bootstrap token by inserting into
//        admin_bootstrap_tokens.
//     4. URL-encode the token bytes as base64url.
//
// This tests the user-visible flow (URL → ceremony → recovery →
// chat) without depending on chalkd restart coordination.
//
// Why CDP virtual authenticator:
//   Real WebAuthn needs a hardware authenticator. Chromium exposes
//   a virtual authenticator via CDP that creates and uses
//   in-memory credentials. Playwright gives us a CDP session
//   per page; we enable WebAuthn and add a virtual authenticator
//   before navigating to the bootstrap URL.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";

// ---- Config ----------------------------------------------------------

const ADMIN_USERNAME = "e2eadmin";
const ADMIN_EMAIL = "admin@e2e.invalid";
const ADMIN_DISPLAY = "e2e admin";

// Docker container running PG (matches tools/dev.sh default).
const PG_CONTAINER = process.env.CHALK_TEST_PG_CONTAINER ?? "chalk-dev-pg";
const PG_USER = process.env.CHALK_TEST_PG_USER ?? "chalk";
const PG_DB = process.env.CHALK_TEST_PG_DB ?? "chalk";

// Token: 32 random bytes, hex-encoded for the SQL insert.
// We generate it client-side so we can URL-encode the matching
// base64url for the navigation step.
function randomTokenBytes(): Uint8Array {
  // Node 20+ has webcrypto on the globalThis. Playwright bundles
  // a recent Node; use the standard API.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  // Standard base64 → base64url: + → -, / → _, strip =.
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

// Wipe and re-seed the admin state for a clean test run.
// Returns the bootstrap token as a URL-safe string.
function seedAdminAndMintToken(): { token: string; adminUserID: string } {
  const tokenBytes = randomTokenBytes();
  const tokenHex = toHex(tokenBytes);
  const tokenB64Url = toBase64Url(tokenBytes);

  // The admin_delete_guard trigger refuses DELETE on admin rows.
  // Temporarily disable for the wipe. Also drop any unused tokens.
  // Wrapping in a single -c "..." block keeps the trigger off no
  // longer than necessary; if the script dies mid-block, the next
  // run will catch it via the explicit ENABLE.
  psql(`
    ALTER TABLE users DISABLE TRIGGER admin_delete_guard;
    DELETE FROM users WHERE role='admin';
    DELETE FROM admin_bootstrap_tokens;
    ALTER TABLE users ENABLE TRIGGER admin_delete_guard;
  `);

  // Insert the admin user. Mirror the application's BootstrapAdminUser
  // schema exactly: id (UUID), handle (citext, matches username),
  // username, display_name, email, role, email_verified_at. We use
  // gen_random_uuid() for the id so we don't have to generate one
  // client-side.
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
  const adminID = uuidLine;

  // Mint a bootstrap token. The token is stored as bytea; insert
  // via decode('<hex>', 'hex'). The application reads it the same
  // way (constant-time compare against the URL-decoded token bytes).
  psql(`
    INSERT INTO admin_bootstrap_tokens (token, expires_at)
    VALUES (decode('${tokenHex}', 'hex'), now() + interval '1 hour')
  `);

  return { token: tokenB64Url, adminUserID: adminID };
}

// Install a Chromium virtual authenticator on this page's CDP
// session. Returns the authenticator ID (useful if we need to
// inspect credentials later, but for our purposes we just need it
// installed). Must be called BEFORE navigation to the bootstrap URL
// — adding the authenticator after navigator.credentials.create()
// has already been called won't help that in-flight ceremony.
async function installVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<string> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        // Auto-consent: any navigator.credentials.create() or .get()
        // call resolves without user interaction. Required because
        // there's no human to click "yes, use the key".
        automaticPresenceSimulation: true,
      },
    },
  );
  return authenticatorId;
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

test.describe.serial("chalk phase 09d admin flow", () => {
  let bootstrapToken: string;
  // Shared context across the three tests so the session cookie
  // from Test A is available in Test B + C.
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Seed the DB. This wipes any previous admin and mints a fresh
    // bootstrap token so the run is reproducible.
    const seed = seedAdminAndMintToken();
    bootstrapToken = seed.token;

    context = await browser.newContext();
    page = await context.newPage();
    // Install the virtual authenticator BEFORE we navigate; once
    // installed, all subsequent ceremonies on this page auto-consent.
    await installVirtualAuthenticator(context, page);
  });

  test.afterAll(async () => {
    await context?.close();
    // Best-effort cleanup so we don't leave a fake admin in place.
    // We wrap in try/catch because the test may have left the
    // trigger disabled mid-run and we don't want cleanup to mask
    // the real test failure.
    try {
      psql(`
        ALTER TABLE users DISABLE TRIGGER admin_delete_guard;
        DELETE FROM users WHERE username='${ADMIN_USERNAME}';
        DELETE FROM admin_bootstrap_tokens;
        ALTER TABLE users ENABLE TRIGGER admin_delete_guard;
      `);
    } catch {
      // Cleanup failure is non-fatal; the next run will reseed.
    }
  });

  test("A. bootstrap ceremony lands in chat as admin", async () => {
    // Visit the bootstrap URL.
    await page.goto(`/?admin_bootstrap=${bootstrapToken}`);

    // Bootstrap card renders.
    const card = page.locator("[data-testid='admin-bootstrap-screen']");
    await expect(card).toBeVisible({ timeout: 5_000 });

    // The URL gets cleaned by history.replaceState — verify there's
    // no admin_bootstrap query param left.
    const urlAfterLoad = new URL(page.url());
    expect(urlAfterLoad.searchParams.has("admin_bootstrap")).toBe(false);

    // Click register. The virtual authenticator auto-consents to the
    // navigator.credentials.create() call inside performRegistration().
    await page.locator("[data-testid='admin-bootstrap-submit']").click();

    // The recovery screen should appear with 24 words.
    const recovery = page.locator("[data-testid='recovery-screen']");
    await expect(recovery).toBeVisible({ timeout: 10_000 });
    const words = page.locator("[data-testid='recovery-words']");
    await expect(words).toBeVisible();

    // Acknowledge + continue. The screen gates "continue" behind a
    // short countdown after the ack is checked; we wait for the
    // continue button to enable.
    const ack = page.locator("[data-testid='recovery-ack']");
    await ack.check();
    const cont = page.locator("[data-testid='recovery-continue']");
    await expect(cont).toBeEnabled({ timeout: 10_000 });
    await cont.click();

    // We should now be in the chat UI. The StatusBar's user widget
    // shows the username.
   // await page.reload();

    const userWidget = page.locator("[data-testid='status-user-menu-trigger']");

    await expect(userWidget).toBeVisible({ timeout: 10_000 });
    await expect(userWidget).toContainText(ADMIN_USERNAME);

    // Sanity: /api/auth/me should return role=admin. We hit it
    // directly from the page context (cookie is set) to confirm.
    const meResp = await page.request.get("/api/auth/me");
    expect(meResp.status()).toBe(200);
    const me = await meResp.json();
    expect(me.role).toBe("admin");
    expect(me.username).toBe(ADMIN_USERNAME);
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

import { defineConfig, devices } from "@playwright/test";

// Phase 07: single browser (chromium), single project, narrow scope.
// Phase 13 expands to the full matrix.
//
// The base URL is set from CHALK_BASE_URL (exported by the bootstrap
// script after server_up_n starts chalkd #1). If unset, default to a
// local dev URL so individual `npx playwright test` invocations work.

const baseURL = process.env.CHALK_BASE_URL || "http://localhost:8443";

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: false, // one browser, sequential tests
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

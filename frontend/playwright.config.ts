import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end config for the hero demo flow.
 *
 * This suite runs against a *live* backend with a seeded user, because the
 * thing it proves — a real task streaming to completion with citations and a
 * downloadable artifact — cannot be faked. It is deliberately separate from
 * the Vitest unit suite (`npm test`), which mocks the network.
 *
 * Set before running:
 *   E2E_BASE_URL   where the app is served (default http://localhost:4173)
 *   E2E_EMAIL      a seeded account
 *   E2E_PASSWORD   its password
 *
 * Then: `npx playwright install chromium` once, and `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
});

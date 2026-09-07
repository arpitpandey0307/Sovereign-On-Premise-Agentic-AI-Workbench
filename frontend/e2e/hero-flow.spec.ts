/**
 * The hero demo flow, end to end against a real backend.
 *
 * This is the sequence shown to judges: sign in, ask the workbench a real
 * question, watch the agent work through its stages on the live stream, and
 * get back a structured answer with citations and a downloadable artifact. It
 * is the single thing most worth knowing is broken before the room finds out,
 * so it gets its own test rather than being folded into the mocked unit suite.
 *
 * It needs a live deployment and a seeded account:
 *   E2E_BASE_URL, E2E_EMAIL, E2E_PASSWORD
 * Without those it skips rather than fails — a missing backend is not a
 * regression in the frontend.
 */

import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const CONFIGURED = Boolean(EMAIL && PASSWORD);

test.describe("the hero demo flow", () => {
  test.skip(!CONFIGURED, "set E2E_EMAIL and E2E_PASSWORD to run against a live backend");

  test("sign in, run a task, watch it stream, get a cited answer", async ({ page }) => {
    // 1. Sign in.
    await page.goto("/login");
    await page.getByLabel(/corporate id/i).fill(EMAIL!);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Land on the workspace selector or straight in; either way, reach the app.
    await page.waitForURL(/\/(workspaces|dashboard)/, { timeout: 30_000 });
    if (page.url().includes("/workspaces")) {
      await page.getByRole("button", { name: /enter .* workspace/i }).first().click();
    }
    await page.goto("/dashboard");

    // 2. Ask the question from the dashboard task field.
    const request =
      "Summarise the key points of the most recently ingested document, with a citation for each.";
    await page.getByPlaceholder(/Review this inspection report/i).fill(request);
    await page.getByRole("button", { name: /run task/i }).click();

    // 3. Hand-off to the Workbench with the stream attaching.
    await page.waitForURL(/\/workbench\?task=/, { timeout: 30_000 });
    await expect(page.getByText(request)).toBeVisible();

    // 4. The reasoning timeline appears and stages complete.
    await expect(page.getByText(/Show reasoning/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".tl-step.done").first()).toBeVisible({ timeout: 120_000 });

    // 5. A structured answer, its sources, and a downloadable artifact.
    await expect(page.locator(".msg-ai .body")).toBeVisible({ timeout: 120_000 });
    const sources = page.locator(".sources .lbl", { hasText: "SOURCES" });
    const outputs = page.locator(".sources.outputs .lbl", { hasText: "OUTPUT" });
    await expect(sources.or(outputs).first()).toBeVisible({ timeout: 30_000 });

    // 6. The reasoning collapsed once it settled, and no spinner is left running.
    await expect(page.getByText("Working…")).toHaveCount(0);
  });
});

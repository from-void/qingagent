import { expect, test } from "@playwright/test";
import { gotoHash } from "./_harness";

test.describe("pm-refactor phase0 contracts", () => {
  test("dom-contract: workspace keeps rank-0 DOM hooks mounted", async ({ page }) => {
    await page.goto("/");
    await gotoHash(page, "#/workspace");

    await expect(page.locator('[data-wf="WorkspacePage"]')).toBeVisible();
    await expect(page.locator('[data-wf="WorkspaceDocTopbar"]')).toBeVisible();
    await expect(page.locator('[data-wf="ChatMessageList"]')).toBeVisible();
    await expect(page.locator('[data-wf="ChatInput"]')).toBeVisible();
    await expect(page.locator('[data-wf="DocInit"]')).toBeVisible();
  });

  test("home-masonry: homepage keeps masonry cards, template ids, assets, and context menu", async ({ page }) => {
    await page.goto("/");
    await gotoHash(page, "#/");

    await expect(page.locator('[data-wf="HomePage"]')).toBeVisible();
    const cards = page.locator(".home-masonry-list .cm-card");
    await expect(cards.first()).toBeVisible();
    await expect(cards.first()).toHaveAttribute("data-template-id", /.+/);

    const assetUrls = await page.locator(".home-masonry-list img").evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    );
    expect(assetUrls.some((src) => src.includes("/chinese-masonry-assets/") || src.startsWith("data:"))).toBe(true);

    await cards.first().dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 120,
    });
    await expect(page.locator(".home-card-menu")).toBeVisible();
  });
});

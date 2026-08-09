import { expect, test, type Locator } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1200 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("qj-opening-scroll-played", "1");
  });
  await page.route("**/api/v1/home", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ recent_sessions: [] }),
    });
  });
  await page.goto("/?mock=8#/");
  await expect(page.locator(".qj-root")).toBeVisible();
});

test("新建卡位于首屏时浮钮隐藏且不占命中", async ({ page }) => {
  const fab = page.locator(".qj-new-fab");
  await expect(fab).toBeAttached();
  await expect(fab).not.toHaveClass(/(?:^|\s)qj-show(?:\s|$)/);
  await expect(fab).toHaveCSS("pointer-events", "none");
  await expect(fab).toHaveCSS("visibility", "hidden");

  const geometry = await inspectHitTarget(fab);
  expect(
    geometry.hit,
    `隐藏 FAB 仍命中了 ${geometry.target ?? "null"}，pointer-events=${geometry.pointerEvents}, visibility=${geometry.visibility}`,
  ).toBe(false);
});

test("滚离新建卡后浮钮完整可见且中心点可命中", async ({ page }) => {
  const fab = page.locator(".qj-new-fab");
  await page.locator(".qj-scroll").press("End");

  await expect(fab).toHaveClass(/(?:^|\s)qj-show(?:\s|$)/);
  await expect(fab).toHaveCSS("pointer-events", "auto");
  await expect(fab).toHaveCSS("visibility", "visible");
  await expect.poll(async () => (await inspectHitTarget(fab)).insideViewport).toBe(true);
  await expect.poll(async () => (await inspectHitTarget(fab)).hit).toBe(true);
});

test("右下 dock 由视口内热点唤出后搜索按钮完整可见且可命中", async ({ page }) => {
  const hotspot = page.locator(".qj-dock-hotspot");
  const hotspotGeometry = await inspectHitTarget(hotspot);
  expect(hotspotGeometry.insideViewport).toBe(true);
  expect(hotspotGeometry.hit).toBe(true);

  await hotspot.hover({ position: { x: 450, y: 100 } });
  const dock = page.locator(".qj-dock");
  await expect(dock).toHaveClass(/(?:^|\s)qj-show(?:\s|$)/);

  const searchButton = page.locator(".qj-dock-search-btn");
  await expect(searchButton).toBeVisible();
  const searchGeometry = await inspectHitTarget(searchButton);
  expect(searchGeometry.insideViewport).toBe(true);
  expect(searchGeometry.hit).toBe(true);
});

async function inspectHitTarget(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const target = document.elementFromPoint(centerX, centerY);
    const style = getComputedStyle(element);
    return {
      rect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      viewportHeight: window.innerHeight,
      insideViewport:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
      hit: target === element || element.contains(target),
      target: target instanceof Element
        ? `${target.tagName}.${Array.from(target.classList).join(".")}`
        : null,
      className: element.className,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
    };
  });
}

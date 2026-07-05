import type { Page } from "@playwright/test";

/**
 * Set the URL hash and wait for the router/overlay state to react.
 */
export async function gotoHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  // brief tick to let useEffect handlers settle
  await page.waitForTimeout(50);
}

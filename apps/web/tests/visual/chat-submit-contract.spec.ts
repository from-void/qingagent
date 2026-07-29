import { expect, test } from "@playwright/test";
import { gotoHash } from "./_harness";

test("纯空白聊天的发送按钮在真实浏览器中不可命中", async ({ page }) => {
  await page.goto("/");
  await gotoHash(page, "#/workspace");

  const editor = page.locator('[data-wf="ChatInput"]');
  const sendButton = page.locator('[data-wf="WsSendBtn"]');
  await expect(editor).toBeVisible();
  const stopButton = page.locator('[data-wf="WsStopBtn"]');
  if (await stopButton.isVisible()) {
    await stopButton.click();
  }
  await editor.fill(" \u00a0\u3000\n ");
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveCSS("pointer-events", "none");

  const hitTarget = await sendButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      button: button.getAttribute("data-wf"),
      hit: hit?.getAttribute("data-wf") ?? hit?.tagName ?? null,
    };
  });
  expect(hitTarget.button).toBe("WsSendBtn");
  expect(hitTarget.hit).not.toBe("WsSendBtn");
});

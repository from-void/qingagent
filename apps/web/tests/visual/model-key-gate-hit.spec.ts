import { expect, test, type Locator, type Page } from "@playwright/test";

const MODEL_SETTINGS_RESPONSE = {
  provider: "kimi",
  apiKeyConfigured: false,
  providers: {
    deepseek: { apiKeyConfigured: false },
    kimi: { apiKeyConfigured: false },
  },
};

test.describe.configure({ mode: "serial" });

for (const layout of ["empty", "editing"] as const) {
  test(`真实工作区 ${layout} 布局的 NoKey CTA 可命中并完成恢复`, async ({ page }) => {
    await openPollutedWorkspace(page, layout);

    const editor = page.locator(".chat-edit");
    await expect(editor).toHaveCount(1);
    if (layout === "empty") {
      await expect(editor).toHaveClass(/(?:^|\s)is-empty(?:\s|$)/);
      await focusEditor(editor);
    } else {
      await editor.fill("已有聊天内容");
      await expect(editor).not.toHaveClass(/(?:^|\s)is-empty(?:\s|$)/);
    }

    const gate = page.locator(".nokey-gate");
    const cta = page.locator(".nokey-tip-btn");
    await page.keyboard.press("Enter");
    await expect(gate).toHaveClass(/(?:^|\s)is-forced(?:\s|$)/);
    await expect(cta).toBeVisible();
    await expect(page.locator(".nokey-tip")).toHaveCSS("pointer-events", "auto");

    const hit = await cta.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const input = button.closest(".wf-input");
      const editor = input?.querySelector(".chat-edit") ?? null;
      const tools = input?.querySelector(".ws-input-tools") ?? null;
      return {
        hit: target === button || button.contains(target),
        target: target instanceof Element
          ? `${target.tagName}.${Array.from(target.classList).join(".")}`
          : null,
        stacking: {
          inputIsolation: input ? getComputedStyle(input).isolation : null,
          editorZIndex: editor ? getComputedStyle(editor).zIndex : null,
          toolsZIndex: tools ? getComputedStyle(tools).zIndex : null,
        },
      };
    });
    expect(
      hit.hit,
      `${layout} 的 CTA 中心命中了 ${hit.target ?? "null"}`,
    ).toBe(true);
    expect(hit.stacking).toEqual({
      inputIsolation: "isolate",
      editorZIndex: "0",
      toolsZIndex: "2",
    });

    await cta.click();
    await expect(gate).toHaveCount(0);
    await expect.poll(
      () => page.evaluate(() => localStorage.getItem("qingagent.model_provider")),
    ).toBe("deepseek");
    if (layout === "empty") {
      await editor.fill("恢复发送");
    }
    await expect(gate).toHaveCount(0);
    await expect(page.locator(".ws-input-tools .wf-btn.primary")).toBeEnabled();
  });
}

async function openPollutedWorkspace(
  page: Page,
  layout: "empty" | "editing",
): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("qingagent.model_provider", "kimi");
    localStorage.setItem("qingagent.deepseek_api_key", "deepseek-test-key");
    localStorage.removeItem("qingagent.custom_provider");
    localStorage.removeItem("qingagent.official_model");
    localStorage.removeItem("qingagent.kimi_api_key");
    localStorage.removeItem("qingagent.kimi_custom_provider");
    localStorage.removeItem("qingagent.kimi_official_model");
  });
  await page.route("**/api/v1/skills", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ skills: [] }),
    });
  });
  await page.route("**/api/v1/capabilities", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        folderSources: {
          desktopLocal: { enabled: false },
          browserFsAccess: { enabled: false },
        },
      }),
    });
  });
  await page.route("**/api/v1/clientlog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/api/v1/settings/model", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(MODEL_SETTINGS_RESPONSE),
    });
  });
  if (layout === "editing") {
    await mockEditingSession(page);
  }
  await page.goto(
    layout === "editing"
      ? "/#/workspace?session=model-key-gate-visual"
      : "/#/workspace",
  );
  const workspace = page.locator("#view-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-content", layout);
  await expect(page.locator(".nokey-tip-text")).toContainText(
    "当前使用中的 Kimi 还没配置 key",
  );
}

async function mockEditingSession(page: Page): Promise<void> {
  await page.route("**/api/v1/commands", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        sessionId: "model-key-gate-visual",
        epoch: 1,
      }),
    });
  });
  await page.route("**/api/v1/events?*", async (route) => {
    const frames = [
      {
        kind: "sessionMeta",
        data: {
          sessionId: "model-key-gate-visual",
          title: "CTA 命中回归",
        },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      },
      {
        kind: "sessionRestoreCompleted",
        data: { sessionId: "model-key-gate-visual" },
      },
    ];
    const body = frames
      .map((frame, index) => (
        `event: frame\nid: ${index + 1}\ndata: ${JSON.stringify(frame)}\n\n`
      ))
      .join("");
    await route.fulfill({
      contentType: "text/event-stream",
      body,
    });
  });
}

async function focusEditor(editor: Locator): Promise<void> {
  const box = await editor.boundingBox();
  if (!box) throw new Error("chat editor layout missing");
  await editor.click({
    position: {
      x: Math.min(18, box.width / 2),
      y: Math.max(1, box.height - 12),
    },
  });
  await expect(editor).toBeFocused();
}

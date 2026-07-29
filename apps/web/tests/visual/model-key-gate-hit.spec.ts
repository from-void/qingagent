import { expect, test, type Page } from "@playwright/test";

test("NoKey CTA 与空编辑器在新建/编辑工作区都保持正确点击命中", async ({ page }) => {
  await page.goto("/");
  await loadWorkspaceStyles(page);

  for (const content of ["empty", "editing"] as const) {
    await mountGateLayout(page, content);

    const hit = await page.locator(".nokey-tip-btn").evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return target === button || button.contains(target);
    });
    expect(hit, `${content} 的 CTA 中心必须命中按钮`).toBe(true);

    const editor = page.locator(".chat-edit");
    const editorHit = await editor.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      ) === element;
    });
    expect(editorHit, `${content} 的空编辑器中心仍须可点击`).toBe(true);

    await editor.click({ position: { x: 110, y: 24 } });
    await page.keyboard.type("仍可输入");
    await expect(editor).toContainText("仍可输入");

    // 去掉强制态，验证从发送按钮穿过 12px hover bridge 移到 CTA 时气泡不消失。
    await page.locator(".nokey-gate").evaluate((gate) => gate.classList.remove("is-forced"));
    const sendBox = await page.locator("[data-send]").boundingBox();
    const ctaBox = await page.locator(".nokey-tip-btn").boundingBox();
    if (!sendBox || !ctaBox) throw new Error("gate layout missing");
    await page.mouse.move(
      sendBox.x + sendBox.width / 2,
      sendBox.y + sendBox.height / 2,
    );
    await page.mouse.move(
      ctaBox.x + ctaBox.width / 2,
      (sendBox.y + ctaBox.y + ctaBox.height) / 2,
      { steps: 4 },
    );
    await page.mouse.move(
      ctaBox.x + ctaBox.width / 2,
      ctaBox.y + ctaBox.height / 2,
      { steps: 4 },
    );
    await expect(page.locator(".nokey-tip")).toHaveCSS("pointer-events", "auto");
    await expect(page.locator(".nokey-tip")).toHaveCSS("opacity", "1");
  }
});

async function loadWorkspaceStyles(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function(
      "return Promise.all([" +
        "import('/src/pages/workspace/workspace.css')," +
        "import('/src/pages/workspace/workspace-ink-skin.css')" +
      "])",
    ) as () => Promise<unknown>;
    await load();
  });
}

async function mountGateLayout(
  page: Page,
  content: "empty" | "editing",
): Promise<void> {
  await page.evaluate((nextContent) => {
    document.body.dataset.content = nextContent;
    document.body.dataset.tool = "none";
    document.body.innerHTML = `
      <main id="view-workspace" style="height:900px;padding:300px 80px;background:#16212c">
        <section class="ws-left" style="width:${nextContent === "empty" ? 680 : 760}px">
          <div class="ws-input-wrap">
            <div class="ws-input-morph">
              <div class="wf-input" data-wf="ChatInputWrap">
                <div
                  class="chat-edit is-empty"
                  data-wf="ChatInput"
                  data-placeholder="说说你想写什么"
                  contenteditable="true"
                  role="textbox"
                  tabindex="0"
                ></div>
                <div class="ws-input-tools has-nokey-gate">
                  <div></div>
                  <div style="display:flex;align-items:center">
                    <span class="nokey-gate is-forced">
                      <button class="wf-btn primary small" data-send type="button" disabled>发送</button>
                      <span class="nokey-tip" role="tooltip">
                        <span class="nokey-tip-text">当前使用中的 Kimi 还没配置 key。</span>
                        <button class="nokey-tip-btn" type="button">切到 DeepSeek</button>
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    `;
  }, content);
}

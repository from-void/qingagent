import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const uiKitStyles = readFileSync(
  fileURLToPath(new URL("../../../../packages/ui-kit/src/components.css", import.meta.url)),
  "utf8",
);
const workspaceStyles = readFileSync(
  fileURLToPath(new URL("../../src/pages/workspace/workspace-ink-skin.css", import.meta.url)),
  "utf8",
);

for (const paperWidth of [800, 376]) {
  test(`${paperWidth}px 纸列中撤销按钮的 15 个采样点均可命中`, async ({ page }) => {
    await page.setContent(`
      <style>
        ${uiKitStyles}
        ${workspaceStyles}
        #view-workspace {
          --ws-paper-column-width: ${paperWidth}px;
          --ws-paper-top-offset: 52px;
          width: ${paperWidth}px;
          min-height: 900px;
        }
      </style>
      <section id="view-workspace">
        <main class="ws-right">
          <div class="ws-document-content">
            <div class="ws-docfns" data-wf="WorkspaceDocFunctions">
              <button type="button" class="ws-docfn-btn" title="审查">审</button>
              <button type="button" class="ws-docfn-btn" title="导出">出</button>
            </div>
            <div
              class="wf-region ws-review-commit-undo-banner"
              data-wf="ReviewCommitUndoBanner"
              style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:10px"
            >
              <span>本次修改已提交</span>
              <button
                type="button"
                class="wf-btn small ghost"
                onclick="document.body.dataset.undoClicked = 'true'"
              >撤销本次修改</button>
            </div>
          </div>
        </main>
      </section>
    `);

    const undoButton = page.getByRole("button", { name: "撤销本次修改" });
    const docFunctions = page.locator(".ws-docfns");
    await expect(undoButton).toBeVisible();
    await expect(docFunctions).toBeVisible();
    await expect(docFunctions).toHaveCSS("top", "64px");
    await expect(docFunctions).toHaveCSS("right", "18px");

    const hitEvidence = await undoButton.evaluate((button) => {
      const buttonRect = button.getBoundingClientRect();
      const docFunctions = document.querySelector<HTMLElement>(".ws-docfns");
      if (!docFunctions) throw new Error("纸内功能区未渲染");
      const docFunctionsRect = docFunctions.getBoundingClientRect();
      const xFractions = [0.1, 0.3, 0.5, 0.7, 0.9];
      const yFractions = [0.25, 0.5, 0.75];
      const samples = yFractions.flatMap((yFraction) =>
        xFractions.map((xFraction) => {
          const x = buttonRect.left + buttonRect.width * xFraction;
          const y = buttonRect.top + buttonRect.height * yFraction;
          const target = document.elementFromPoint(x, y);
          return {
            hit: target === button || button.contains(target),
            target: target instanceof Element
              ? `${target.tagName}.${Array.from(target.classList).join(".")}`
              : null,
            x,
            y,
          };
        }),
      );
      const overlaps = !(
        buttonRect.right <= docFunctionsRect.left ||
        buttonRect.left >= docFunctionsRect.right ||
        buttonRect.bottom <= docFunctionsRect.top ||
        buttonRect.top >= docFunctionsRect.bottom
      );
      return {
        buttonRect: {
          bottom: buttonRect.bottom,
          left: buttonRect.left,
          right: buttonRect.right,
          top: buttonRect.top,
        },
        docFunctionsRect: {
          bottom: docFunctionsRect.bottom,
          left: docFunctionsRect.left,
          right: docFunctionsRect.right,
          top: docFunctionsRect.top,
        },
        overlaps,
        samples,
      };
    });

    expect(
      hitEvidence.overlaps,
      `撤销按钮 ${JSON.stringify(hitEvidence.buttonRect)} 与纸内功能区 ${JSON.stringify(hitEvidence.docFunctionsRect)} 重叠`,
    ).toBe(false);
    expect(
      hitEvidence.samples.filter((sample) => !sample.hit),
      `15 点命中失败：${JSON.stringify(hitEvidence.samples)}`,
    ).toEqual([]);
    await undoButton.click();
    await expect(page.locator("body")).toHaveAttribute("data-undo-clicked", "true");
  });
}

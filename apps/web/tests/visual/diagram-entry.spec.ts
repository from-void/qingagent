import { expect, test, type Locator, type Page } from "@playwright/test";

interface ReachabilityEvidence {
  button: {
    opacity: number;
    pointerEvents: string;
    visibility: string;
  };
  actions: {
    opacity: number;
    pointerEvents: string;
    visibility: string;
  };
  hitIsButtonOrChild: boolean;
  hitClass: string | null;
  contentEditable: string | null;
  bodyTool: string | null;
  bodyContent: string | null;
}

async function hoverDiagramAndAssertReachable(
  page: Page,
  button: Locator,
): Promise<ReachabilityEvidence> {
  const diagram = page.locator(".pm-diagram-view").first();
  const diagramBox = await diagram.boundingBox();
  expect(diagramBox).not.toBeNull();
  await page.mouse.move(
    diagramBox!.x + diagramBox!.width / 2,
    diagramBox!.y + diagramBox!.height / 2,
  );
  await expect(button).toBeVisible();
  await page.waitForTimeout(200);

  const evidence = await button.evaluate((element) => {
    const button = element as HTMLButtonElement;
    const buttonStyle = getComputedStyle(button);
    const actions = button.closest<HTMLElement>(".pm-diagram-view-actions");
    if (!actions) throw new Error("图表操作区未挂载");
    const actionsStyle = getComputedStyle(actions);
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      button: {
        opacity: Number(buttonStyle.opacity),
        pointerEvents: buttonStyle.pointerEvents,
        visibility: buttonStyle.visibility,
      },
      actions: {
        opacity: Number(actionsStyle.opacity),
        pointerEvents: actionsStyle.pointerEvents,
        visibility: actionsStyle.visibility,
      },
      hitIsButtonOrChild: hit === button || Boolean(hit && button.contains(hit)),
      hitClass: hit instanceof HTMLElement ? hit.className : null,
      contentEditable: button.closest(".wf-doc")?.getAttribute("contenteditable") ?? null,
      bodyTool: document.body.dataset.tool ?? null,
      bodyContent: document.body.dataset.content ?? null,
    };
  });

  expect(evidence.button.opacity).toBeGreaterThan(0);
  expect(evidence.button.pointerEvents).not.toBe("none");
  expect(evidence.button.visibility).toBe("visible");
  expect(evidence.actions.opacity).toBeGreaterThan(0);
  expect(evidence.actions.pointerEvents).not.toBe("none");
  expect(evidence.actions.visibility).toBe("visible");
  expect(evidence.hitIsButtonOrChild).toBe(true);
  expect(evidence.bodyTool).toBe("none");
  expect(evidence.bodyContent).toBe("editing");
  return evidence;
}

async function realCoordinateClick(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.up();
}

test.describe("图表编辑入口", () => {
  test("新建路径：纯揭示动画不再裁掉入口，一次真实点击结算动画并打开编辑器", async ({ page }) => {
    await page.goto("/tests/visual/fixtures/diagram-entry.html?mode=new");

    const button = page.locator(".pm-diagram-view-actions .pm-diagram-view-btn", {
      hasText: "可视化编辑",
    });
    await expect(page.locator(".native-presentation-active")).toBeVisible();
    await expect(button).toBeAttached();
    const evidence = await hoverDiagramAndAssertReachable(page, button);
    expect(evidence.contentEditable).toBe("false");

    await realCoordinateClick(page, button);

    await expect(page.locator(".graph-diagram-editor")).toBeVisible();
    await expect(page.locator(".native-presentation-active")).toHaveCount(0);
    await expect(page.locator('.wf-doc[contenteditable="true"]')).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-presentation-canceled", "1");
    await expect(button).toHaveAttribute("aria-busy", "false");
  });

  test("加载恢复路径：默认隐藏不吃点击，真实 hover 后按钮可命中并打开编辑器", async ({ page }) => {
    await page.goto("/tests/visual/fixtures/diagram-entry.html?mode=restore");

    const button = page.locator(".pm-diagram-view-actions .pm-diagram-view-btn", {
      hasText: "可视化编辑",
    });
    await expect(page.locator('.wf-doc[contenteditable="true"]')).toBeVisible();
    await expect(button).toBeAttached();

    const inactive = await button.evaluate((element) => {
      const button = element as HTMLButtonElement;
      const actions = button.closest<HTMLElement>(".pm-diagram-view-actions");
      if (!actions) throw new Error("图表操作区未挂载");
      const buttonStyle = getComputedStyle(button);
      const actionsStyle = getComputedStyle(actions);
      return {
        buttonVisibility: buttonStyle.visibility,
        buttonPointerEvents: buttonStyle.pointerEvents,
        actionsVisibility: actionsStyle.visibility,
        actionsOpacity: Number(actionsStyle.opacity),
        actionsPointerEvents: actionsStyle.pointerEvents,
      };
    });
    expect(inactive).toEqual({
      buttonVisibility: "hidden",
      buttonPointerEvents: "none",
      actionsVisibility: "hidden",
      actionsOpacity: 0,
      actionsPointerEvents: "none",
    });

    const evidence = await hoverDiagramAndAssertReachable(page, button);
    expect(evidence.contentEditable).toBe("true");
    await realCoordinateClick(page, button);

    await expect(page.locator(".graph-diagram-editor")).toBeVisible();
    await expect(page.locator(".graph-diagram-viewer")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-busy", "false");
  });
});

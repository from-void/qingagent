import { expect, test, type Locator } from "@playwright/test";

interface DescriptionLayoutEvidence {
  clientWidth: number;
  elementWidth: number;
  rowTitle: string | null;
  scrollWidth: number;
  text: string;
  textWidth: number;
}

test("技能菜单只为真截断描述展示完整 tooltip", async ({ page }) => {
  await page.goto("/tests/visual/fixtures/skill-menu-tooltip.html");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    }));
  });

  const sharedRow = page.getByRole("menuitem", { name: /lark-shared/ });
  const noteRow = page.getByRole("menuitem", { name: /lark-note/ });
  const okrRow = page.getByRole("menuitem", { name: /lark-okr/ });
  await expect(sharedRow).toBeVisible();

  const evidence = {
    shared: await descriptionEvidence(sharedRow),
    note: await descriptionEvidence(noteRow),
    okr: await descriptionEvidence(okrRow),
  };
  console.log(`SKILL_MENU_REAL_LAYOUT ${JSON.stringify(evidence)}`);

  expect(evidence.shared.textWidth - evidence.shared.elementWidth).toBeGreaterThan(1);
  expect(evidence.okr.textWidth - evidence.okr.elementWidth).toBeLessThanOrEqual(1);
  expect(evidence.shared.rowTitle).toBe(
    "Use for lark-cli setup/auth tasks: auth login/status/logout, user vs bot identity, business-domain permissions (--domain, including all/docs/drive), missing scopes, revoking authorization, or handling _notice JSON.",
  );
  expect(evidence.okr.rowTitle).toBeNull();

  await sharedRow.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(evidence.shared.rowTitle!);

  await page.mouse.move(8, 8);
  await expect(tooltip).toHaveCount(0);
  await okrRow.hover();
  await page.waitForTimeout(220);
  await expect(tooltip).toHaveCount(0);
});

async function descriptionEvidence(row: Locator): Promise<DescriptionLayoutEvidence> {
  return row.evaluate((element) => {
    const description = element.querySelector<HTMLElement>(".qa-skill-desc");
    if (!description) throw new Error("技能说明未渲染");
    const range = document.createRange();
    range.selectNodeContents(description);
    return {
      clientWidth: description.clientWidth,
      elementWidth: description.getBoundingClientRect().width,
      rowTitle: element.getAttribute("title"),
      scrollWidth: description.scrollWidth,
      text: description.textContent ?? "",
      textWidth: range.getBoundingClientRect().width,
    };
  });
}

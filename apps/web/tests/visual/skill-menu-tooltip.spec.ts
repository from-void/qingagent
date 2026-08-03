import { expect, test, type Locator } from "@playwright/test";

interface DescriptionLayoutEvidence {
  clientWidth: number;
  elementWidth: number;
  rowTitle: string | null;
  scrollWidth: number;
  text: string;
  textWidth: number;
}

interface NameLayoutEvidence {
  menuWidth: number;
  nameWidth: number;
  overflow: string;
  rowWidth: number;
  textWidth: number;
  textOverflow: string;
  whiteSpace: string;
}

test("技能菜单只为真截断描述展示完整 tooltip", async ({ page }) => {
  await page.goto("/tests/visual/fixtures/skill-menu-tooltip.html");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    }));
  });

  const longSummaryRow = page.getByRole("menuitem", { name: /资料整理/ });
  const sharedRow = page.getByRole("menuitem", { name: /飞书连接与授权/ });
  const noteRow = page.getByRole("menuitem", { name: /飞书会议纪要/ });
  const okrRow = page.getByRole("menuitem", { name: /飞书 OKR/ });
  const attendanceRow = page.getByRole("menuitem", { name: /飞书考勤/ });
  const calendarRow = page.getByRole("menuitem", { name: /飞书日历/ });
  const extraLongNameRow = page.getByRole("menuitem", { name: /skill-name-that-is-too-long/ });
  await expect(longSummaryRow).toBeVisible();
  await expect(sharedRow).toBeVisible();

  const evidence = {
    longSummary: await descriptionEvidence(longSummaryRow),
    note: await descriptionEvidence(noteRow),
    okr: await descriptionEvidence(okrRow),
  };
  console.log(`SKILL_MENU_REAL_LAYOUT ${JSON.stringify(evidence)}`);

  expect(evidence.longSummary.textWidth - evidence.longSummary.elementWidth).toBeGreaterThan(1);
  expect(evidence.okr.textWidth - evidence.okr.elementWidth).toBeLessThanOrEqual(1);
  expect(evidence.longSummary.rowTitle).toBe(
    "查询并整理完整的异常状态、上下班时间、原始记录与详细说明。",
  );
  expect(evidence.okr.rowTitle).toBeNull();

  const attendanceName = await nameEvidence(attendanceRow);
  const calendarName = await nameEvidence(calendarRow);
  const extraLongName = await nameEvidence(extraLongNameRow);
  expect(attendanceName.textWidth - attendanceName.nameWidth).toBeLessThanOrEqual(1);
  expect(calendarName.textWidth - calendarName.nameWidth).toBeLessThanOrEqual(1);
  expect(extraLongName.textWidth - extraLongName.nameWidth).toBeGreaterThan(1);
  expect(extraLongName.whiteSpace).toBe("nowrap");
  expect(extraLongName.overflow).toBe("hidden");
  expect(extraLongName.textOverflow).toBe("ellipsis");
  expect(extraLongName.rowWidth).toBeLessThanOrEqual(extraLongName.menuWidth);

  await longSummaryRow.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(evidence.longSummary.rowTitle!);

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

async function nameEvidence(row: Locator): Promise<NameLayoutEvidence> {
  return row.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".qa-skill-name");
    const menu = element.closest<HTMLElement>(".qa-skill-menu");
    if (!name || !menu) throw new Error("技能名称或菜单未渲染");
    const range = document.createRange();
    range.selectNodeContents(name);
    const style = getComputedStyle(name);
    return {
      menuWidth: menu.getBoundingClientRect().width,
      nameWidth: name.getBoundingClientRect().width,
      overflow: style.overflow,
      rowWidth: element.getBoundingClientRect().width,
      textWidth: range.getBoundingClientRect().width,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
}

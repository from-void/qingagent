import { describe, expect, it } from "vitest";
import {
  barCardTemplate,
  compareCardTemplate,
  pointsCardTemplate,
} from "../svgTemplates/index.js";

const size = { width: 800, height: 450 };

describe("barCardTemplate", () => {
  it("混合零值与正值时，零值不渲染实心条", () => {
    const svg = barCardTemplate.render({
      bars: [
        { label: "无", value: 0 },
        { label: "有", value: 10 },
      ],
    }, size);

    const filledBars = svg.match(/<rect[^>]+fill="#9f6a24"\/>/g) ?? [];
    expect(filledBars).toHaveLength(1);
    expect(filledBars[0]).toContain('width="500.0"');
  });

  it("日文假名标签到达宽度边界时正确截断", () => {
    const svg = barCardTemplate.render({
      bars: [{ label: "ア".repeat(10), value: 10 }],
    }, size);

    expect(svg).not.toContain("ア".repeat(10));
    expect(svg).toContain(`${"ア".repeat(5)}…`);
  });
});

describe("compareCardTemplate", () => {
  it("韩文要点到达栏宽边界时正确截断", () => {
    const longItem = "한".repeat(20);
    const svg = compareCardTemplate.render({
      left: { title: "左", items: [longItem] },
      right: { title: "右", items: ["短"] },
    }, size);

    expect(svg).not.toContain(longItem);
    expect(svg).toContain(`${"한".repeat(16)}…`);
  });
});

describe("pointsCardTemplate", () => {
  it("全角标签到达卡片边界时正确截断", () => {
    const longLabel = "Ａ".repeat(10);
    const svg = pointsCardTemplate.render({
      points: [{ label: longLabel }],
    }, { width: 320, height: 450 });

    expect(svg).not.toContain(longLabel);
    expect(svg).toContain(`${"Ａ".repeat(8)}…`);
  });
});

import { describe, expect, it } from "vitest";
import { barCardTemplate } from "../svgTemplates/index.js";

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
});

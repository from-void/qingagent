// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { renderMermaid } from "../../components/mermaidRender";

beforeAll(() => {
  // jsdom 不提供 Mermaid 布局所需的 SVG 文字测量接口；返回稳定尺寸即可验证输出标签类型。
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 120, height: 24 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 120,
  });
});

describe("renderMermaid 标签导出", () => {
  it("中文 flowchart 标签使用原生 text/tspan，不生成 foreignObject", async () => {
    const svg = await renderMermaid("flowchart TD\n  A[中文标签] --> B[导出保留文字]");

    expect(svg).toMatch(/<(?:text|tspan)\b/i);
    expect(svg).not.toMatch(/<foreignObject\b/i);
  });
});

import { describe, expect, it, vi } from "vitest";

// mermaid 是浏览器库,默认(node)测试环境直接 import 会出问题;mock 掉只测纯函数。
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn(), render: vi.fn() },
}));

import { normalizeMermaidQuotes } from "./mermaidRender";

describe("normalizeMermaidQuotes — mermaid 引号兜底(只在原文parse失败时才用)", () => {
  it("弯双引号/全角双引号/书名号 → 半角直引号", () => {
    expect(normalizeMermaidQuotes('A[“完成”]')).toBe('A["完成"]');
    expect(normalizeMermaidQuotes("A[＂x＂]")).toBe('A["x"]');
    expect(normalizeMermaidQuotes('A[„x‟]')).toBe('A["x"]');
    expect(normalizeMermaidQuotes("A[«书名»]")).toBe('A["书名"]');
    expect(normalizeMermaidQuotes("A[〝x〞]")).toBe('A["x"]');
  });

  it("弯单引号 → 半角单引号", () => {
    expect(normalizeMermaidQuotes("A[‘x’]")).toBe("A['x']");
    expect(normalizeMermaidQuotes("A[‚x‛]")).toBe("A['x']");
  });

  it("已是半角的标准源 + 中文正文不被破坏(括号不动)", () => {
    const src = 'flowchart TD\n  A["数据(实时)"] --> B[结束]';
    expect(normalizeMermaidQuotes(src)).toBe(src);
    expect(normalizeMermaidQuotes("flowchart TD\n  A --> B")).toBe(
      "flowchart TD\n  A --> B",
    );
  });

  it("全角括号保持不变(交给prompt约束,代码不误伤标签正文)", () => {
    expect(normalizeMermaidQuotes("A[数据（实时）]")).toBe("A[数据（实时）]");
  });
});

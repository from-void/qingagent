// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// 回归:mermaid 渲染失败会往 document.body 注入「Syntax error」错误图(炸弹)且不清理,
// 全宽挂页面底部把布局顶变形。renderMermaid 必须在 finally 清掉遗留元素,失败时也不残留。
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    // 模拟 mermaid:渲染时往 body 注入一个带该 id 的元素(失败路径),然后抛错
    render: vi.fn(async (id: string) => {
      const el = document.createElement("div");
      el.id = id;
      el.textContent = "Syntax error in text";
      document.body.appendChild(el);
      throw new Error("Syntax error in text");
    }),
  },
}));

import { renderMermaid } from "../../components/mermaidRender";

describe("renderMermaid 失败清理", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("渲染失败抛错,且不在 body 残留 mermaid 错误孤儿元素", async () => {
    await expect(renderMermaid("flowchart TD\n A--bad")).rejects.toThrow();
    // body 里不得残留任何 mermaid 注入的元素(炸弹)
    const leftover = [...document.body.querySelectorAll("div")].filter((e) =>
      (e.textContent ?? "").includes("Syntax error"),
    );
    expect(leftover).toHaveLength(0);
  });
});

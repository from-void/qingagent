import { describe, expect, it } from "vitest";
import { renderInsertDOM } from "./patchDecorations";
import { viewSectionsToHtml } from "./viewDocHtml";

describe("审阅装饰 HTML 安全", () => {
  it("非法链接协议只保留文字，不生成 anchor", () => {
    const rendered = renderInsertDOM("点我", [
      { type: "link", attrs: { href: "javascript:alert(1)" } },
    ] as never);

    expect(rendered.textContent).toBe("点我");
    expect(rendered.querySelector("a")).toBeNull();
    expect(rendered.querySelector("[href]")).toBeNull();
  });

  it("合法 HTTPS 链接照常生成 anchor", () => {
    const rendered = renderInsertDOM("查看文档", [
      { type: "link", attrs: { href: "https://example.com/doc" } },
    ] as never);

    const anchor = rendered.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/doc");
    expect(anchor?.textContent).toBe("查看文档");
  });

  it("脚注属性中的双引号不会溢出为事件属性", () => {
    const id = 'fn-1" onclick="globalThis.__footnoteIdInjected = 1';
    const note = '来源" onmouseover="globalThis.__footnoteNoteInjected = 1';
    const html = viewSectionsToHtml([{
      kind: "p",
      spans: [{ kind: "footnote", id, note }],
    }]);
    const container = document.createElement("div");
    container.innerHTML = html;

    const reference = container.querySelector("sup");
    expect(reference?.getAttribute("data-footnote-id")).toBe(id);
    expect(reference?.getAttribute("data-footnote-note")).toBe(note);
    expect(reference?.hasAttribute("onclick")).toBe(false);
    expect(reference?.hasAttribute("onmouseover")).toBe(false);
  });
});

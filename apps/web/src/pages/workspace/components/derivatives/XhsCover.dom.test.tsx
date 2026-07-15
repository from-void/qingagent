import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XhsCover, XHS_COVER_TEMPLATES } from "./XhsCover";

describe("小红书封面模板", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); document.head.querySelectorAll("[data-xhs-cover-font]").forEach((node) => node.remove()); });

  it("五款模板逐款渲染关键结构，并为超长标题启用两级缩字号", async () => {
    const selectors = ["mark", ".xhs-cover-eyebrow", ".xhs-cover-seal", ".xhs-cover-number", ".xhs-cover-note"];
    for (const [index, template] of XHS_COVER_TEMPLATES.entries()) {
      await act(async () => root.render(<XhsCover title="十八字标题用于验证封面自动缩字号效果刚好" template={template} onTemplateChange={vi.fn()}/>));
      expect(host.querySelector(".xhs-cover")?.getAttribute("data-cover-template")).toBe(template);
      expect(host.querySelector(".xhs-cover")?.getAttribute("data-title-size")).toBe("compact");
      expect(host.querySelector(selectors[index]!)).not.toBeNull();
    }
  });

  it("hover 控件包含循环箭头与圆点，选择立即回调", async () => {
    const change = vi.fn();
    await act(async () => root.render(<XhsCover title="六字封面标题" template="poster" onTemplateChange={change}/>));
    expect(host.querySelectorAll(".xhs-cover-arrow")).toHaveLength(2);
    expect(host.querySelectorAll(".xhs-cover-dots button")).toHaveLength(5);
    await act(async () => (host.querySelector('[aria-label="上一款封面"]') as HTMLButtonElement).click());
    expect(change).toHaveBeenLastCalledWith("note");
    await act(async () => (host.querySelector('[aria-label="下一款封面"]') as HTMLButtonElement).click());
    expect(change).toHaveBeenLastCalledWith("magazine");
  });

  it("仅选中得意黑/文楷模板时注入本地 @font-face", async () => {
    await act(async () => root.render(<XhsCover title="杂志封面" template="magazine" onTemplateChange={vi.fn()}/>));
    expect(document.head.querySelectorAll("[data-xhs-cover-font]")).toHaveLength(0);
    await act(async () => root.render(<XhsCover title="大字报封面" template="poster" onTemplateChange={vi.fn()}/>));
    expect(document.head.querySelector('[data-xhs-cover-font="poster"]')?.textContent).toContain("/fonts/SmileySans-Oblique.woff2");
    await act(async () => root.render(<XhsCover title="文楷封面" template="wenkai" onTemplateChange={vi.fn()}/>));
    expect(document.head.querySelector('[data-xhs-cover-font="wenkai"]')?.textContent).toContain("/fonts/LXGWWenKai-Regular.woff2");
  });
});

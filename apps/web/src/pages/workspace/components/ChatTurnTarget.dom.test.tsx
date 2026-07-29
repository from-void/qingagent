// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurnTarget } from "./ChatTurnTarget";

describe("ChatTurnTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("在输入区明确显示当前指令作用的文档，并随 Tab 目标更新", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<ChatTurnTarget label="主稿 · 《一条老街的三种活法》" />);
    });
    const target = host.querySelector<HTMLElement>(
      '[data-wf="ChatTurnTarget"]',
    );
    expect(target?.getAttribute("role")).toBe("status");
    expect(target?.textContent).toContain("指令目标");
    expect(target?.textContent).toContain("主稿 · 《一条老街的三种活法》");

    await act(async () => {
      root.render(<ChatTurnTarget label="公众号稿 · 故事叙事文" />);
    });
    expect(target?.textContent).toContain("公众号稿 · 故事叙事文");
    expect(target?.title).toBe(
      "当前指令作用于：公众号稿 · 故事叙事文",
    );

    await act(async () => root.unmount());
  });
});

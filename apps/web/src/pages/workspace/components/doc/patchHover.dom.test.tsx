// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PatchStatePopup, renderOriginalDiff } from "./patchHover";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
  });
}

describe("patchHover 卡片:禁二次 diff(★裁决 260710)", () => {
  it("覆盖卡原文整体划删除线,无未划线段(即便新旧共享单字也不再逐字 diff)", async () => {
    // 旧行为:对 before/after 裸字符 LCS,把共享的"很"渲成不划线 same 段(花体)。
    // 新行为:core 已拆干净,卡片把整段原文一律划删除线。
    await render(
      <PatchStatePopup state="replace" index={1} original={renderOriginalDiff("天很蓝")} patchId="p1" />,
    );
    const removed = host?.querySelectorAll(".patch-popup-removed-text");
    expect(removed?.length).toBe(1);
    expect(removed?.[0]?.textContent).toBe("天很蓝");
    // 关键:没有任何"未划线"(same/muted)段
    expect(host?.querySelectorAll(".patch-popup-muted").length).toBe(0);
  });

  it("删除卡原文整体划删除线", async () => {
    await render(
      <PatchStatePopup state="delete" index={2} original={renderOriginalDiff("整段删掉的文字")} patchId="p2" />,
    );
    expect(host?.querySelector(".patch-popup-removed-text")?.textContent).toBe("整段删掉的文字");
    expect(host?.querySelectorAll(".patch-popup-muted").length).toBe(0);
  });

  it("新增卡不显示原文，只展示新增内容摘要", async () => {
    await render(
      <PatchStatePopup
        state="insert"
        index={3}
        original={renderOriginalDiff("")}
        added="新增的安全提示"
        patchId="p3"
      />,
    );
    expect(host?.querySelector(".patch-popup-added")?.textContent).toContain("新增的安全提示");
    expect(host?.querySelector(".patch-popup-removed-text")).toBeNull();
    expect(Array.from(host?.querySelectorAll(".patch-popup-label") ?? [], (node) => node.textContent)).not.toContain("原文");
  });
});

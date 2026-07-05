import { describe, expect, it } from "vitest";
import type { Node, Viewport } from "@xyflow/react";

import { getFloatingPosition } from "../components/diagram/GraphDiagramView";

// 回归:工具栏二级下拉(popover)在"above"时会再向上展开约一屏,
// 靠近编辑器顶部的元素若仅按"工具栏自身高度"判定 above,会让下拉越出视口被裁切。
// 修复后:顶部 headroom 不足以容纳 工具栏+popover 时必须翻到 "below"(下拉改向下展开)。
const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const CANVAS = { width: 1200, height: 800, left: 0, top: 0 };

function nodeAt(y: number): Node {
  return { id: "A", position: { x: 200, y }, data: {} } as Node;
}

describe("getFloatingPosition 工具栏/下拉放置", () => {
  it("元素贴近顶部(上方空间不足以放下 popover)时翻到 below", () => {
    const pos = getFloatingPosition({
      selectedNodeId: "A",
      selectedEdge: undefined,
      nodes: [nodeAt(100)],
      viewport: VIEWPORT,
      canvasFrame: CANVAS,
    });
    expect(pos).not.toBeNull();
    expect(pos?.placement).toBe("below");
  });

  it("元素上方有充足空间时仍默认 above", () => {
    const pos = getFloatingPosition({
      selectedNodeId: "A",
      selectedEdge: undefined,
      nodes: [nodeAt(400)],
      viewport: VIEWPORT,
      canvasFrame: CANVAS,
    });
    expect(pos?.placement).toBe("above");
  });
});

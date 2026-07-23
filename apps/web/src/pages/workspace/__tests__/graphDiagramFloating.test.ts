import { describe, expect, it } from "vitest";
import type { Node, Viewport } from "@xyflow/react";

import { computePreviewFitViewport, getFloatingPosition, graphNodePositionKey } from "../components/diagram/GraphDiagramView";

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

describe("graphNodePositionKey", () => {
  it("坐标未铺开与铺开后生成不同的键(用于判断 React Flow 是否已采纳 ELK 坐标)", () => {
    const clustered = graphNodePositionKey([
      { id: "A", position: { x: 40, y: 40 } },
      { id: "B", position: { x: 40, y: 40 } },
    ]);
    const spread = graphNodePositionKey([
      { id: "A", position: { x: 12, y: 24 } },
      { id: "B", position: { x: 792, y: 24 } },
    ]);
    expect(clustered).not.toBe(spread);
    // 与元素顺序无关(内部排序)
    expect(graphNodePositionKey([
      { id: "B", position: { x: 792, y: 24 } },
      { id: "A", position: { x: 12, y: 24 } },
    ])).toBe(spread);
  });
});

describe("computePreviewFitViewport", () => {
  const padding = 0.15;
  it("正常宽图保持原有 fit 比例并居中", () => {
    // 940×84 的宽图铺进 652×260 画布
    const vp = computePreviewFitViewport({ x: 12, y: 12, width: 940, height: 84 }, 652, 260, padding);
    expect(vp).not.toBeNull();
    expect(vp!.zoom).toBeCloseTo((652 * (1 - padding * 2)) / 940, 5);
    // 缩放后的内容宽度 <= 可用宽度
    expect(940 * vp!.zoom).toBeLessThanOrEqual(652 * (1 - padding * 2) + 0.001);
    // 包围盒中心被平移到画布中心
    expect(vp!.x + (12 + 940 / 2) * vp!.zoom).toBeCloseTo(652 / 2, 5);
    expect(vp!.y + (12 + 84 / 2) * vp!.zoom).toBeCloseTo(260 / 2, 5);
  });
  it("超大图钳制到预览下限并保持居中以供平移浏览", () => {
    const vp = computePreviewFitViewport({ x: 12, y: 12, width: 30_000, height: 10_000 }, 652, 260, padding);
    expect(vp).not.toBeNull();
    expect(vp!.zoom).toBe(0.1);
    expect(vp!.x + (12 + 30_000 / 2) * vp!.zoom).toBeCloseTo(652 / 2, 5);
    expect(vp!.y + (12 + 10_000 / 2) * vp!.zoom).toBeCloseTo(260 / 2, 5);
  });
  it("小图不放大(zoom 封顶到 1)", () => {
    const vp = computePreviewFitViewport({ x: 40, y: 40, width: 160, height: 72 }, 652, 260, padding);
    expect(vp!.zoom).toBe(1);
  });
  it("尺寸非法返回 null(容器未量到 / 空包围盒)", () => {
    expect(computePreviewFitViewport({ x: 0, y: 0, width: 0, height: 0 }, 652, 260, padding)).toBeNull();
    expect(computePreviewFitViewport({ x: 0, y: 0, width: 160, height: 72 }, 0, 0, padding)).toBeNull();
  });
});

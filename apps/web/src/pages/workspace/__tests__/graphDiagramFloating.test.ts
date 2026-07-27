import { describe, expect, it } from "vitest";
import type { Node, Viewport } from "@xyflow/react";

import {
  computePreviewFitViewport,
  deepestSubgraphContainingRect,
  getFloatingPosition,
  graphNodePositionKey,
  quickAddGhostGeometry,
  resolveNewNodePlacement,
  visibleFlowRect,
} from "../components/diagram/GraphDiagramView";

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

  it("元素上方有充足空间时仍默认 above,且常态贴近元素", () => {
    const pos = getFloatingPosition({
      selectedNodeId: "A",
      selectedEdge: undefined,
      nodes: [nodeAt(400)],
      viewport: VIEWPORT,
      canvasFrame: CANVAS,
    });
    expect(pos?.placement).toBe("above");
    // 常态只让开外侧圆点/加号那一圈(44px),不再为偶发的幽灵预览永久留 116px。
    expect(pos?.top).toBe(356);
  });

  it("把手悬停铺出幽灵预览时工具栏临时让位", () => {
    const pos = getFloatingPosition({
      selectedNodeId: "A",
      selectedEdge: undefined,
      nodes: [nodeAt(400)],
      viewport: VIEWPORT,
      canvasFrame: CANVAS,
      handlePreviewActive: true,
    });
    expect(pos?.placement).toBe("above");
    expect(pos?.top).toBe(284);
  });
});

describe("deepestSubgraphContainingRect 拖拽入区判定", () => {
  const outer = { id: "Outer", rect: { x: 0, y: 0, width: 400, height: 300 }, depth: 0 };
  const inner = { id: "Inner", rect: { x: 40, y: 40, width: 200, height: 160 }, depth: 1 };

  it("整块被包住才算进区,中心点在里但探出边界不算", () => {
    expect(deepestSubgraphContainingRect({ x: 60, y: 60, width: 160, height: 72 }, [outer, inner])).toBe("Inner");
    // 中心点(370,120)落在 Outer 内,但右边探出 Outer 边界 → 不收
    expect(deepestSubgraphContainingRect({ x: 290, y: 84, width: 160, height: 72 }, [outer, inner])).toBeNull();
  });

  it("同时被多层包住时取最深的一层", () => {
    expect(deepestSubgraphContainingRect({ x: 50, y: 50, width: 100, height: 60 }, [outer, inner])).toBe("Inner");
    // 只在 Outer 里(避开 Inner 的范围)
    expect(deepestSubgraphContainingRect({ x: 260, y: 210, width: 100, height: 60 }, [outer, inner])).toBe("Outer");
  });

  it("贴边(边界重合)算包含", () => {
    expect(deepestSubgraphContainingRect({ x: 0, y: 0, width: 400, height: 300 }, [outer])).toBe("Outer");
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

describe("visibleFlowRect / resolveNewNodePlacement 新增节点落点", () => {
  const size = { width: 160, height: 72 };

  it("视口变换换算成流坐标可视矩形", () => {
    // 画布 800×600、放大 2 倍、内容左移:可视流区域是 400×300,原点在 (100, 50)
    const rect = visibleFlowRect({ x: -200, y: -100, zoom: 2 }, { width: 800, height: 600 });
    expect(rect).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it("空画布落在视口中心且完整可见", () => {
    const visible = { x: 0, y: 0, width: 800, height: 600 };
    const placement = resolveNewNodePlacement({ visible, occupied: [], size });
    expect(placement).toEqual({ x: 320, y: 264 });
    expect(placement.x).toBeGreaterThanOrEqual(visible.x);
    expect(placement.x + size.width).toBeLessThanOrEqual(visible.x + visible.width);
  });

  it("中心被占时自动让开,不与既有节点重叠", () => {
    const visible = { x: 0, y: 0, width: 900, height: 700 };
    const occupied = [{ x: 320, y: 314, width: 160, height: 72 }];
    const placement = resolveNewNodePlacement({ visible, occupied, size });
    const rect = { ...placement, ...size };
    const intersects = (a: typeof rect, b: typeof rect) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    expect(intersects(rect, occupied[0]!)).toBe(false);
    expect(rect.x).toBeGreaterThanOrEqual(visible.x);
    expect(rect.y + rect.height).toBeLessThanOrEqual(visible.y + visible.height);
  });

  it("有选中节点时优先落在它右侧的常规位(与把手快速新增同一套间距)", () => {
    const visible = { x: 0, y: 0, width: 1200, height: 800 };
    const anchor = { x: 100, y: 200, width: 160, height: 72 };
    const placement = resolveNewNodePlacement({ visible, occupied: [anchor], size, anchor });
    const expected = quickAddGhostGeometry(anchor.width, anchor.height, "r").offset;
    expect(placement).toEqual({ x: anchor.x + expected.x, y: anchor.y + expected.y });
  });

  it("视口很挤(右侧放不下)时改落其他方位,始终完整可见", () => {
    const visible = { x: 0, y: 0, width: 420, height: 640 };
    const anchor = { x: 40, y: 40, width: 160, height: 72 };
    const placement = resolveNewNodePlacement({ visible, occupied: [anchor], size, anchor });
    expect(placement.x).toBeGreaterThanOrEqual(visible.x);
    expect(placement.x + size.width).toBeLessThanOrEqual(visible.x + visible.width);
    expect(placement.y).toBeGreaterThanOrEqual(visible.y);
    expect(placement.y + size.height).toBeLessThanOrEqual(visible.y + visible.height);
  });
});

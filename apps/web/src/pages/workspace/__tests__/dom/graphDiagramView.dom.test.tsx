// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node, Viewport } from "@xyflow/react";
import { parseDiagram, type FlowGraph, type MindmapTree } from "@qingagent/diagram-engine";
import { ToastProvider } from "../../../../system/ToastProvider";
import { DiagramRenderer } from "../../components/diagram/DiagramRenderer";
const graphDiagramCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/diagram/graphDiagram.css"), "utf8");
const graphDiagramSource = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/diagram/GraphDiagramView.tsx"), "utf8");
const diagramViewCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/DiagramView.css"), "utf8");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    const rect = target.getBoundingClientRect();
    const entry = {
      target,
      contentRect: rect,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }

  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22 = 1;

  constructor(transform?: string) {
    if (!transform || transform === "none") return;
    const matrix = transform.match(/matrix\(([^)]+)\)/);
    if (matrix) {
      const values = matrix[1]!.split(",").map((item) => Number(item.trim()));
      this.m22 = Number.isFinite(values[3]) ? values[3]! : 1;
      return;
    }
    const scale = transform.match(/scale\(([^)]+)\)/);
    if (scale) {
      const value = Number(scale[1]);
      this.m22 = Number.isFinite(value) ? value : 1;
    }
  }
}

function polyfillLayout() {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
  (window as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyStub }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  const raf = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  const caf = (id: number) => window.clearTimeout(id);
  (globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame ??= raf as typeof requestAnimationFrame;
  (globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame ??= caf as typeof cancelAnimationFrame;
  const rect = (width: number, height: number) => ({ top: 0, left: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains("react-flow__handle")) return rect(10, 10);
    if (this instanceof HTMLElement && this.classList.contains("react-flow__node")) return rect(180, 72);
    return rect(900, 600);
  } as unknown as () => DOMRect;
  Element.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value() {
      return rect(80, 20);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return this.classList.contains("react-flow__handle") ? 10 : 180;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.classList.contains("react-flow__handle") ? 10 : 72;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList.contains("react-flow__handle") ? 10 : 900;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("react-flow__handle") ? 10 : 600;
    },
  });
}
polyfillLayout();

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function waitMs(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForSelector(selector: string, rootEl: ParentNode = container!): Promise<Element> {
  for (let i = 0; i < 60; i += 1) {
    const el = rootEl.querySelector(selector);
    if (el) return el;
    await flush();
  }
  throw new Error(`selector not found: ${selector}`);
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mouseDown(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mouseEvent(el: Element, type: "mouseover" | "mousemove" | "mouseout") {
  await act(async () => {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      relatedTarget: type === "mouseout" ? document.body : null,
    }));
  });
  await flush();
}

async function keyDown(el: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

async function keyUp(el: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

// 空白画布上的一次完整点击手势。开启框选(selectionOnDrag)后 React Flow 不再直接吃 click,
// 改由 pointerdown→pointerup 收尾判定"没拖动=空点",故测试必须走完整指针序列。
async function panePointerClick(pane: Element) {
  const pointerEvent = (type: string) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(event, "isPrimary", { value: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event;
  };
  await act(async () => {
    pane.dispatchEvent(pointerEvent("pointerdown"));
    pane.dispatchEvent(pointerEvent("pointerup"));
  });
  await flush();
}

async function dispatchGraphTestAction(el: Element, detail: unknown) {
  await act(async () => {
    el.dispatchEvent(new CustomEvent("graph-diagram-test-action", { bubbles: true, detail }));
  });
  await flush();
}

async function setInputValue(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function setEditableText(el: HTMLElement, value: string) {
  await act(async () => {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await flush();
}

async function pressEnter(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
}

async function openEditor(): Promise<HTMLElement> {
  return openEditorAt(0);
}

async function openEditorAt(index: number): Promise<HTMLElement> {
  const buttons = Array.from(container!.querySelectorAll(".test-open-visual"));
  const editButton = buttons[index];
  if (!editButton) throw new Error(`open visual button not found: ${index}`);
  await click(editButton);
  return waitForSelector(".graph-diagram-editor", document.body) as Promise<HTMLElement>;
}

function EditableDiagramHarness({
  source,
  initialOverlay = null,
  onSourceChange,
  onOverlayChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  source: string;
  initialOverlay?: Parameters<typeof DiagramRenderer>[0]["overlay"];
  onSourceChange?: (source: string) => void;
  onOverlayChange?: Parameters<typeof DiagramRenderer>[0]["onOverlayChange"];
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  canUndo?: boolean;
  canRedo?: boolean;
}) {
  const [openVisualSignal, setOpenVisualSignal] = useState(0);
  const [overlay, setOverlay] = useState<Parameters<typeof DiagramRenderer>[0]["overlay"]>(initialOverlay);
  return (
    <>
      <button type="button" className="test-open-visual" onClick={() => setOpenVisualSignal((value) => value + 1)}>
        打开可视化
      </button>
      <DiagramRenderer
        source={source}
        overlay={overlay}
        readOnly={false}
        openVisualSignal={openVisualSignal}
        onSourceChange={onSourceChange}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onOverlayChange={(nextOverlay) => {
          setOverlay(nextOverlay);
          onOverlayChange?.(nextOverlay);
        }}
      />
    </>
  );
}

function findButton(text: string, rootEl: ParentNode = document.body): HTMLButtonElement {
  const button = Array.from(rootEl.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function findToolbarButton(label: string, rootEl: ParentNode = document.body): HTMLButtonElement {
  const button = Array.from(rootEl.querySelectorAll<HTMLButtonElement>(".graph-diagram-toolbar__button"))
    .find((item) => (item.getAttribute("aria-label") ?? item.getAttribute("title") ?? item.textContent ?? "").trim().startsWith(label));
  if (!button) throw new Error(`toolbar button not found: ${label}`);
  return button;
}

function findMenuButton(label: string, rootEl: ParentNode = document.body): HTMLButtonElement {
  const button = Array.from(rootEl.querySelectorAll<HTMLButtonElement>(".graph-diagram-menu-item"))
    .find((item) => item.textContent?.trim().startsWith(label));
  if (!button) throw new Error(`menu button not found: ${label}`);
  return button;
}

// 分区「解散分区」已改为「…更多」溢出菜单里的红字菜单项(I10)。
async function dissolveSubgraphViaMenu(rootEl: ParentNode = document.body) {
  await click(findToolbarButton("…更多", rootEl));
  const menu = await waitForSelector("[aria-label='分区更多操作']", rootEl);
  const item = findMenuButton("解散分区", menu);
  expect(item.classList.contains("is-danger")).toBe(true);
  await click(item);
}

async function openToolbarMenu(label: string, rootEl: ParentNode = document.body) {
  await click(findToolbarButton(label, rootEl));
  return waitForSelector(".graph-diagram-popover", rootEl);
}

function findInput(label: string, rootEl: ParentNode = document.body): HTMLInputElement {
  const input = rootEl.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
  if (!input) throw new Error(`input not found: ${label}`);
  return input;
}

function findNode(text: string, rootEl: ParentNode): HTMLElement {
  const node = Array.from(rootEl.querySelectorAll<HTMLElement>(".react-flow__node")).find((item) => item.textContent?.includes(text));
  if (!node) throw new Error(`node not found: ${text}`);
  return node;
}

function parseTranslate(transform: string): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);
  if (!match) throw new Error(`unsupported transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function flattenMindmap(root: MindmapTree["root"]): MindmapTree["root"][] {
  const out: MindmapTree["root"][] = [];
  const walk = (node: MindmapTree["root"]) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.querySelectorAll(".graph-diagram-editor, .graph-diagram-viewer").forEach((el) => el.remove());
  vi.restoreAllMocks();
});

function warningText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

function reactFlowStrictHandleLookupWarning({
  edgeId,
  sourceHandles,
  targetHandles,
  sourceHandle,
  targetHandle,
}: {
  edgeId: string;
  sourceHandles: string[];
  targetHandles: string[];
  sourceHandle: string;
  targetHandle: string;
}): string | null {
  // 对齐 @xyflow/system getEdgePosition 的 strict 查找:sourceHandle 查 source 集合,
  // targetHandle 查 target 集合。
  if (!sourceHandles.includes(sourceHandle)) return `Couldn't create edge for source handle id: "${sourceHandle}", edge id: ${edgeId}.`;
  if (!targetHandles.includes(targetHandle)) return `Couldn't create edge for target handle id: "${targetHandle}", edge id: ${edgeId}.`;
  return null;
}

describe("GraphDiagramView", () => {
  const cases = [
    ["flowchart", `flowchart TD
  A[开始] --> B[结束]
`],
    ["state", `stateDiagram-v2
  state "打开" as Open
  Open --> Closed : close
`],
    ["er", `erDiagram
  CUSTOMER ||--o{ ORDER : places
`],
    ["class", `classDiagram
  Animal <|-- Duck
`],
    ["mindmap", `mindmap
  root
    child
`],
  ] as const;

  it.each(cases)("渲染 %s 预览图并带 overlay", async (_name, source) => {
    await render(
      <DiagramRenderer
        source={source}
        overlay={{ positions: { A: { x: 12, y: 24 } } }}
        readOnly
      />,
    );
    await waitForSelector(".graph-diagram");
    expect(container?.textContent).toMatch(/开始|打开|CUSTOMER|Animal|root/);
    expect(container?.querySelector(".graph-diagram-edit-entry")).toBeNull();
    expect(container?.querySelector("select")).toBeNull();
    expect(container?.querySelector(".react-flow__attribution")).toBeNull();
    // jsdom 不提供可靠的真实布局几何；这里只守住防空白的 flex 定高链契约。
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas \.react-flow\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*min-height:\s*0;[^}]*width:\s*100%;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--preview\s*\{[^}]*border:\s*0;/s);
    expect(container?.querySelector(".react-flow__controls")).toBeNull();
  });

  it("单行分号声明与链式边渲染出全部 React Flow 节点", async () => {
    await render(<DiagramRenderer source="graph TD; A-->B-->D" readOnly />);
    await waitForSelector(".graph-diagram");
    expect(container?.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(container?.querySelectorAll(".react-flow__edge")).toHaveLength(2);
    expect(container?.querySelector(".graph-diagram-export svg")).not.toBeNull();
  });

  it("未闭合 flowchart 节点仍显示解析错误而非空画布", async () => {
    await render(<DiagramRenderer source="graph TD; A[未闭合 --> B" readOnly />);
    await waitForSelector(".pm-diagram-error");
    expect(container?.textContent).toContain("节点 A 的形状未闭合");
    expect(container?.querySelector(".graph-diagram")).toBeNull();
    expect(container?.querySelector(".react-flow__node")).toBeNull();
  });

  it("交互图外部工具栏提供真实缩放，可编辑全屏直进编辑器，纯 SVG 不展示缩放", async () => {
    const onAlignChange = vi.fn();
    const onDrawioFullscreen = vi.fn();
    const source = `flowchart TD
  A[开始] --> B[结束]
`;
    await render(
      <DiagramRenderer
        source={source}
        readOnly={false}
        align="center"
        onAlignChange={onAlignChange}
        onSourceChange={() => {}}
      />,
    );
    const editableToolbar = await waitForSelector("[aria-label='图表画布工具栏']", container!);
    expect(editableToolbar.classList.contains("pm-image-toolbar")).toBe(true);
    expect(editableToolbar.classList.contains("pm-image-chrome")).toBe(true);
    const editableButtons = Array.from(editableToolbar.querySelectorAll<HTMLButtonElement>(".pm-image-tool"));
    // 缩放钮已改图标(I13),文案语义只留在 aria-label/title。
    expect(editableButtons.map((button) => button.getAttribute("title"))).toEqual([
      "左对齐",
      "居中",
      "右对齐",
      "放大图表",
      "缩小图表",
      "全屏查看",
    ]);
    expect(editableToolbar.querySelectorAll(".pm-image-tool--icon .pm-image-tool-icon")).toHaveLength(2);
    expect(editableToolbar.textContent).not.toContain("放大");
    expect(editableToolbar.textContent).not.toContain("缩小");
    expect(editableButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "左对齐",
      "居中",
      "右对齐",
      "放大图表",
      "缩小图表",
      "全屏查看",
    ]);
    expect(editableToolbar.querySelector(".pm-diagram-tool")).toBeNull();
    expect(editableToolbar.textContent).not.toContain("新增分区");
    expect(editableToolbar.textContent).not.toContain("适配视图");
    await mouseDown(editableToolbar.querySelector("[aria-label='右对齐']")!);
    expect(onAlignChange).toHaveBeenCalledWith("right");
    const viewport = container!.querySelector<HTMLElement>(".react-flow__viewport")!;
    const beforeZoom = viewport.style.transform;
    await mouseDown(editableToolbar.querySelector("[aria-label='放大图表']")!);
    expect(viewport.style.transform).not.toBe(beforeZoom);
    await mouseDown(editableToolbar.querySelector("[aria-label='全屏查看']")!);
    const editableEditor = await waitForSelector(".graph-diagram-editor", document.body);
    expect(editableEditor.querySelector("[aria-label='画布视图控件']")).not.toBeNull();
    expect(document.body.querySelector(".graph-diagram-viewer")).toBeNull();
    await click(findButton("✕", editableEditor));

    await act(async () => {
      root!.render(<DiagramRenderer source={source} readOnly />);
    });
    await flush();
    const readOnlyToolbar = await waitForSelector("[aria-label='图表画布工具栏']", container!);
    const readOnlyButtons = Array.from(readOnlyToolbar.querySelectorAll<HTMLButtonElement>(".pm-image-tool"));
    expect(readOnlyButtons.map((button) => button.textContent?.trim())).toEqual(["", "", "全屏"]);
    expect(readOnlyButtons.map((button) => button.getAttribute("aria-label"))).toEqual(["放大图表", "缩小图表", "全屏查看"]);

    await act(async () => {
      root!.render(
        <DiagramRenderer
          source="sequenceDiagram\n  Alice->>Bob: 你好"
          cachedSvg="<svg xmlns='http://www.w3.org/2000/svg'><text>你好</text></svg>"
          readOnly={false}
        />,
      );
    });
    await flush();
    const svgToolbar = await waitForSelector("[aria-label='图表操作']", container!);
    expect(svgToolbar.querySelector("[aria-label='放大图表']")).toBeNull();
    expect(svgToolbar.querySelector("[aria-label='缩小图表']")).toBeNull();

    await act(async () => {
      root!.render(
        <DiagramRenderer
          source="<mxGraphModel><root><mxCell id='0'/><mxCell id='1' parent='0'/><mxCell id='2' value='节点' vertex='1' parent='1'><mxGeometry width='120' height='60' as='geometry'/></mxCell></root></mxGraphModel>"
          cachedSvg="<svg xmlns='http://www.w3.org/2000/svg'><text>drawio</text></svg>"
          lang="drawio"
          readOnly={false}
          onFullscreen={onDrawioFullscreen}
        />,
      );
    });
    await flush();
    const drawioToolbar = await waitForSelector("[aria-label='图表操作']", container!);
    await mouseDown(drawioToolbar.querySelector("[aria-label='全屏查看图表']")!);
    expect(onDrawioFullscreen).toHaveBeenCalledTimes(1);
  });

  it("只读态全屏按钮打开纯查看层，Esc/关闭可退出且不出现编辑把手", async () => {
    await render(
      <DiagramRenderer
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        readOnly
      />,
    );
    const toolbar = await waitForSelector("[aria-label='图表画布工具栏']", container!);
    await mouseDown(toolbar.querySelector("[aria-label='全屏查看']")!);
    const viewer = await waitForSelector(".graph-diagram-viewer", document.body) as HTMLElement;
    expect(viewer.getAttribute("aria-label")).toBe("图表全屏预览");
    expect(viewer.querySelector(".graph-diagram-handle-add")).toBeNull();
    expect(viewer.querySelector(".react-flow__controls")).toBeNull();
    expect(viewer.querySelector("[aria-label='移动画布']")).not.toBeNull();
    expect(graphDiagramCss).toMatch(/\.graph-diagram,\s*\.graph-diagram-editor,\s*\.graph-diagram-viewer\s*\{/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--preview \.react-flow__handle\s*\{[^}]*display:\s*none;/s);
    await click(findButton("关闭", viewer));
    expect(document.body.querySelector(".graph-diagram-viewer")).toBeNull();
  });

  it("经典色板注入根变量,classDef 节点与 React Flow 连线使用同一解析结果", async () => {
    const source = `%%{init: {'theme':'base','themeVariables':{'mainBkg':'#FFFFFF','nodeBorder':'#5178C6','lineColor':'#BBBFC4','textColor':'#1F2329','clusterBkg':'#F0F4FC','clusterBorder':'#5178C6'}}}%%
flowchart LR
  A[开始] --> B[结束]
  classDef purple fill:#F8F5FF,stroke:#8569CB,stroke-width:2px,color:#31265C
  class A purple
`;
    await render(<DiagramRenderer source={source} readOnly />);
    const graph = await waitForSelector(".graph-diagram") as HTMLElement;
    const startNode = findNode("开始", graph);
    const endNode = findNode("结束", graph);
    const edgePath = await waitForSelector(".react-flow__edge-path", graph) as SVGPathElement;

    expect(graph.style.getPropertyValue("--graph-node-fill")).toBe("#FFFFFF");
    expect(graph.style.getPropertyValue("--graph-node-stroke")).toBe("#5178C6");
    expect(graph.style.getPropertyValue("--graph-line-color")).toBe("#BBBFC4");
    expect(startNode.style.getPropertyValue("--graph-node-fill")).toBe("#F8F5FF");
    expect(startNode.style.getPropertyValue("--graph-node-stroke")).toBe("#8569CB");
    expect(startNode.style.getPropertyValue("--graph-node-text")).toBe("#31265C");
    expect(endNode.style.getPropertyValue("--graph-node-stroke")).toBe("");
    expect(edgePath.style.stroke).toBe("#BBBFC4");
    expect(graph.outerHTML).not.toContain("#b08a3e");
  });

  it("保存态真实云原生 fixture 渲出 8 个分区,并与 graphToSvg 消费同一布局几何", async () => {
    const source = readFileSync(
      path.join(process.cwd(), "../../packages/diagram-engine/src/__tests__/fixtures-user-cloudnative.mmd"),
      "utf8",
    );
    await render(<DiagramRenderer source={source} readOnly />);
    const graph = await waitForSelector(".graph-diagram") as HTMLElement;
    const clusters = Array.from(graph.querySelectorAll<HTMLElement>(".graph-diagram-cluster"));
    expect(clusters).toHaveLength(8);
    expect(clusters.map((cluster) => cluster.dataset.clusterLabel)).toEqual(expect.arrayContaining([
      "用户终端层",
      "接入与安全层",
      "服务网关层",
      "业务中台",
      "数据与中间件层",
      "基础设施层",
      "监控可观测性",
      "核心业务流程",
    ]));
    expect(graph.style.getPropertyValue("--graph-cluster-fill")).toBe("#F0F4FC");
    expect(graph.style.getPropertyValue("--graph-cluster-stroke")).toBe("#5178C6");

    const svgClusters = new Map(
      Array.from(graph.querySelectorAll<SVGGElement>(".graph-diagram-export [data-cluster-id]"))
        .map((cluster) => [cluster.dataset.clusterId!, cluster]),
    );
    expect(svgClusters.size).toBe(8);
    for (const cluster of clusters) {
      const flowNode = cluster.closest<HTMLElement>(".react-flow__node");
      const clusterId = flowNode?.getAttribute("data-id");
      const svgCluster = clusterId ? svgClusters.get(clusterId) : undefined;
      expect(svgCluster).toBeTruthy();
      expect(flowNode?.style.width).toBe(`${svgCluster!.dataset.layoutWidth}px`);
      expect(flowNode?.style.height).toBe(`${svgCluster!.dataset.layoutHeight}px`);
    }
  });

  it("外部信号进入全屏后空选可加节点并回写 source", async () => {
    const onSourceChange = vi.fn();
    const onUndo = vi.fn(() => true);
    const onRedo = vi.fn(() => true);
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={false}
        canRedo
      />,
    );
    expect(container?.querySelector(".graph-diagram-edit-entry")).toBeNull();
    expect(container?.querySelector(".graph-diagram-context")).toBeNull();
    const editor = await openEditor();
    expect(document.body.querySelector("select")).toBeNull();
    expect(editor.textContent).not.toContain("点击节点或连线编辑");
    expect(editor.querySelector(".diagram-editor-chrome__title")?.textContent).toBe("Mermaid 编辑");
    const closeButton = editor.querySelector<HTMLButtonElement>(".diagram-editor-chrome__close");
    expect(closeButton?.textContent?.trim()).toBe("✕");
    expect(closeButton?.getAttribute("aria-label")).toBe("关闭");
    const bottomToolbar = editor.querySelector<HTMLElement>("[aria-label='图表编辑操作']");
    expect(bottomToolbar).not.toBeNull();
    expect(
      Array.from(bottomToolbar!.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool"))
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["新增节点", "新增分区"]);
    expect(bottomToolbar!.querySelector("[aria-label='解散分区']")).toBeNull();
    const viewportControls = editor.querySelector<HTMLElement>("[aria-label='画布视图控件']")!;
    expect(viewportControls.querySelector(".react-flow__controls")).toBeNull();
    expect(
      Array.from(viewportControls.querySelectorAll<HTMLButtonElement>("button"))
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["撤销", "重做", "移动画布", "缩小画布", "适配视图", "放大画布"]);
    expect(viewportControls.querySelector<HTMLButtonElement>("[aria-label='撤销']")?.disabled).toBe(true);
    const redoButton = viewportControls.querySelector<HTMLButtonElement>("[aria-label='重做']")!;
    expect(redoButton.disabled).toBe(false);
    await click(redoButton);
    expect(onRedo).toHaveBeenCalledTimes(1);
    // 编辑器默认不锁平移(空白左键=框选);手型钮/H/空格/右键才平移。
    const handButton = viewportControls.querySelector<HTMLButtonElement>("[aria-label='移动画布']")!;
    expect(handButton.getAttribute("aria-keyshortcuts")).toBe("H");
    expect(handButton.getAttribute("title")).toBeNull();
    const panTip = viewportControls.querySelector<HTMLElement>(".graph-diagram-pan-tip")!;
    expect(panTip.textContent?.replace(/\s+/g, "")).toBe("移动画布H·空格+拖拽·右键拖拽");
    expect(Array.from(panTip.querySelectorAll("kbd")).map((item) => item.textContent)).toEqual(["H", "空格"]);
    expect(handButton.getAttribute("aria-pressed")).toBe("false");
    await click(handButton);
    expect(handButton.getAttribute("aria-pressed")).toBe("true");
    await click(handButton);
    expect(handButton.getAttribute("aria-pressed")).toBe("false");
    const editCanvas = editor.querySelector<HTMLElement>(".graph-diagram-canvas--editor")!;
    await keyDown(document, { key: "h" });
    expect(handButton.getAttribute("aria-pressed")).toBe("true");
    expect(editCanvas.classList.contains("is-pan-enabled")).toBe(true);
    await keyDown(document, { key: "h" });
    expect(handButton.getAttribute("aria-pressed")).toBe("false");
    await keyDown(document, { key: " ", code: "Space" });
    expect(editCanvas.classList.contains("is-pan-enabled")).toBe(true);
    await keyUp(document, { key: " ", code: "Space" });
    expect(editCanvas.classList.contains("is-pan-enabled")).toBe(false);
    expect(graphDiagramCss).not.toContain(".graph-diagram-editor__topbar-actions");
    expect(graphDiagramCss).not.toContain(".graph-diagram-primary-action");
    await click(findButton("新增节点", editor));
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("新节点"));
  });

  it("编辑态节点默认显示四个圆点，悬停依次切换加号、箭头和幽灵预览", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    await waitForSelector(".graph-diagram-node-shell.can-rename", editor);
    const startNode = findNode("开始", editor);
    const handles = Array.from(startNode.querySelectorAll<HTMLElement>(".react-flow__handle"));
    expect(handles).toHaveLength(8);
    expect(handles.map((handle) => `${handle.classList.contains("target") ? "target" : "source"}:${handle.dataset.handleid}`).sort()).toEqual([
      "source:b",
      "source:l",
      "source:r",
      "source:t",
      "target:b",
      "target:l",
      "target:r",
      "target:t",
    ]);
    expect(handles.map((handle) => handle.dataset.handlepos).sort()).toEqual(["bottom", "bottom", "left", "left", "right", "right", "top", "top"]);
    expect(handles.every((handle) => handle.title === "拖拽到目标节点连线")).toBe(true);
    expect(handles.every((handle) => handle.getAttribute("aria-label")?.includes("连线"))).toBe(true);
    // Loose 模式下 source/target 把手重叠；松手实际命中 DOM 上层 source，
    // source 也必须允许作为连接终点，否则真机拖拽会被 React Flow 静默拒绝。
    expect(
      handles
        .filter((handle) => handle.classList.contains("source"))
        .every((handle) => handle.classList.contains("connectableend")),
    ).toBe(true);
    expect(editor.querySelectorAll(".react-flow__handle")).toHaveLength(16);
    expect(startNode.querySelectorAll(".graph-diagram-handle-dot")).toHaveLength(4);
    expect(startNode.querySelector(".graph-diagram-handle-add")).toBeNull();
    expect(startNode.querySelector(".graph-diagram-handle-ghost")).toBeNull();
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--editor \.react-flow__handle\s*\{[^}]*display:\s*block;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor .react-flow__node:hover .react-flow__handle");
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor .react-flow__node.is-selected .react-flow__handle");
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor.is-connecting .react-flow__handle.connectionindicator");
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--editor \.react-flow__node:hover \.react-flow__handle,[\s\S]*pointer-events:\s*auto;/);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-handle-slot\s*\{[^}]*pointer-events:\s*none;/s);
    expect(graphDiagramCss).not.toContain(".graph-diagram-handle-slot::before");
    expect(graphDiagramCss).toMatch(/\.graph-diagram .react-flow__handle,[\s\S]*cursor:\s*crosshair;/);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-handle-dot\s*\{[^}]*border-radius:\s*999px;[^}]*opacity:\s*0;/s);

    const rightHandle = handles.find((handle) => handle.classList.contains("source") && handle.dataset.handleid === "r")!;
    await mouseEvent(rightHandle, "mouseover");
    const addButton = startNode.querySelector<HTMLButtonElement>(".graph-diagram-handle-add--r");
    expect(addButton?.classList.contains("is-plus")).toBe(true);
    expect(addButton?.querySelector(".graph-diagram-canvas-tool-icon")).not.toBeNull();
    expect(startNode.querySelector(".graph-diagram-handle-ghost")).toBeNull();

    await waitMs(240);
    const previewButton = startNode.querySelector<HTMLButtonElement>(".graph-diagram-handle-add--r");
    expect(previewButton?.classList.contains("is-preview")).toBe(true);
    expect(previewButton?.querySelector(".graph-diagram-handle-direction-icon--r")).not.toBeNull();
    expect(startNode.querySelector(".graph-diagram-handle-ghost--r")).not.toBeNull();

    await mouseEvent(rightHandle, "mouseout");
    expect(startNode.querySelector(".graph-diagram-handle-add")).toBeNull();
    expect(startNode.querySelector(".graph-diagram-handle-ghost")).toBeNull();
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--preview \.react-flow__handle\s*\{[^}]*display:\s*none;/s);
    expect(graphDiagramCss).toContain(".graph-diagram[data-diagram-type] .react-flow__node:hover");
    expect(graphDiagramCss).toContain(".graph-diagram[data-diagram-type] .react-flow__edge:hover .react-flow__edge-path");
  });

  it("最小 handle fixture:只有 source handles 时,带 targetHandle 的 edge 会报 target handle warning", () => {
    const warning = reactFlowStrictHandleLookupWarning({
      edgeId: "e-a-b",
      sourceHandles: ["t", "b"],
      targetHandles: [],
      sourceHandle: "b",
      targetHandle: "t",
    });

    expect(warning).toBe('Couldn\'t create edge for target handle id: "t", edge id: e-a-b.');
  });

  it("编辑器渲染和拖动节点后不再出现 handle warning,edge path 跟随更新", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始] --> B[结束]
`}
        initialOverlay={{ positions: { A: { x: 0, y: 0 }, B: { x: 320, y: 0 } } }}
      />,
    );
    const editor = await openEditor();
    const edgePath = await waitForSelector(".react-flow__edge-path", editor) as SVGPathElement;
    const beforePath = edgePath.getAttribute("d");
    const startNode = findNode("开始", editor);
    const beforeTransform = startNode.style.transform;
    const before = parseTranslate(startNode.style.transform);

    await dispatchGraphTestAction(editor, { kind: "shiftDrag", nodeId: "A", dropPosition: { x: before.x + 140, y: before.y + 20 } });
    const movedPath = await waitForSelector(".react-flow__edge-path", editor) as SVGPathElement;

    expect(findNode("开始", editor).style.transform).not.toBe(beforeTransform);
    expect(movedPath.getAttribute("d")).not.toBe(beforePath);
    expect(warningText(warnSpy)).not.toContain("Couldn't create edge for");
  });

  it("默认 floating edge 按节点位置选最近连接面,overlay 固定 handle 优先", async () => {
    const source = `flowchart LR
  A[开始] --> B[结束]
`;
    await render(
      <DiagramRenderer
        source={source}
        overlay={{ positions: { A: { x: 0, y: 0 }, B: { x: 320, y: 0 } } }}
        readOnly
      />,
    );
    const floatingEdge = await waitForSelector(".react-flow__edge[data-floating-edge='true']", container!);
    expect(floatingEdge.getAttribute("data-source-handle")).toBe("r");
    expect(floatingEdge.getAttribute("data-target-handle")).toBe("l");

    const edgeId = (parseDiagram(source).model as FlowGraph).edges[0]!.id;
    await act(async () => {
      root!.render(
        <DiagramRenderer
          source={source}
          overlay={{
            positions: { A: { x: 0, y: 0 }, B: { x: 320, y: 0 } },
            edgeHandles: { [edgeId]: { sourceHandle: "b", targetHandle: "t" } },
          }}
          readOnly
        />,
      );
    });
    await flush();
    const fixedEdge = await waitForSelector(".react-flow__edge[data-floating-edge='false']", container!);
    expect(fixedEdge.getAttribute("data-source-handle")).toBe("b");
    expect(fixedEdge.getAttribute("data-target-handle")).toBe("t");
  });

  it("点击 handle 上的加号会新建右侧连接节点并写入 edgeHandles overlay", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始] --> B[结束]
`}
        initialOverlay={{ positions: { A: { x: 0, y: 0 }, B: { x: 320, y: 0 } } }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    const startNode = findNode("开始", editor);
    const rightHandle = Array.from(startNode.querySelectorAll<HTMLElement>(".react-flow__handle"))
      .find((handle) => handle.classList.contains("source") && handle.dataset.handleid === "r")!;
    await mouseEvent(rightHandle, "mouseover");
    await waitMs(240);
    const addButton = startNode.querySelector<HTMLButtonElement>("button[aria-label='从右侧新增连接节点']");
    expect(addButton).not.toBeNull();
    expect(addButton?.title).toBe("点击新建相邻节点");
    expect(addButton?.querySelector(".graph-diagram-handle-direction-icon--r")).not.toBeNull();
    await click(addButton!);

    const latestSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect(latestSource).toContain("新节点");
    expect(latestSource).toContain("A --> n_新节点");
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay?.positions?.n_新节点?.x).toBeGreaterThan(200);
    const fixedHandle = Object.values(latestOverlay?.edgeHandles ?? {}).find((item) => item.sourceHandle === "r");
    expect(fixedHandle).toEqual({ sourceHandle: "r", targetHandle: "l" });
  });

  it("画框松手即用默认名建区并全选标题，pending 态 Escape 撤销且不关闭编辑器", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[甲]
  B[乙]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 }, B: { x: 320, y: 50 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: { x: 20, y: 20, width: 220, height: 140 },
    });
    const firstInput = findInput("分区名称", editor);
    expect(firstInput.value).toBe("新分区");
    expect(document.activeElement).toBe(firstInput);
    expect(firstInput.selectionStart).toBe(0);
    expect(firstInput.selectionEnd).toBe(firstInput.value.length);
    const defaultSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(defaultSource).model as FlowGraph).subgraphs[0]?.label).toBe("新分区");
    await keyDown(document, { key: "Escape" });
    const cancelledSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(cancelledSource).model as FlowGraph).subgraphs).toHaveLength(0);
    expect(document.body.querySelector(".graph-diagram-editor")).toBe(editor);

    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: { x: 20, y: 20, width: 220, height: 140 },
    });
    const input = findInput("分区名称", editor);
    await setInputValue(input, "业务分区");
    await act(async () => input.blur());
    await flush();

    const nextSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const model = parseDiagram(nextSource).model as FlowGraph;
    const businessSubgraph = model.subgraphs.find((subgraph) => subgraph.label === "业务分区");
    expect(businessSubgraph).toBeTruthy();
    expect(model.nodes.find((node) => node.id === "A")?.scopePath).toEqual([businessSubgraph!.id]);
    expect(model.nodes.find((node) => node.id === "B")?.scopePath).toEqual([]);
    expect(editor.querySelector("input[aria-label='分区名称']")).toBeNull();

    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: { x: 620, y: 320, width: 120, height: 80 },
    });
    const emptyInput = findInput("分区名称", editor);
    await setInputValue(emptyInput, "空分区");
    await act(async () => emptyInput.blur());
    await flush();
    const emptyModel = parseDiagram(onSourceChange.mock.calls.at(-1)?.[0] as string).model as FlowGraph;
    expect(emptyModel.subgraphs.find((subgraph) => subgraph.label === "空分区")).toBeTruthy();
    expect(emptyModel.nodes.every((node) => !node.scopePath.includes("subgraph_空分区"))).toBe(true);
  });

  it("新建分区标题失焦时保留默认名并完成创建", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[甲]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: { x: 20, y: 20, width: 220, height: 140 },
    });
    const input = findInput("分区名称", editor);
    expect(document.activeElement).toBe(input);
    await act(async () => input.blur());
    await flush();

    const latestSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const model = parseDiagram(latestSource).model as FlowGraph;
    expect(model.subgraphs).toHaveLength(1);
    expect(model.subgraphs[0]?.label).toBe("新分区");
    expect(editor.querySelector("input[aria-label='分区名称']")).toBeNull();
    expect(document.body.querySelector(".graph-diagram-editor")).toBe(editor);
  });

  it("分区内画框创建嵌套子分区，跨越已有边界时拒绝并走全局 toast", async () => {
    const onSourceChange = vi.fn();
    await render(
      <ToastProvider>
        <EditableDiagramHarness
          source={`flowchart TD
  subgraph Outer["外层"]
    A[甲]
  end
  B[乙]
`}
          initialOverlay={{ positions: { A: { x: 100, y: 100 }, B: { x: 430, y: 100 } } }}
          onSourceChange={onSourceChange}
        />
      </ToastProvider>,
    );
    const editor = await openEditor();
    const outerNode = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    const outer = parseTranslate(outerNode.style.transform);

    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: {
        x: outer.x + 20,
        y: outer.y + 20,
        width: 48,
        height: 28,
      },
    });
    const input = findInput("分区名称", editor);
    await setInputValue(input, "内层");
    await keyDown(input, { key: "Enter" });
    const nestedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(nestedSource).model as FlowGraph).subgraphs.find(
      (subgraph) => subgraph.label === "内层",
    )?.scopePath).toEqual(["Outer"]);

    const latestOuter = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    const latestPosition = parseTranslate(latestOuter.style.transform);
    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: {
        x: latestPosition.x + 160,
        y: latestPosition.y + 24,
        width: 90,
        height: 80,
      },
    });
    const toast = await waitForSelector(".qa-toast", document.body);
    expect(toast.textContent).toContain("分区不能跨越已有分区边界");
    expect(editor.querySelector("input[aria-label='分区名称']")).toBeNull();
  });

  it("拖节点进出分区会改归属，容器按新成员自动包络", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  subgraph Outer["外层"]
    A[甲]
  end
  B[乙]
`}
        initialOverlay={{ positions: { A: { x: 100, y: 100 }, B: { x: 430, y: 100 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    const outerNode = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    const outerPosition = parseTranslate(outerNode.style.transform);
    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "B",
      position: { x: outerPosition.x, y: outerPosition.y },
    });
    const movedInSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(movedInSource).model as FlowGraph).nodes.find((node) => node.id === "B")?.scopePath).toEqual(["Outer"]);

    await dispatchGraphTestAction(editor, { kind: "dropNode", nodeId: "A", position: { x: 760, y: 120 } });
    const movedOutSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const movedOutModel = parseDiagram(movedOutSource).model as FlowGraph;
    expect(movedOutModel.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
    expect(movedOutModel.nodes.find((node) => node.id === "B")?.scopePath).toEqual(["Outer"]);
    const cluster = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    expect(parseTranslate(cluster.style.transform).x).toBeLessThan(200);
  });

  it("luna1-TC2：空分区持续渲染，可拖入、改名、拖空、选中并显式解散", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[自由节点A]
  B[自由节点B]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 }, B: { x: 320, y: 50 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();

    await dispatchGraphTestAction(editor, {
      kind: "drawSubgraph",
      rect: { x: 620, y: 320, width: 120, height: 80 },
    });
    const createInput = findInput("分区名称", editor);
    await setInputValue(createInput, "Gamma区");
    await keyDown(createInput, { key: "Enter" });
    const createdSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const gammaId = (parseDiagram(createdSource).model as FlowGraph).subgraphs
      .find((subgraph) => subgraph.label === "Gamma区")!.id;

    let clusterNode = await waitForSelector(`.react-flow__node[data-id="${gammaId}"]`, editor) as HTMLElement;
    let cluster = clusterNode.querySelector<HTMLElement>(".graph-diagram-cluster")!;
    expect(cluster.dataset.clusterEmpty).toBe("true");
    expect(cluster.classList.contains("is-empty")).toBe(true);
    expect(cluster.textContent).toContain("拖入节点");
    expect(cluster.querySelector(".react-flow__handle")).toBeNull();
    expect(clusterNode.style.width).toBe("220px");
    expect(clusterNode.style.height).toBe("146px");
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-cluster\.is-empty\s*\{\s*border-style:\s*dashed;/s,
    );

    const createdPosition = parseTranslate(clusterNode.style.transform);
    expect(createdPosition).toEqual({ x: 620, y: 320 });
    await dispatchGraphTestAction(editor, {
      kind: "moveSubgraph",
      subgraphId: gammaId,
      delta: { x: 80, y: 45 },
    });
    clusterNode = await waitForSelector(`.react-flow__node[data-id="${gammaId}"]`, editor) as HTMLElement;
    const draggedPosition = parseTranslate(clusterNode.style.transform);
    expect(draggedPosition).toEqual({ x: 700, y: 365 });

    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "A",
      position: {
        x: draggedPosition.x,
        y: draggedPosition.y,
      },
    });
    const movedInSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(movedInSource).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath)
      .toEqual([gammaId]);

    const title = await waitForSelector(
      `.react-flow__node[data-id="${gammaId}"] .graph-diagram-cluster__title`,
      editor,
    ) as HTMLElement;
    await act(async () => {
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const renameInput = findInput("分区名称", editor);
    await setInputValue(renameInput, "Gamma改名");
    await keyDown(renameInput, { key: "Enter" });
    const renamedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(renamedSource).model as FlowGraph).subgraphs.find((item) => item.id === gammaId)?.label)
      .toBe("Gamma改名");

    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "A",
      position: { x: 980, y: 540 },
    });
    const emptiedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const emptiedModel = parseDiagram(emptiedSource).model as FlowGraph;
    expect(emptiedModel.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
    expect(emptiedModel.subgraphs.find((item) => item.id === gammaId)?.label).toBe("Gamma改名");

    clusterNode = await waitForSelector(`.react-flow__node[data-id="${gammaId}"]`, editor) as HTMLElement;
    cluster = clusterNode.querySelector<HTMLElement>(".graph-diagram-cluster")!;
    expect(cluster.dataset.clusterEmpty).toBe("true");
    const emptyTitle = cluster.querySelector<HTMLElement>(".graph-diagram-cluster__title")!;
    await click(emptyTitle);
    expect(editor.querySelector("button[aria-label='解散分区']")).toBeNull();
    await dissolveSubgraphViaMenu(editor);

    const dissolvedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(dissolvedSource).model as FlowGraph).subgraphs).toHaveLength(0);
    expect(dissolvedSource).not.toContain("subgraph ");
    expect(dissolvedSource.split("\n").filter((line) => line.trim() === "end")).toHaveLength(0);
  });

  it("源码手写空 subgraph 在预览和编辑态同路渲染，节点可拖入", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[自由节点A]
  subgraph Gamma["手写空分区"]
  end
`}
        initialOverlay={{ positions: { A: { x: 420, y: 80 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const previewCluster = await waitForSelector('.graph-diagram-export [data-cluster-id="Gamma"]') as SVGGElement;
    expect(previewCluster.dataset.empty).toBe("true");
    expect(previewCluster.textContent).toContain("手写空分区");
    expect(previewCluster.textContent).toContain("拖入节点");

    const editor = await openEditor();
    const clusterNode = await waitForSelector('.react-flow__node[data-id="Gamma"]', editor) as HTMLElement;
    expect(clusterNode.querySelector<HTMLElement>(".graph-diagram-cluster")?.dataset.clusterEmpty).toBe("true");
    const position = parseTranslate(clusterNode.style.transform);
    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "A",
      position: { x: position.x, y: position.y },
    });

    const movedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(movedSource).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath)
      .toEqual(["Gamma"]);
    expect((parseDiagram(movedSource).model as FlowGraph).subgraphs.find((item) => item.id === "Gamma"))
      .toMatchObject({ label: "手写空分区" });
  });

  it("分区标题可选择、双击内联改名，工具栏解散后节点保留归父", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  subgraph Outer["旧分区"]
    A[甲]
  end
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    const title = await waitForSelector(".graph-diagram-cluster__title", editor) as HTMLElement;
    await click(title);
    expect(title.closest(".graph-diagram-cluster")?.classList.contains("is-selected")).toBe(true);
    expect(editor.querySelector("button[aria-label='解散分区']")).toBeNull();

    const selectedTitle = await waitForSelector(".graph-diagram-cluster__title", editor) as HTMLElement;
    await act(async () => {
      selectedTitle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const renameInput = findInput("分区名称", editor);
    await setInputValue(renameInput, "新分区");
    await keyDown(renameInput, { key: "Enter" });
    const renamedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(renamedSource).model as FlowGraph).subgraphs.find((subgraph) => subgraph.id === "Outer")?.label).toBe("新分区");

    const renamedTitle = await waitForSelector(".graph-diagram-cluster__title", editor) as HTMLElement;
    await click(renamedTitle);
    await dissolveSubgraphViaMenu(editor);
    const dissolvedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const model = parseDiagram(dissolvedSource).model as FlowGraph;
    expect(model.subgraphs).toHaveLength(0);
    expect(model.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
  });

  it("分区填充与边框色样随源码变化，改色写回 Mermaid 并同步预览导出", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  subgraph Outer["业务区"]
    A[甲]
  end
  style Outer fill:#efe3cc,stroke:#8f6d30
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await click(await waitForSelector(".graph-diagram-cluster__title", editor));
    const toolbar = await waitForSelector("[aria-label='分区上下文操作']", editor);
    const fillButton = findToolbarButton("填充", toolbar);
    const borderButton = findToolbarButton("边框", toolbar);
    expect(fillButton.dataset.swatchColor).toBe("#efe3cc");
    expect(fillButton.querySelector("circle")?.getAttribute("fill")).toBe("#efe3cc");
    expect(borderButton.dataset.swatchColor).toBe("#8f6d30");
    expect(borderButton.querySelector("circle")?.getAttribute("stroke")).toBe("#8f6d30");

    await openToolbarMenu("填充", toolbar);
    await click(await waitForSelector("button[aria-label='分区填充色 #f8e7a1']", editor));
    await openToolbarMenu("边框", toolbar);
    await click(await waitForSelector("button[aria-label='分区边框色 #6a6256']", editor));

    const rewritten = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect(rewritten).toContain("style Outer fill:#f8e7a1,stroke:#6a6256");
    expect((parseDiagram(rewritten).model as FlowGraph).perSubgraphStyles?.Outer).toMatchObject({
      fill: "#f8e7a1",
      stroke: "#6a6256",
    });
    const clusterNode = editor.querySelector<HTMLElement>('.react-flow__node[data-id="Outer"]')!;
    expect(clusterNode.style.getPropertyValue("--graph-cluster-fill")).toBe("#f8e7a1");
    expect(clusterNode.style.getPropertyValue("--graph-cluster-stroke")).toBe("#6a6256");
    const exportedRect = container?.querySelector<SVGRectElement>('.graph-diagram-export [data-cluster-id="Outer"] rect');
    expect(exportedRect?.getAttribute("fill")).toBe("#f8e7a1");
    expect(exportedRect?.getAttribute("stroke")).toBe("#6a6256");
  });

  it("选中分区按 Delete 解散；拖标题整体移动时内部相对位置不变且不改 source", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  subgraph Outer["外层"]
    A[甲]
    B[乙]
  end
`}
        initialOverlay={{ positions: { A: { x: 80, y: 90 }, B: { x: 300, y: 90 } } }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-editor \.react-flow__node-graphCluster\s*\{\s*pointer-events:\s*auto;/s,
    );
    const clusterBefore = parseTranslate((await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement).style.transform);
    await dispatchGraphTestAction(editor, { kind: "moveSubgraph", subgraphId: "Outer", delta: { x: 140, y: 70 } });
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay.positions?.A).toEqual({ x: 220, y: 160 });
    expect(latestOverlay.positions?.B).toEqual({ x: 440, y: 160 });
    expect(latestOverlay.positions?.Outer).toEqual({
      x: Math.round(clusterBefore.x + 140),
      y: Math.round(clusterBefore.y + 70),
    });
    expect(Object.keys(latestOverlay)).toEqual(["positions"]);
    expect((latestOverlay.positions?.B?.x ?? 0) - (latestOverlay.positions?.A?.x ?? 0)).toBe(220);
    const clusterAfter = parseTranslate((await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement).style.transform);
    expect(clusterAfter.x - clusterBefore.x).toBe(140);
    expect(clusterAfter.y - clusterBefore.y).toBe(70);
    expect(onSourceChange).not.toHaveBeenCalled();

    await click(await waitForSelector(".graph-diagram-cluster__title", editor));
    await keyDown(editor, { key: "Delete" });
    const dissolvedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(dissolvedSource).model as FlowGraph).subgraphs).toHaveLength(0);
    expect((parseDiagram(dissolvedSource).model as FlowGraph).nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
  });

  it("连续语义编辑基于组件内最新 source,不会重复写同一个节点声明", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    for (let i = 0; i < 2; i += 1) {
      await click(findButton("新增节点", editor));
    }
    expect(onSourceChange).toHaveBeenCalledTimes(2);
    const secondSource = onSourceChange.mock.calls[1]![0] as string;
    const model = parseDiagram(secondSource).model as FlowGraph;
    expect(model.nodes.filter((node) => node.label === "新节点").map((node) => node.id)).toEqual(["n_新节点", "n_新节点_2"]);
    expect(secondSource.match(/n_新节点\["新节点"\]/g)).toHaveLength(1);
    expect(secondSource).toContain('n_新节点_2["新节点"]');
  });

  it("Delete/Backspace 在编辑器内删除选中节点", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    await keyDown(editor, { key: "Delete" });
    expect(onSourceChange).toHaveBeenCalledWith(expect.not.stringContaining("A[开始]"));
  });

  it("Delete/Backspace 在就地编辑节点标签时不触发图编辑删除", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    const startNode = findNode("开始", editor);
    await act(async () => {
      startNode.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const label = await waitForSelector(".graph-diagram-node-label[contenteditable='true']", document.body) as HTMLElement;
    await keyDown(label, { key: "Backspace" });
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("Alt 拖拽节点生成副本并保留原节点位置", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 } }, styles: { A: { fill: "#d7e7f6" } } }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    findNode("开始", editor);
    await dispatchGraphTestAction(editor, { kind: "altDuplicate", nodeId: "A", dropPosition: { x: 260, y: 120 } });

    const latestSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect(latestSource).toContain('n_开始["开始"]');
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay?.positions?.A).toEqual({ x: 40, y: 50 });
    expect(latestOverlay?.positions?.n_开始).toBeDefined();
    expect(latestOverlay?.styles?.n_开始).toEqual({ fill: "#d7e7f6" });
  });

  it("Shift 拖拽按主导轴约束节点位置", async () => {
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 } } }}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    findNode("开始", editor);
    await dispatchGraphTestAction(editor, { kind: "shiftDrag", nodeId: "A", dropPosition: { x: 260, y: 110 } });

    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay?.positions?.A?.x).toBeGreaterThan(40);
    expect(latestOverlay?.positions?.A?.y).toBe(50);
  });

  it("A1 非稳定节点也能拖布局,但语义操作仍禁用", async () => {
    const source = `stateDiagram-v2
  [*] --> Open
  state "打开" as Open
`;
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={source}
        initialOverlay={{ positions: { __start: { x: 40, y: 50 }, Open: { x: 240, y: 50 } } }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    const unstableNode = await waitForSelector('.react-flow__node[data-id="__start"]', editor) as HTMLElement;
    const stableNode = await waitForSelector('.react-flow__node[data-id="Open"]', editor) as HTMLElement;

    expect(unstableNode.classList.contains("draggable")).toBe(true);
    expect(stableNode.classList.contains("draggable")).toBe(true);
    expect(unstableNode.querySelector(".graph-diagram-node-shell")?.classList.contains("can-rename")).toBe(false);
    expect(stableNode.querySelector(".graph-diagram-node-shell")?.classList.contains("can-rename")).toBe(true);

    const beforeTransform = unstableNode.style.transform;
    const before = parseTranslate(beforeTransform);
    await dispatchGraphTestAction(editor, {
      kind: "shiftDrag",
      nodeId: "__start",
      dropPosition: { x: before.x + 160, y: before.y + 40 },
    });

    const movedNode = editor.querySelector<HTMLElement>('.react-flow__node[data-id="__start"]')!;
    expect(movedNode.style.transform).not.toBe(beforeTransform);
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay?.positions?.__start).toEqual({ x: Math.round(before.x + 160), y: Math.round(before.y) });
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("Ctrl/Cmd 空白拖拽可框选多个节点并隐藏单选工具栏", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始]
  B[结束]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 }, B: { x: 220, y: 50 } } }}
      />,
    );
    const editor = await openEditor();
    await waitForSelector(".react-flow__pane", editor);
    await dispatchGraphTestAction(editor, { kind: "boxSelect", nodeIds: ["A", "B"] });
    expect(editor.querySelectorAll(".react-flow__node.selected").length).toBeGreaterThanOrEqual(2);
    expect(editor.querySelector(".graph-diagram-toolbar[aria-label='节点上下文操作']")).toBeNull();
  });

  it("点击空白画布同时清除节点、边、分区与多选标记", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  subgraph Zone["分区"]
    A[开始] --> B[结束]
  end
`}
      />,
    );
    const editor = await openEditor();
    const pane = await waitForSelector(".react-flow__pane", editor);

    await click(findNode("开始", editor));
    expect(editor.querySelector("[aria-label='节点上下文操作']")).not.toBeNull();
    await panePointerClick(pane);
    expect(editor.querySelector(".react-flow__node.selected")).toBeNull();
    expect(editor.querySelector("[aria-label='节点上下文操作']")).toBeNull();

    await click(await waitForSelector(".react-flow__edge", editor));
    expect(editor.querySelector("[aria-label='连线上下文操作']")).not.toBeNull();
    await panePointerClick(pane);
    expect(editor.querySelector(".react-flow__edge.selected")).toBeNull();
    expect(editor.querySelector("[aria-label='连线上下文操作']")).toBeNull();

    await click(await waitForSelector(".graph-diagram-cluster__title", editor));
    expect(editor.querySelector("[aria-label='分区上下文操作']")).not.toBeNull();
    await panePointerClick(pane);
    expect(editor.querySelector(".graph-diagram-cluster.is-selected")).toBeNull();
    expect(editor.querySelector("[aria-label='分区上下文操作']")).toBeNull();

    await dispatchGraphTestAction(editor, { kind: "boxSelect", nodeIds: ["A", "B"] });
    expect(editor.querySelectorAll(".react-flow__node.selected").length).toBeGreaterThanOrEqual(2);
    await panePointerClick(pane);
    expect(editor.querySelector(".react-flow__node.selected")).toBeNull();
  });

  it("多选节点在位置 overlay 回写重建后仍保持完整选择集", async () => {
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始]
  B[结束]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 }, B: { x: 220, y: 50 } } }}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    await dispatchGraphTestAction(editor, { kind: "boxSelect", nodeIds: ["A", "B"] });
    await dispatchGraphTestAction(editor, {
      kind: "shiftDrag",
      nodeId: "A",
      dropPosition: { x: 160, y: 90 },
    });

    expect(onOverlayChange).toHaveBeenCalled();
    expect(
      editor.querySelector('.react-flow__node[data-id="A"]')?.classList.contains("selected"),
    ).toBe(true);
    expect(
      editor.querySelector('.react-flow__node[data-id="B"]')?.classList.contains("selected"),
    ).toBe(true);
  });

  it("多选边在节点位置 overlay 回写重建后仍保持完整选择集", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始] --> B[中间]
  B --> C[结束]
`}
        initialOverlay={{
          positions: {
            A: { x: 40, y: 50 },
            B: { x: 220, y: 50 },
            C: { x: 400, y: 50 },
          },
        }}
      />,
    );
    const editor = await openEditor();
    const edgeIds = Array.from(
      editor.querySelectorAll<HTMLElement>(".react-flow__edge"),
      (edge) => edge.dataset.id,
    ).filter((id): id is string => Boolean(id));
    expect(edgeIds).toHaveLength(2);

    await dispatchGraphTestAction(editor, {
      kind: "boxSelect",
      nodeIds: [],
      edgeIds,
    });
    await dispatchGraphTestAction(editor, {
      kind: "shiftDrag",
      nodeId: "A",
      dropPosition: { x: 160, y: 90 },
    });

    for (const edgeId of edgeIds) {
      expect(
        editor
          .querySelector(`.react-flow__edge[data-id="${edgeId}"]`)
          ?.classList.contains("selected"),
      ).toBe(true);
    }
  });

  it("source prop 变化后重新 parse 并重渲视图", async () => {
    await render(
      <DiagramRenderer
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        readOnly
      />,
    );
    await waitForSelector(".graph-diagram");
    expect(container?.textContent).toContain("开始");
    await act(async () => {
      root!.render(
        <DiagramRenderer
          source={`flowchart TD
  A[新开始] --> C[完成]
`}
          readOnly
        />,
      );
    });
    await flush();
    expect(container?.textContent).toContain("新开始");
    expect(container?.textContent).toContain("完成");
    expect(container?.textContent).not.toContain("结束");
  });

  it("flowchart 节点按 Mermaid shape 渲染对应外形标记", async () => {
    await render(
      <DiagramRenderer
        source={`flowchart TD
  A{判断} --> B((圆形))
  C[矩形] --> D(圆角)
`}
        readOnly
      />,
    );
    await waitForSelector(".graph-diagram");
    expect(findNode("判断", container!).querySelector("[data-node-shape='diamond']")).not.toBeNull();
    expect(findNode("圆形", container!).querySelector("[data-node-shape='circle']")).not.toBeNull();
    expect(findNode("矩形", container!).querySelector("[data-node-shape='rect']")).not.toBeNull();
    expect(findNode("圆角", container!).querySelector("[data-node-shape='round']")).not.toBeNull();
    expect(graphDiagramCss).toMatch(/\.graph-diagram-node-label\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  });

  it("mindmap 选中节点后通过画布点选目标节点改父", async () => {
    const source = `mindmap
  根
    素材
      访谈
    大纲
      结构
`;
    const tree = parseDiagram(source).model as MindmapTree;
    const nodes = flattenMindmap(tree.root);
    const interview = nodes.find((node) => node.label === "访谈");
    const outline = nodes.find((node) => node.label === "大纲");
    expect(interview).toBeTruthy();
    expect(outline).toBeTruthy();
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={source}
        initialOverlay={{
          positions: { [interview!.id]: { x: 320, y: 180 } },
          styles: { [interview!.id]: { fill: "#d7e7f6", strokeWidth: 4 } },
        }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    await click(findNode("访谈", editor));
    await waitForSelector("[aria-label='节点上下文操作']", editor);
    await dispatchGraphTestAction(editor, { kind: "moveParent", nodeId: interview!.id, newParentId: outline!.id });
    expect(onSourceChange).toHaveBeenCalledTimes(1);
    const nextSource = onSourceChange.mock.calls[0]![0] as string;
    expect(nextSource).toContain("    素材\n    大纲\n      结构\n      访谈\n");
    const nextInterview = flattenMindmap((parseDiagram(nextSource).model as MindmapTree).root)
      .find((node) => node.label === "访谈")!;
    expect(nextInterview.id).not.toBe(interview!.id);
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay.positions?.[nextInterview.id]).toEqual({ x: 320, y: 180 });
    expect(latestOverlay.styles?.[nextInterview.id]).toEqual({ fill: "#d7e7f6", strokeWidth: 4 });
    expect(latestOverlay.styles?.[interview!.id]).toBeUndefined();
    expect(editor.querySelector("[aria-label='节点上下文操作']")).not.toBeNull();
  });

  it("双击节点标签进入就地 contentEditable 并回写 relabelNode", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await waitForSelector(".graph-diagram-node-shell.can-rename", editor);
    const startNode = findNode("开始", editor);
    await act(async () => {
      startNode.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const label = await waitForSelector(".graph-diagram-node-label[contenteditable='true']", document.body) as HTMLElement;
    expect(label.textContent).toBe("开始");
    expect(document.activeElement).toBe(label);
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.isCollapsed).toBe(false);
    expect(label.contains(selection?.anchorNode ?? null)).toBe(true);
    await setEditableText(label, "起点");
    await pressEnter(label);
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("起点"));
    expect(document.body.querySelector(".graph-diagram-editor")).not.toBeNull();
  });

  it("节点就地改名支持 IME 组合输入且键鼠事件不退出全屏", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await waitForSelector(".graph-diagram-node-shell.can-rename", editor);
    const startNode = findNode("开始", editor);
    await act(async () => {
      startNode.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const label = await waitForSelector(".graph-diagram-node-label[contenteditable='true']", document.body) as HTMLElement;

    await act(async () => {
      label.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      label.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });
    await setEditableText(label, "中文起点");
    await pressEnter(label);
    expect(onSourceChange).not.toHaveBeenCalled();
    expect(document.body.querySelector(".graph-diagram-editor")).not.toBeNull();

    await act(async () => {
      label.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "点" }));
    });
    await pressEnter(label);
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("中文起点"));
    expect(document.body.querySelector(".graph-diagram-editor")).not.toBeNull();
  });

  it("形状选择器走 setNodeShape 回写 source,不写 overlay", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    await waitForSelector("[aria-label='节点上下文操作']", editor);
    const toolbar = await waitForSelector(".graph-diagram-toolbar[aria-label='节点上下文操作']", document.body);
    expect(toolbar.querySelectorAll(".graph-diagram-toolbar__row > button")).toHaveLength(5);
    expect(toolbar.querySelector(".graph-diagram-panel-section")).toBeNull();
    expect(toolbar.querySelector(".graph-diagram-popover")).toBeNull();
    await openToolbarMenu("形状", editor);
    expect(["矩形", "圆角矩形", "体育场/胶囊", "子流程", "圆柱", "菱形(判断)", "圆形", "双圆形", "非对称形", "六边形", "平行四边形", "反向平行四边形", "梯形", "反向梯形"].map((label) => findButton(label, editor).textContent?.trim())).toEqual([
      "矩形",
      "圆角矩形",
      "体育场/胶囊",
      "子流程",
      "圆柱",
      "菱形(判断)",
      "圆形",
      "双圆形",
      "非对称形",
      "六边形",
      "平行四边形",
      "反向平行四边形",
      "梯形",
      "反向梯形",
    ]);
    await click(findButton("菱形(判断)", editor));
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("A{开始} --> B[结束]"));
    expect(onOverlayChange).not.toHaveBeenCalled();
  });

  it("双击连线进入就地标签编辑并走 setEdgeLabel 回写 source", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    const edge = await waitForSelector(".react-flow__edge", editor);
    await act(async () => {
      edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    await flush();
    const label = await waitForSelector(".graph-diagram-edge-label[contenteditable='true']", document.body) as HTMLElement;
    await setEditableText(label, "通过");
    await pressEnter(label);
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("A[开始] -->|通过| B[结束]"));
    expect(onOverlayChange).not.toHaveBeenCalled();
  });

  it("flowchart 连线按方向和线型渲染 marker 与线条样式", async () => {
    await render(
      <DiagramRenderer
        source={`flowchart LR
  A[开始] --> B[正向]
  B <-- C[反向]
  C <--> D[双向]
  D --- E[无箭头]
  E -.-> F[点线]
  F ==> G[粗线]
`}
        readOnly
      />,
    );
    await waitForSelector(".graph-diagram");
    const paths = Array.from(container!.querySelectorAll<SVGPathElement>(".react-flow__edge-path"));
    expect(paths).toHaveLength(6);
    expect(paths[0]?.getAttribute("marker-end")).toContain("arrowclosed");
    expect(paths[0]?.getAttribute("marker-start")).toBeNull();
    expect(paths[1]?.getAttribute("marker-start")).toContain("arrowclosed");
    expect(paths[1]?.getAttribute("marker-end")).toBeNull();
    expect(paths[2]?.getAttribute("marker-start")).toContain("arrowclosed");
    expect(paths[2]?.getAttribute("marker-end")).toContain("arrowclosed");
    expect(paths[3]?.getAttribute("marker-start")).toBeNull();
    expect(paths[3]?.getAttribute("marker-end")).toBeNull();
    expect(paths[4]?.getAttribute("style")).toContain("stroke-dasharray: 4 6");
    expect(paths[5]?.getAttribute("style")).toContain("stroke-width: 2.8");
  });

  it("连线工具栏箭头菜单走 setEdgeArrow 回写 source", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await click(await waitForSelector(".react-flow__edge", editor));
    await openToolbarMenu("箭头", editor);
    await click(await waitForSelector("button[aria-label='双向箭头']", editor));
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("A[开始] <--> B[结束]"));
  });

  it("节点样式由点击节点后的上下文色块写入 overlay,不改 source", async () => {
    const onOverlayChange = vi.fn();
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onOverlayChange={onOverlayChange}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    const contextToolbar = await waitForSelector("[aria-label='节点上下文操作']", editor);
    expect(editor.querySelectorAll(".graph-diagram-toolbar[aria-label='节点上下文操作']")).toHaveLength(1);
    expect(contextToolbar.classList.contains("doc-toolbar")).toBe(true);
    expect(contextToolbar.classList.contains("on")).toBe(true);
    expect(contextToolbar.querySelectorAll(".dt-btn")).toHaveLength(5);
    expect(editor.querySelectorAll(".graph-diagram-shape-grid")).toHaveLength(0);
    expect(editor.querySelectorAll(".graph-diagram-segmented")).toHaveLength(0);
    const fillButton = findToolbarButton("填充", editor);
    const borderButton = findToolbarButton("边框", editor);
    expect(fillButton.dataset.swatchColor).toBe("#efe3cc");
    expect(fillButton.querySelector("circle")?.getAttribute("fill")).toBe("#efe3cc");
    expect(borderButton.dataset.swatchColor).toBe("#b08a3e");
    expect(borderButton.querySelector("circle")?.getAttribute("stroke")).toBe("#b08a3e");
    await openToolbarMenu("填充", editor);
    expect(editor.querySelector(".graph-diagram-popover.dt-menu")).not.toBeNull();
    const swatch = await waitForSelector("button[aria-label='填充色 #f3ecdd']", editor);
    await click(swatch);
    expect(findToolbarButton("填充", editor).dataset.swatchColor).toBe("#f3ecdd");
    expect(findToolbarButton("填充", editor).querySelector("circle")?.getAttribute("fill")).toBe("#f3ecdd");
    await setInputValue(findInput("填充不透明度", editor), "50");
    await openToolbarMenu("边框", editor);
    await setInputValue(findInput("边框粗细(px)", editor), "4");
    await openToolbarMenu("文字", editor);
    const fontSizeInput = findInput("字号(px)", editor);
    expect(fontSizeInput.getAttribute("min")).toBe("10");
    expect(fontSizeInput.getAttribute("max")).toBe("48");
    await setInputValue(fontSizeInput, "18");
    expect(onOverlayChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({
        A: expect.objectContaining({ fill: "#f3ecdd" }),
      }),
    }));
    expect(onOverlayChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({
        A: expect.objectContaining({ fill: "#f3ecdd80" }),
      }),
    }));
    expect(onOverlayChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({
        A: expect.objectContaining({ strokeWidth: 4 }),
      }),
    }));
    expect(onOverlayChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({
        A: expect.objectContaining({ fontSize: 18 }),
      }),
    }));
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("边样式由点击边后的上下文色块写入 overlay,不改 source", async () => {
    const onOverlayChange = vi.fn();
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onOverlayChange={onOverlayChange}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    await click(await waitForSelector(".react-flow__edge", editor));
    await waitForSelector("[aria-label='连线上下文操作']", editor);
    expect(editor.querySelectorAll(".graph-diagram-toolbar[aria-label='连线上下文操作']")).toHaveLength(1);
    expect(editor.querySelectorAll(".graph-diagram-segmented")).toHaveLength(0);
    await openToolbarMenu("线", editor);
    const swatch = await waitForSelector("button[aria-label='线色 #8f6d30']", editor);
    await click(swatch);
    await setInputValue(findInput("线宽(px)", editor), "4");
    const edgeStylePayloads = onOverlayChange.mock.calls
      .map(([payload]) => payload?.edgeStyles)
      .filter(Boolean) as Array<Record<string, { stroke?: string; strokeWidth?: number }>>;
    expect(edgeStylePayloads.some((styles) => Object.values(styles).some((style) => style.stroke === "#8f6d30"))).toBe(true);
    expect(edgeStylePayloads.some((styles) => Object.values(styles).some((style) => style.strokeWidth === 4))).toBe(true);
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("连线圆点与命中盒同心悬在元素外侧,resize 只留四角", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    const node = findNode("开始", editor);
    // 圆点四向都按同一个外移量挂在元素外侧(不再骑在边框正中)。
    for (const side of ["t", "r", "b", "l"] as const) {
      expect(node.querySelector(`.graph-diagram-handle-dot--${side}`)).not.toBeNull();
    }
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-handle-dot--t\s*\{\s*top:\s*calc\(var\(--graph-handle-offset\) \* -1\);\s*left:\s*50%;/s,
    );
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-handle-dot--b\s*\{\s*top:\s*calc\(100% \+ var\(--graph-handle-offset\)\);\s*left:\s*50%;/s,
    );
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-handle-dot--r\s*\{\s*top:\s*50%;\s*left:\s*calc\(100% \+ var\(--graph-handle-offset\)\);/s,
    );
    // 命中盒:清掉 React Flow 默认贴边定位,改为与圆点同一套偏移 + 自身居中(旧值 transform:none 会偏 8px)。
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram \.react-flow__handle,\s*\.graph-diagram-editor \.react-flow__handle\s*\{[^}]*inset:\s*auto;[^}]*transform:\s*translate\(-50%, -50%\);/s,
    );
    expect(graphDiagramCss).not.toMatch(/\.react-flow__handle\s*\{[^}]*transform:\s*none;/s);
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-editor \.graph-diagram-handle--t\s*\{\s*top:\s*calc\(var\(--graph-handle-offset\) \* -1\);/s,
    );
    // resize 只剩四角方块,且四角挂在与选中包围盒同一圈上。
    await click(node);
    const resizeHandles = Array.from(editor.querySelectorAll<HTMLElement>(".graph-diagram-resize-handle"));
    expect(resizeHandles).toHaveLength(4);
    expect(resizeHandles.every((handle) => /top|bottom/.test(handle.className) && /left|right/.test(handle.className))).toBe(true);
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-resize-handle\.top\s*\{\s*margin-top:\s*calc\(var\(--graph-select-inset\) \* -1\);/s,
    );
  });

  it("拖拽中收起浮动工具栏,整块被包住才点亮目标分区并收编", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  subgraph Outer["外层"]
    A[甲]
  end
  B[乙]
`}
        initialOverlay={{ positions: { A: { x: 100, y: 100 }, B: { x: 460, y: 100 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    const outerNode = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    const outerPosition = parseTranslate(outerNode.style.transform);
    const outerWidth = Number.parseFloat(outerNode.style.width);
    const outerHeight = Number.parseFloat(outerNode.style.height);

    await click(findNode("乙", editor));
    expect(editor.querySelector("[aria-label='节点上下文操作']")).not.toBeNull();

    // 只探进一半:整块没被包住 → 不高亮
    await dispatchGraphTestAction(editor, {
      kind: "dragNode",
      nodeId: "B",
      position: { x: outerPosition.x + outerWidth - 40, y: outerPosition.y + outerHeight - 20 },
    });
    expect(editor.querySelector("[aria-label='节点上下文操作']")).toBeNull();
    expect(editor.querySelector(".graph-diagram-cluster.is-drop-target")).toBeNull();

    // 整块进入 → 边框高亮
    await dispatchGraphTestAction(editor, {
      kind: "dragNode",
      nodeId: "B",
      position: { x: outerPosition.x, y: outerPosition.y },
    });
    const highlighted = editor.querySelector<HTMLElement>(".graph-diagram-cluster.is-drop-target");
    expect(highlighted).not.toBeNull();
    expect(highlighted!.closest(".react-flow__node")?.getAttribute("data-id")).toBe("Outer");
    expect(highlighted!.dataset.dropTarget).toBe("true");
    expect(editor.querySelector("[aria-label='节点上下文操作']")).toBeNull();
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-cluster\.is-drop-target\s*\{[^}]*border-color:\s*var\(--mark\);/s,
    );

    // 松手:高亮消失,归属按同一判定收编,工具栏回来
    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "B",
      position: { x: outerPosition.x, y: outerPosition.y },
    });
    expect(editor.querySelector(".graph-diagram-cluster.is-drop-target")).toBeNull();
    const movedInSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect((parseDiagram(movedInSource).model as FlowGraph).nodes.find((node) => node.id === "B")?.scopePath).toEqual(["Outer"]);
  });

  it("整块没被包住时松手不收编(高亮说不能进就真不进)", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  subgraph Outer["外层"]
    A[甲]
  end
  B[乙]
`}
        initialOverlay={{ positions: { A: { x: 100, y: 100 }, B: { x: 460, y: 100 } } }}
        onSourceChange={onSourceChange}
      />,
    );
    const editor = await openEditor();
    const outerNode = await waitForSelector('.react-flow__node[data-id="Outer"]', editor) as HTMLElement;
    const outerPosition = parseTranslate(outerNode.style.transform);
    const outerWidth = Number.parseFloat(outerNode.style.width);
    await dispatchGraphTestAction(editor, {
      kind: "dropNode",
      nodeId: "B",
      position: { x: outerPosition.x + outerWidth - 40, y: outerPosition.y + 10 },
    });
    const latest = onSourceChange.mock.calls.at(-1)?.[0] as string | undefined;
    const model = parseDiagram(latest ?? `flowchart TD
  subgraph Outer["外层"]
    A[甲]
  end
  B[乙]
`).model as FlowGraph;
    expect(model.nodes.find((node) => node.id === "B")?.scopePath).toEqual([]);
  });

  it("重命名态连击不再整段重选,单击落点交给光标定位", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    const node = findNode("开始", editor);
    await act(async () => {
      node.querySelector(".graph-diagram-node-shell")!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }),
      );
    });
    await flush();
    const label = await waitForSelector(".graph-diagram-node-label.is-editing", editor) as HTMLElement;
    expect(label.getAttribute("contenteditable")).toBe("true");

    // 双击后紧接着的"单击"在浏览器里是三连击:必须被接管,不能走原生整段重选
    const tripleClick = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 3 });
    await act(async () => {
      label.dispatchEvent(tripleClick);
    });
    await flush();
    expect(tripleClick.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(label);
    expect(editor.querySelector(".graph-diagram-node-label.is-editing")).not.toBeNull();

    // 普通单击交回浏览器默认的落 caret 行为
    const singleClick = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => {
      label.dispatchEvent(singleClick);
    });
    await flush();
    expect(singleClick.defaultPrevented).toBe(false);
    expect(editor.querySelector(".graph-diagram-node-label.is-editing")).not.toBeNull();
    // WebKit 系靠 -webkit-user-select 才能在 contenteditable 后代里落 caret
    expect(graphDiagramCss).toMatch(
      /\.graph-diagram-node-label\.is-editing\s*\{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s,
    );
  });

  it("flowchart 节点溢出菜单不再重复出现新增节点,mindmap 保留加子节点", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    const menu = await openToolbarMenu("…更多", editor);
    expect(Array.from(menu.querySelectorAll(".graph-diagram-menu-item")).map((item) => item.textContent))
      .toEqual(["重置样式⌥R", "删除节点Del"]);
    expect(menu.textContent).not.toContain("新增节点");
    // 底部工具栏与把手加号仍是新增节点的入口
    expect(findButton("新增节点", editor)).not.toBeNull();
  });

  it("多个图表实例的点阵 pattern id 各自唯一,不会互相解析串台", async () => {
    await render(
      <>
        <DiagramRenderer source={`flowchart TD
  A[甲] --> B[乙]
`} readOnly />
        <DiagramRenderer source={`flowchart TD
  C[丙] --> D[丁]
`} readOnly />
      </>,
    );
    await waitForSelector(".graph-diagram");
    const patterns = Array.from(container!.querySelectorAll<SVGPatternElement>(".react-flow__background pattern"));
    expect(patterns.length).toBeGreaterThanOrEqual(2);
    const ids = patterns.map((pattern) => pattern.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pattern of patterns) {
      const rect = pattern.parentElement!.querySelector("rect")!;
      expect(rect.getAttribute("fill")).toBe(`url(#${pattern.id})`);
    }
  });

  it("多选后 Ctrl+C/Ctrl+V 复制节点集与互连边,副本整体偏移并被选中", async () => {
    const onSourceChange = vi.fn();
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart LR
  A[甲] --> B[乙]
`}
        initialOverlay={{ positions: { A: { x: 40, y: 50 }, B: { x: 300, y: 50 } } }}
        onSourceChange={onSourceChange}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    await dispatchGraphTestAction(editor, { kind: "boxSelect", nodeIds: ["A", "B"] });
    await keyDown(editor, { key: "c", ctrlKey: true });
    await keyDown(editor, { key: "v", ctrlKey: true });

    const pastedSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    const model = parseDiagram(pastedSource).model as FlowGraph;
    expect(model.nodes).toHaveLength(4);
    expect(model.nodes.filter((node) => node.label === "甲")).toHaveLength(2);
    expect(model.edges).toHaveLength(2);
    const originalIds = new Set(["A", "B"]);
    const copiedIds = model.nodes.filter((node) => !originalIds.has(node.id)).map((node) => node.id);
    expect(copiedIds).toHaveLength(2);
    // 副本之间保留互连边
    expect(model.edges.some((edge) => copiedIds.includes(edge.source) && copiedIds.includes(edge.target))).toBe(true);
    const overlay = onOverlayChange.mock.calls.at(-1)?.[0];
    const copiedPositions = copiedIds.map((id) => overlay?.positions?.[id]);
    expect(copiedPositions).toContainEqual({ x: 56, y: 66 });
    expect(copiedPositions).toContainEqual({ x: 316, y: 66 });
    // 粘贴后选中态落在副本上
    const selectedIds = Array.from(editor.querySelectorAll<HTMLElement>(".react-flow__node.selected"))
      .map((node) => node.getAttribute("data-id"));
    expect(selectedIds.sort()).toEqual([...copiedIds].sort());
  });

  it("节点 resize 中间态本体与选区实时同尺寸，结束后写入 overlay 并参与导出往返", async () => {
    const onOverlayChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onOverlayChange={onOverlayChange}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    // resize 只留四角方块把手,四条边线不再是抓取区(边中点让给连线圆点)。
    expect(editor.querySelectorAll(".graph-diagram-resize-handle")).toHaveLength(4);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-resize-line\s*\{[^}]*pointer-events:\s*none;/s);
    expect(graphDiagramCss).not.toContain(".graph-diagram-resize-line::after");

    await dispatchGraphTestAction(editor, {
      kind: "resizeNodePreview",
      nodeId: "A",
      rect: { x: 58, y: 82, width: 260, height: 126 },
    });
    const previewNode = findNode("开始", editor);
    const previewBody = previewNode.querySelector<HTMLElement>(".graph-diagram-node-shell")!;
    // 尺寸单一真相在 React Flow 的 node wrapper 上;外壳按 100% 跟随,不再写内联死值。
    expect(previewNode.style.width).toBe("260px");
    expect(previewNode.style.height).toBe("126px");
    expect(previewBody.style.width).toBe("");
    expect(previewBody.style.height).toBe("");
    expect(graphDiagramCss).toMatch(/\.graph-diagram-node-shell\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
    expect(previewBody.dataset.nodeWidth).toBe("260");
    expect(previewBody.dataset.nodeHeight).toBe("126");
    expect(onOverlayChange).not.toHaveBeenCalled();

    await dispatchGraphTestAction(editor, {
      kind: "resizeNode",
      nodeId: "A",
      rect: { x: 64, y: 88, width: 296, height: 144 },
    });
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0];
    expect(latestOverlay?.positions?.A).toEqual({ x: 64, y: 88 });
    expect(latestOverlay?.styles?.A).toMatchObject({ width: 296, height: 144 });

    const exportedShape = container?.querySelector<SVGElement>(".graph-diagram-export [data-node-id='A'] [data-layout-width='296']");
    expect(exportedShape?.getAttribute("data-layout-height")).toBe("144");
    await click(editor.querySelector<HTMLButtonElement>(".diagram-editor-chrome__close")!);
    const reopened = await openEditor();
    const resized = findNode("开始", reopened);
    expect(resized.style.width).toBe("296px");
    expect(resized.style.height).toBe("144px");
  });

  it("图编辑交互皮肤无系统蓝,连接把手圆点与悬停按钮统一金墨", () => {
    const actionButtonCss = diagramViewCss.match(/\/\* 文字编辑按钮[\s\S]*?\/\* 全屏覆盖层/)?.[0] ?? "";
    const skinSources = `${graphDiagramSource}\n${graphDiagramCss}\n${actionButtonCss}`;
    expect(skinSources).not.toMatch(/#(?:35619d|1d4f91|2f4f6f|243e58|5178c6|7b61c8|b2483b|8a3028)\b/i);
    expect(skinSources).not.toMatch(/rgba?\(\s*(?:53\s*,\s*97\s*,\s*157|47\s*,\s*79\s*,\s*111|83\s*,\s*105\s*,\s*136)/i);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--editor \.react-flow__handle\s*\{[^}]*opacity:\s*0;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-handle-dot\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--mark\) 82%,\s*var\(--ink-1\)\);/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-handle-add\s*\{[^}]*background:\s*#fffaf0;[^}]*pointer-events:\s*none;/s);
    expect(actionButtonCss).toContain("rgba(143, 109, 48, 0.96)");
    expect(actionButtonCss).toMatch(/\.pm-diagram-view-btn--ghost\s*\{[^}]*background:\s*var\(--bg-canvas,\s*#fffaf0\);[^}]*color:\s*var\(--ink-1,\s*#2f2a22\);/s);
  });

  it("选中指示是元素外侧的细包围盒,不跟随形状轮廓也不盖住元素自己的边框", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    await click(findNode("开始", editor));
    const selected = await waitForSelector(".react-flow__node.is-selected", editor);
    expect(selected.classList.contains("selected")).toBe(true);
    expect(selected.querySelector(".graph-diagram-node-shape-svg")).not.toBeNull();
    expect(selected.querySelector(".graph-diagram-node-shape-fill")).not.toBeNull();
    // 跟随形状轮廓的粗描边(会压住元素边框、改边框色看不见)已删除。
    expect(selected.querySelector(".graph-diagram-node-selection-ring")).toBeNull();
    expect(selected.querySelector(".graph-diagram-node-hover-ring")).toBeNull();
    expect(graphDiagramSource).not.toContain("graph-diagram-node-selection-ring");
    expect(graphDiagramSource).not.toContain("graph-diagram-node-hover-ring");
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor \.react-flow__node\.selected\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor \.react-flow__node\.is-selected\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    // 选中指示 = 外壳 ::before 的细包围盒,外移 var(--graph-select-inset)。
    expect(graphDiagramCss).toMatch(/\.graph-diagram-node-shell::before\s*\{[^}]*inset:\s*calc\(var\(--graph-select-inset\) \* -1\);[^}]*border:\s*1\.5px solid var\(--mark\);/s);
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor .react-flow__node.is-selected .graph-diagram-node-shell::before");
    expect(selected.querySelector(".graph-diagram-node-shape-fill")?.getAttribute("style")).toContain("var(--graph-node-stroke)");
    expect(graphDiagramCss).not.toContain("--graph-node-hover-stroke");
    expect(graphDiagramCss).not.toMatch(/\.react-flow__node\.is-selected\s*\{[^}]*outline:\s*2px/s);
  });

  it("全屏关闭后彻底卸载 portal,连续开关不残留也不堆叠", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    for (let i = 0; i < 3; i += 1) {
      const editor = await openEditor();
      expect(document.body.querySelectorAll(".graph-diagram-editor")).toHaveLength(1);
      expect(document.body.querySelectorAll(".graph-diagram-editor .react-flow__pane")).toHaveLength(1);
      await click(editor.querySelector<HTMLButtonElement>(".diagram-editor-chrome__close")!);
      expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();
      expect(document.body.querySelector(".graph-diagram-editor .react-flow__pane")).toBeNull();
    }
  });

  it("Esc 和点击 backdrop 都会关闭全屏编辑器", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    await openEditor();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();

    const editor = await openEditor();
    await mouseDown(editor);
    expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();
  });

  it("多个 GraphDiagramView 同时触发编辑时只保留一个 portal", async () => {
    await render(
      <>
        <EditableDiagramHarness
          source={`flowchart TD
  A[第一] --> B[结束]
`}
        />
        <EditableDiagramHarness
          source={`flowchart TD
  C[第二] --> D[结束]
`}
        />
      </>,
    );
    const firstEditor = await openEditorAt(0);
    expect(firstEditor.textContent).toContain("第一");
    expect(document.body.querySelectorAll(".graph-diagram-editor")).toHaveLength(1);

    const secondEditor = await openEditorAt(1);
    expect(secondEditor.textContent).toContain("第二");
    expect(document.body.querySelectorAll(".graph-diagram-editor")).toHaveLength(1);
  });

  it("全屏编辑层高于表格选择 UI 且自身拦截事件", async () => {
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
      />,
    );
    const editor = await openEditor();
    expect(editor.getAttribute("role")).toBe("dialog");
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor\s*\{[^}]*z-index:\s*2147483000;[^}]*pointer-events:\s*auto;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor\s*\{[^}]*background:\s*var\(--bg-paper-deep,\s*#f6f1e7\);/s);
  });
});

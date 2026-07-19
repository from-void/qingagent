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
import { DiagramRenderer } from "../../components/diagram/DiagramRenderer";
const graphDiagramCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/diagram/graphDiagram.css"), "utf8");

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

async function keyDown(el: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
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
}: {
  source: string;
  initialOverlay?: Parameters<typeof DiagramRenderer>[0]["overlay"];
  onSourceChange?: (source: string) => void;
  onOverlayChange?: Parameters<typeof DiagramRenderer>[0]["onOverlayChange"];
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
  document.body.querySelectorAll(".graph-diagram-editor").forEach((el) => el.remove());
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
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--preview \.react-flow__controls\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(graphDiagramCss).toContain(".graph-diagram:hover .graph-diagram-canvas--preview .react-flow__controls");
  });

  it("外部信号进入全屏后空选可加节点并回写 source", async () => {
    const onSourceChange = vi.fn();
    await render(
      <EditableDiagramHarness
        source={`flowchart TD
  A[开始] --> B[结束]
`}
        onSourceChange={onSourceChange}
      />,
    );
    expect(container?.querySelector(".graph-diagram-edit-entry")).toBeNull();
    expect(container?.querySelector(".graph-diagram-context")).toBeNull();
    const editor = await openEditor();
    expect(document.body.querySelector("select")).toBeNull();
    expect(editor.textContent).not.toContain("点击节点或连线编辑");
    await click(findButton("新增节点", editor));
    expect(onSourceChange).toHaveBeenCalledWith(expect.stringContaining("新节点"));
  });

  it("编辑态节点有四面 handle,默认隐藏并在 hover 或连接态显形", async () => {
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
    expect(editor.querySelectorAll(".react-flow__handle")).toHaveLength(16);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-canvas--editor \.react-flow__handle\s*\{[^}]*display:\s*block;[^}]*opacity:\s*0;/s);
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor .react-flow__node:hover .react-flow__handle");
    expect(graphDiagramCss).toContain(".graph-diagram-canvas--editor.is-connecting .react-flow__handle.connectionindicator");
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
    const addButton = startNode.querySelector<HTMLButtonElement>("button[aria-label='从右侧新增连接节点']");
    expect(addButton).not.toBeNull();
    await click(addButton!);

    const latestSource = onSourceChange.mock.calls.at(-1)?.[0] as string;
    expect(latestSource).toContain("新节点");
    expect(latestSource).toContain("A --> n_新节点");
    const latestOverlay = onOverlayChange.mock.calls.at(-1)?.[0] as NonNullable<Parameters<typeof DiagramRenderer>[0]["overlay"]>;
    expect(latestOverlay?.positions?.n_新节点?.x).toBeGreaterThan(200);
    const fixedHandle = Object.values(latestOverlay?.edgeHandles ?? {}).find((item) => item.sourceHandle === "r");
    expect(fixedHandle).toEqual({ sourceHandle: "r", targetHandle: "l" });
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
    expect(["矩形", "圆角矩形", "体育场/胶囊", "菱形(判断)", "圆形", "六边形", "平行四边形"].map((label) => findButton(label, editor).textContent?.trim())).toEqual([
      "矩形",
      "圆角矩形",
      "体育场/胶囊",
      "菱形(判断)",
      "圆形",
      "六边形",
      "平行四边形",
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
    await waitForSelector("[aria-label='节点上下文操作']", editor);
    expect(editor.querySelectorAll(".graph-diagram-toolbar[aria-label='节点上下文操作']")).toHaveLength(1);
    expect(editor.querySelectorAll(".graph-diagram-shape-grid")).toHaveLength(0);
    expect(editor.querySelectorAll(".graph-diagram-segmented")).toHaveLength(0);
    await openToolbarMenu("填充", editor);
    const swatch = await waitForSelector("button[aria-label='填充色 #d7e7f6']", editor);
    await click(swatch);
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
        A: expect.objectContaining({ fill: "#d7e7f6" }),
      }),
    }));
    expect(onOverlayChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({
        A: expect.objectContaining({ fill: "#d7e7f680" }),
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
    const swatch = await waitForSelector("button[aria-label='线色 #7b61c8']", editor);
    await click(swatch);
    await setInputValue(findInput("线宽(px)", editor), "4");
    const edgeStylePayloads = onOverlayChange.mock.calls
      .map(([payload]) => payload?.edgeStyles)
      .filter(Boolean) as Array<Record<string, { stroke?: string; strokeWidth?: number }>>;
    expect(edgeStylePayloads.some((styles) => Object.values(styles).some((style) => style.stroke === "#7b61c8"))).toBe(true);
    expect(edgeStylePayloads.some((styles) => Object.values(styles).some((style) => style.strokeWidth === 4))).toBe(true);
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("选中态只有自定义一层选中环,React Flow 默认 selected 描边被重置", async () => {
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
    expect(selected.querySelector(".graph-diagram-node-selection-ring")).not.toBeNull();
    expect(selected.querySelector(".graph-diagram-node-hover-ring")).not.toBeNull();
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor \.react-flow__node\.selected\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor \.react-flow__node\.is-selected\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    expect(graphDiagramCss).toContain(".graph-diagram-editor .react-flow__node.is-selected .graph-diagram-node-selection-ring");
    expect(graphDiagramCss).toMatch(/\.graph-diagram-node-selection-ring[\s\S]*opacity:\s*1;[\s\S]*drop-shadow\(0 0 5px rgba\(53,\s*97,\s*157,\s*0\.45\)\)/);
    expect(graphDiagramCss).toContain(".graph-diagram-editor .react-flow__node.is-selected:hover .graph-diagram-node-hover-ring");
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
      await click(findButton("完成", editor));
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
    expect(graphDiagramCss).toMatch(/\.graph-diagram-editor\s*\{[^}]*background:\s*rgba\(246,\s*241,\s*231,\s*0\.98\);/s);
  });
});

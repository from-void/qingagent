import { describe, expect, it } from "vitest";
import {
  applyEdit,
  carryOverDiagramOverlay,
  filterStableOverlay,
  getCapabilities,
  graphToSvg,
  parseDiagram,
  safeMermaid,
  type BaseEdge,
  type ClassGraph,
  type ErGraph,
  type FlowGraph,
  type MindmapTree,
  type StateGraph,
} from "../index";

function edge(model: FlowGraph | StateGraph | ErGraph | ClassGraph): BaseEdge {
  const edges =
    model.type === "flowchart" ? model.edges
    : model.type === "state" ? model.edges
    : model.type === "er" ? model.rels
    : model.rels;
  expect(edges.length).toBeGreaterThan(0);
  return edges[0]!;
}

function expectOnlyChanged(original: string, next: string, changedNeedle: string, stableNeedles: string[]) {
  expect(next).toContain(changedNeedle);
  for (const needle of stableNeedles) expect(next).toContain(needle);
  const originalLines = original.split("\n").filter((line) => stableNeedles.some((needle) => line.includes(needle)));
  for (const line of originalLines) expect(next).toContain(line);
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

describe("diagram-engine", () => {
  it("解析五类节点-边图", () => {
    expect(parseDiagram("flowchart TD\n  A[开始] -->|到达| B[结束]").model.type).toBe("flowchart");
    expect(parseDiagram("stateDiagram-v2\n  state \"打开\" as Open\n  Open --> Closed : close").model.type).toBe("state");
    expect(parseDiagram("erDiagram\n  CUSTOMER ||--o{ ORDER : places").model.type).toBe("er");
    expect(parseDiagram("classDiagram\n  Animal <|-- Duck").model.type).toBe("class");
    expect(parseDiagram("mindmap\n  root\n    child").model.type).toBe("mindmap");
  });

  it("flowchart rewrite 只改目标 span,保留注释/style/class/subgraph/link 文本", () => {
    const source = [
      "flowchart TD",
      "  %% keep comment",
      "  A[旧标签] -->|go| B[结束]",
      "  style A fill:#fff,color:#111",
      "  B:::warn",
      "  subgraph S",
      "    C[只读]",
      "  end",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    const a = (parsed.model as FlowGraph).nodes.find((n) => n.id === "A")!;
    const next = applyEdit(source, { kind: "relabelNode", nodeId: a.id, label: "新标签" });
    expect(next.ok).toBe(true);
    expectOnlyChanged(source, next.source, "A[新标签] -->|go| B[结束]", [
      "%% keep comment",
      "style A fill:#fff,color:#111",
      "B:::warn",
      "subgraph S",
      "C[只读]",
    ]);
  });

  it("flowchart setNodeShape 只改目标节点括号语法,label 和其它字节不动", () => {
    const source = [
      "flowchart TD",
      "  %% keep comment",
      "  A[\"旧标签\"] -->|go| B(结束)",
      "  style A fill:#fff,color:#111",
      "  C[/平行四边形/]",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    const changed = applyEdit(source, { kind: "setNodeShape", nodeId: "A", shape: "hexagon" });
    expect(getCapabilities(parsed, { nodeId: "A" }).find((cap) => cap.op === "setNodeShape")?.enabled).toBe(true);
    expect(changed.ok).toBe(true);
    expect(changed.source).toBe([
      "flowchart TD",
      "  %% keep comment",
      "  A{{\"旧标签\"}} -->|go| B(结束)",
      "  style A fill:#fff,color:#111",
      "  C[/平行四边形/]",
      "",
    ].join("\n"));
    const nextModel = parseDiagram(changed.source).model as FlowGraph;
    expect(nextModel.nodes.find((node) => node.id === "A")?.shape).toBe("{{");
    expect(nextModel.nodes.find((node) => node.id === "A")?.label).toBe("旧标签");
    expect(nextModel.nodes.find((node) => node.id === "C")?.shape).toBe("[/");
  });

  it("flowchart setEdgeLabel 可加/改/删标签且只重写目标边 stmtSpan", () => {
    const source = [
      "flowchart LR",
      "  A[开始] --> B[结束] %% keep tail",
      "  C[旁支] --> D[完成]",
      "",
    ].join("\n");
    const edgeId = (parseDiagram(source).model as FlowGraph).edges.find((item) => item.source === "A")!.id;
    const added = applyEdit(source, { kind: "setEdgeLabel", edgeId, label: "通过" });
    expect(added.ok).toBe(true);
    expect(added.source).toBe([
      "flowchart LR",
      "  A[开始] -->|通过| B[结束] %% keep tail",
      "  C[旁支] --> D[完成]",
      "",
    ].join("\n"));

    const changedEdgeId = (parseDiagram(added.source).model as FlowGraph).edges.find((item) => item.source === "A")!.id;
    const changed = applyEdit(added.source, { kind: "setEdgeLabel", edgeId: changedEdgeId, label: "确认" });
    expect(changed.ok).toBe(true);
    expect(changed.source).toContain("A[开始] -->|确认| B[结束] %% keep tail");
    expect(changed.source).toContain("C[旁支] --> D[完成]");

    const removedEdgeId = (parseDiagram(changed.source).model as FlowGraph).edges.find((item) => item.source === "A")!.id;
    const removed = applyEdit(changed.source, { kind: "setEdgeLabel", edgeId: removedEdgeId, label: "" });
    expect(removed.ok).toBe(true);
    expect(removed.source).toBe(source);
  });

  it("flowchart 解析方向/线型 token 并暴露到边模型", () => {
    const source = [
      "flowchart LR",
      "  A --> B",
      "  B <-- C",
      "  C <--> D",
      "  D --- E",
      "  E -.-> F",
      "  F <-.- G",
      "  G <-.-> H",
      "  H -.- I",
      "  I ==> J",
      "  J <== K",
      "  K <==> L",
      "  L === M",
      "",
    ].join("\n");
    const parsed = parseDiagram(source).model as FlowGraph;
    expect(parsed.edges.map((item) => [item.syntaxKind, item.direction, item.lineStyle])).toEqual([
      ["-->", "forward", "solid"],
      ["<--", "backward", "solid"],
      ["<-->", "both", "solid"],
      ["---", "none", "solid"],
      ["-.->", "forward", "dotted"],
      ["<-.-", "backward", "dotted"],
      ["<-.->", "both", "dotted"],
      ["-.-", "none", "dotted"],
      ["==>", "forward", "thick"],
      ["<==", "backward", "thick"],
      ["<==>", "both", "thick"],
      ["===", "none", "thick"],
    ]);
    expect(parsed.edges.every((item) => item.syntaxSpan && source.slice(item.syntaxSpan.start, item.syntaxSpan.end) === item.syntaxKind)).toBe(true);
  });

  it("flowchart setEdgeArrow 只替换目标边箭头 token 并保留 label 与端点", () => {
    const source = [
      "flowchart LR",
      "  A[开始] -->|通过| B[结束] %% keep tail",
      "  C[旁支] -.-> D[完成]",
      "",
    ].join("\n");
    const firstEdgeId = (parseDiagram(source).model as FlowGraph).edges.find((item) => item.source === "A")!.id;
    const bothDotted = applyEdit(source, { kind: "setEdgeArrow", edgeId: firstEdgeId, direction: "both", lineStyle: "dotted" });
    expect(bothDotted.ok).toBe(true);
    expect(bothDotted.source).toBe([
      "flowchart LR",
      "  A[开始] <-.->|通过| B[结束] %% keep tail",
      "  C[旁支] -.-> D[完成]",
      "",
    ].join("\n"));

    const reparsed = parseDiagram(bothDotted.source).model as FlowGraph;
    const changedEdge = reparsed.edges.find((item) => item.source === "A")!;
    expect(changedEdge.direction).toBe("both");
    expect(changedEdge.lineStyle).toBe("dotted");
    const noneThick = applyEdit(bothDotted.source, { kind: "setEdgeArrow", edgeId: changedEdge.id, direction: "none", lineStyle: "thick" });
    expect(noneThick.ok).toBe(true);
    expect(noneThick.source).toContain("A[开始] ===|通过| B[结束] %% keep tail");
    expect(noneThick.source).toContain("C[旁支] -.-> D[完成]");
  });

  it("flowchart setEdgeArrow 反向带 label 用长形 <---/<=== (短形 Mermaid 解析失败的回归)", () => {
    const source = ["flowchart LR", "  A[开始] -->|通过| B[结束]", ""].join("\n");
    const edgeId = (parseDiagram(source).model as FlowGraph).edges.find((item) => item.source === "A")!.id;

    // 反向实线:必须输出 `<---|通过|`,绝不能是会让 Mermaid 解析失败的短形 `<--|通过|`。
    const backSolid = applyEdit(source, { kind: "setEdgeArrow", edgeId, direction: "backward", lineStyle: "solid" });
    expect(backSolid.ok).toBe(true);
    expect(backSolid.source).toContain("A[开始] <---|通过| B[结束]");
    expect(backSolid.source).not.toContain("<--|通过|");
    const reSolid = (parseDiagram(backSolid.source).model as FlowGraph).edges.find((item) => item.source === "A")!;
    expect(reSolid.direction).toBe("backward");
    expect(reSolid.lineStyle).toBe("solid");
    expect(reSolid.label).toBe("通过");

    // 反向粗线:必须输出 `<===|通过|`,不能是短形 `<==|通过|`。
    const backThick = applyEdit(source, { kind: "setEdgeArrow", edgeId, direction: "backward", lineStyle: "thick" });
    expect(backThick.ok).toBe(true);
    expect(backThick.source).toContain("A[开始] <===|通过| B[结束]");
    expect(backThick.source).not.toContain("<==|通过|");
    const reThick = (parseDiagram(backThick.source).model as FlowGraph).edges.find((item) => item.source === "A")!;
    expect(reThick.direction).toBe("backward");
    expect(reThick.lineStyle).toBe("thick");
    expect(reThick.label).toBe("通过");
  });

  it("unsupported flowchart 元素能力禁用且 rewrite 拒绝", () => {
    const source = "flowchart TD\n  A:::warn --> B\n  classDef warn fill:#fee\n";
    const parsed = parseDiagram(source);
    const e = edge(parsed.model as FlowGraph);
    const caps = getCapabilities(parsed, { edgeId: e.id });
    expect(caps.find((c) => c.op === "deleteEdge")?.enabled).toBe(false);
    expect(applyEdit(source, { kind: "deleteEdge", edgeId: e.id }).ok).toBe(false);
  });

  it("source 含 linkStyle 时边插删重连拒绝且不误改 linkStyle", () => {
    const source = "flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00\n";
    const parsed = parseDiagram(source);
    const e = edge(parsed.model as FlowGraph);
    expect(e.orderIndex).toBe(0);
    expect(getCapabilities(parsed, { edgeId: e.id }).find((c) => c.op === "deleteEdge")?.enabled).toBe(false);
    const next = applyEdit(source, { kind: "deleteEdge", edgeId: e.id });
    expect(next.ok).toBe(false);
    expect(next.source).toContain("linkStyle 0 stroke:#f00");
    expect(applyEdit(source, { kind: "connectEdge", source: "B", target: "C" }).ok).toBe(false);
  });

  it("flowchart 删除带内联 label 的边/节点时保留仍被引用节点的 label", () => {
    const source = "flowchart TD\n  A[起点] --> B[处理]\n  B --> C[结束]\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const deletedEdge = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deletedEdge.ok).toBe(true);
    expect(deletedEdge.source).not.toContain("A[起点]");
    const edgeModel = parseDiagram(deletedEdge.source).model as FlowGraph;
    expect(edgeModel.nodes.find((node) => node.id === "A")).toBeUndefined();
    expect(edgeModel.nodes.find((node) => node.id === "B")?.label).toBe("处理");
    expect(edgeModel.nodes.find((node) => node.id === "C")?.label).toBe("结束");

    const deletedNode = applyEdit(source, { kind: "deleteNode", nodeId: "A" });
    expect(deletedNode.ok).toBe(true);
    const nodeModel = parseDiagram(deletedNode.source).model as FlowGraph;
    expect(nodeModel.nodes.find((node) => node.id === "A")).toBeUndefined();
    expect(nodeModel.nodes.find((node) => node.id === "B")?.label).toBe("处理");
    expect(nodeModel.nodes.find((node) => node.id === "C")?.label).toBe("结束");
  });

  it("flowchart 含 subgraph 时允许顶层 addNode 和删除无关孤立节点,拒绝触碰 subgraph", () => {
    const subgraphBlock = ["  subgraph S", "    Inside[内部] --> Peer[同组]", "  end"].join("\n");
    const source = ["flowchart TD", "  Outside[外部]", subgraphBlock, ""].join("\n");

    const added = applyEdit(source, { kind: "addNode", label: "顶层新增" });
    expect(added.ok).toBe(true);
    expect(added.source).toContain('顶层新增"]');
    expect(added.source).toContain(subgraphBlock);

    const deleted = applyEdit(source, { kind: "deleteNode", nodeId: "Outside" });
    expect(deleted.ok).toBe(true);
    expect(deleted.source).not.toContain("Outside[外部]");
    expect(deleted.source).toContain(subgraphBlock);

    const parsed = parseDiagram(source).model as FlowGraph;
    const innerEdge = parsed.edges.find((item) => item.source === "Inside" && item.target === "Peer")!;
    expect(getCapabilities(parseDiagram(source), { nodeId: "Inside" }).find((cap) => cap.op === "deleteNode")?.enabled).toBe(false);
    expect(applyEdit(source, { kind: "deleteNode", nodeId: "Inside" })).toMatchObject({ ok: false });
    expect(applyEdit(source, { kind: "deleteEdge", edgeId: innerEdge.id })).toMatchObject({ ok: false });
    expect(applyEdit(source, { kind: "connectEdge", source: "Inside", target: "Outside" })).toMatchObject({ ok: false });
  });

  it("flowchart 删除无关早序边后保留未改边 edgeStyles overlay", () => {
    const source = "flowchart TD\n  A[起点] --> B[处理]\n  B --> C[结束]\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const styledEdge = parsed.edges.find((item) => item.source === "B" && item.target === "C")!;
    const overlay = {
      edgeStyles: { [styledEdge.id]: { stroke: "#d14", strokeWidth: 3 } },
      edgeHandles: {
        [styledEdge.id]: { sourceHandle: "r", targetHandle: "l" },
        ORPHAN: { sourceHandle: "b" },
      },
    };

    const deleted = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deleted.ok).toBe(true);
    const nextModel = parseDiagram(deleted.source).model as FlowGraph;
    const nextStyledEdge = nextModel.edges.find((item) => item.source === "B" && item.target === "C")!;
    expect(nextStyledEdge.id).toBe(styledEdge.id);

    const carried = carryOverDiagramOverlay(source, overlay, deleted.source);
    expect(carried?.edgeStyles?.[styledEdge.id]).toEqual({ stroke: "#d14", strokeWidth: 3 });
    expect(carried?.edgeHandles?.[styledEdge.id]).toEqual({ sourceHandle: "r", targetHandle: "l" });
    expect(carried?.edgeHandles?.ORPHAN).toBeUndefined();
    expect(Object.keys(carried?.edgeStyles ?? {})).toEqual([styledEdge.id]);
  });

  it("filterStableOverlay 清理 orphan edgeHandles 且保留稳定边 handle", () => {
    const source = "flowchart LR\n  A[起点] --> B[处理]\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const edgeId = parsed.edges[0]!.id;
    const filtered = filterStableOverlay(source, {
      edgeHandles: {
        [edgeId]: { sourceHandle: "r", targetHandle: "l" },
        ORPHAN: { sourceHandle: "t" },
      },
    });
    expect(filtered?.edgeHandles).toEqual({
      [edgeId]: { sourceHandle: "r", targetHandle: "l" },
    });
  });

  it("flowchart 平行边 id 稳定且可区分", () => {
    const source = "flowchart TD\n  X --> Y\n  A --> B\n  A --> B\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const parallelEdges = parsed.edges.filter((item) => item.source === "A" && item.target === "B");
    expect(parallelEdges).toHaveLength(2);
    expect(new Set(parallelEdges.map((item) => item.id)).size).toBe(2);
    expect((parseDiagram(source).model as FlowGraph).edges.filter((item) => item.source === "A" && item.target === "B").map((item) => item.id)).toEqual(parallelEdges.map((item) => item.id));

    const deleted = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deleted.ok).toBe(true);
    expect((parseDiagram(deleted.source).model as FlowGraph).edges.map((item) => item.id)).toEqual(parallelEdges.map((item) => item.id));
  });

  it("state/er/class 支持简单关系 rewrite", () => {
    const state = "stateDiagram-v2\n  state \"打开\" as Open\n  Done\n  Open --> Closed : close\n";
    const stateEdge = edge(parseDiagram(state).model as StateGraph);
    expect(applyEdit(state, { kind: "reconnectEdge", edgeId: stateEdge.id, newTarget: "Done" }).source).toContain("Open --> Done : close");

    const er = "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n";
    const erEdge = edge(parseDiagram(er).model as ErGraph);
    expect(applyEdit(er, { kind: "deleteEdge", edgeId: erEdge.id }).source).not.toContain("places");

    const cls = "classDiagram\n  class Bird\n  Animal <|-- Duck\n";
    const classEdge = edge(parseDiagram(cls).model as ClassGraph);
    expect(applyEdit(cls, { kind: "reconnectEdge", edgeId: classEdge.id, newSource: "Bird" }).source).toContain("Bird <|-- Duck");
  });

  it("connectEdge 拒绝空白或不存在端点,只连接已存在节点", () => {
    const cases = [
      {
        name: "flowchart",
        source: "flowchart TD\n  A[开始]\n  B[结束]\n",
        sourceId: "A",
        targetId: "B",
        expected: "A --> B",
      },
      {
        name: "state",
        source: "stateDiagram-v2\n  A\n  B\n",
        sourceId: "A",
        targetId: "B",
        expected: "A --> B",
      },
      {
        name: "er",
        source: "erDiagram\n  CUSTOMER\n  ORDER\n",
        sourceId: "CUSTOMER",
        targetId: "ORDER",
        expected: "CUSTOMER ||--o{ ORDER",
      },
      {
        name: "class",
        source: "classDiagram\n  class Animal\n  class Duck\n",
        sourceId: "Animal",
        targetId: "Duck",
        expected: "Animal --> Duck",
      },
    ];

    for (const item of cases) {
      for (const badEndpoint of ["", "   ", "NO_SUCH_NODE"]) {
        expect(applyEdit(item.source, { kind: "connectEdge", source: badEndpoint, target: item.targetId }), item.name).toMatchObject({ ok: false });
        expect(applyEdit(item.source, { kind: "connectEdge", source: item.sourceId, target: badEndpoint }), item.name).toMatchObject({ ok: false });
      }
      const connected = applyEdit(item.source, { kind: "connectEdge", source: item.sourceId, target: item.targetId });
      expect(connected.ok, item.name).toBe(true);
      expect(connected.source).toContain(item.expected);
    }
  });

  it("reconnectEdge 拒绝重连到不存在的节点", () => {
    const flow = "flowchart TD\n  A[开始] --> B[结束]\n";
    const flowEdge = edge(parseDiagram(flow).model as FlowGraph);
    expect(applyEdit(flow, { kind: "reconnectEdge", edgeId: flowEdge.id, newTarget: "NO_SUCH_TARGET" })).toMatchObject({
      ok: false,
      error: "重连目标节点不存在",
    });

    const state = "stateDiagram-v2\n  A --> B : go\n";
    const stateEdge = edge(parseDiagram(state).model as StateGraph);
    expect(applyEdit(state, { kind: "reconnectEdge", edgeId: stateEdge.id, newTarget: "NO_SUCH_TARGET" })).toMatchObject({
      ok: false,
      error: "重连目标节点不存在",
    });

    const er = "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n";
    const erEdge = edge(parseDiagram(er).model as ErGraph);
    expect(applyEdit(er, { kind: "reconnectEdge", edgeId: erEdge.id, newTarget: "NO_SUCH_TARGET" })).toMatchObject({
      ok: false,
      error: "重连目标节点不存在",
    });

    const cls = "classDiagram\n  Animal <|-- Duck\n";
    const classEdge = edge(parseDiagram(cls).model as ClassGraph);
    expect(applyEdit(cls, { kind: "reconnectEdge", edgeId: classEdge.id, newTarget: "NO_SUCH_TARGET" })).toMatchObject({
      ok: false,
      error: "重连目标节点不存在",
    });
  });

  it("ER 属性块实体不可 deleteNode,裸实体仍可删除", () => {
    const withAttrs = "erDiagram\n  CUSTOMER {\n    string name PK\n  }\n";
    const parsedAttrs = parseDiagram(withAttrs).model as ErGraph;
    const customer = parsedAttrs.entities.find((entity) => entity.id === "CUSTOMER")!;
    expect(customer.attrs).toEqual([
      expect.objectContaining({ type: "string", name: "name", keys: ["PK"] }),
    ]);
    expect(getCapabilities(parseDiagram(withAttrs), { nodeId: "CUSTOMER" }).find((cap) => cap.op === "deleteNode")?.enabled).toBe(false);
    expect(applyEdit(withAttrs, { kind: "deleteNode", nodeId: "CUSTOMER" })).toMatchObject({
      ok: false,
      error: "属性块实体只读",
    });

    const inlineAttrs = "erDiagram\n  CUSTOMER { string name }\n";
    const inlineCustomer = (parseDiagram(inlineAttrs).model as ErGraph).entities.find((entity) => entity.id === "CUSTOMER")!;
    expect(inlineCustomer.attrs).toEqual([
      expect.objectContaining({ type: "string", name: "name" }),
    ]);

    const bare = "erDiagram\n  CUSTOMER\n";
    const deleted = applyEdit(bare, { kind: "deleteNode", nodeId: "CUSTOMER" });
    expect(deleted.ok).toBe(true);
    expect(deleted.source).not.toContain("CUSTOMER");
  });

  it("stateDiagram-v2 支持 [*] 起止和中文状态名", () => {
    const source = [
      "stateDiagram-v2",
      "  [*] --> 待审核",
      "  待审核 --> 已批准",
      "  待审核 --> 已驳回",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as StateGraph;
    expect(model.nodes.map((node) => node.id).sort()).toEqual(["__start", "已批准", "已驳回", "待审核"].sort());
    expect(model.nodes.find((node) => node.id === "__start")?.kind).toBe("start");
    expect(model.edges).toHaveLength(3);
    expect(model.edges.map((item) => [item.source, item.target])).toEqual([
      ["__start", "待审核"],
      ["待审核", "已批准"],
      ["待审核", "已驳回"],
    ]);
  });

  it("stateDiagram-v2 addNode 插入状态声明并保留现有 transition", () => {
    const source = "stateDiagram-v2\n  state \"打开\" as Open\n  Closed\n  Open --> Closed : close\n";
    const before = parseDiagram(source).model as StateGraph;
    expect(getCapabilities(parseDiagram(source)).find((cap) => cap.op === "addNode")?.enabled).toBe(true);

    const added = applyEdit(source, { kind: "addNode", label: "待审核" });
    expect(added.ok).toBe(true);
    expect(added.newNodeId).toBeTruthy();
    expect(added.source).toContain(`state "待审核" as ${added.newNodeId}`);
    expect(added.source).toContain("  state \"打开\" as Open\n  Closed\n  Open --> Closed : close\n");

    const after = parseDiagram(added.source).model as StateGraph;
    expect(after.nodes).toHaveLength(before.nodes.length + 1);
    expect(after.nodes.find((node) => node.id === added.newNodeId)?.label).toBe("待审核");
    expect(after.edges.map((item) => [item.source, item.target, item.label])).toEqual(before.edges.map((item) => [item.source, item.target, item.label]));
  });

  it("er/class rename 默认拒绝", () => {
    const er = parseDiagram("erDiagram\n  CUSTOMER ||--o{ ORDER : places\n").model as ErGraph;
    expect(applyEdit("erDiagram\n  CUSTOMER ||--o{ ORDER : places\n", { kind: "relabelNode", nodeId: er.entities[0]!.id, label: "Client" }).ok).toBe(false);
    const cls = parseDiagram("classDiagram\n  Animal <|-- Duck\n").model as ClassGraph;
    expect(applyEdit("classDiagram\n  Animal <|-- Duck\n", { kind: "relabelNode", nodeId: cls.classes[0]!.id, label: "Bird" }).ok).toBe(false);
  });

  it("mindmap 派生 id 稳定、同级重复 label 去重、缩进改父", () => {
    const source = "mindmap\n  root\n    child\n    child\n  other\n";
    const first = parseDiagram(source).model as MindmapTree;
    const second = parseDiagram(source).model as MindmapTree;
    const firstChildren = first.root.children;
    const secondChildren = second.root.children;
    expect(firstChildren[0]!.id).toBe(secondChildren[0]!.id);
    expect(firstChildren[0]!.id).not.toBe(firstChildren[1]!.id);
    const moved = applyEdit(source, { kind: "moveNode", nodeId: firstChildren[0]!.id, newParentId: first.root.children[2]!.id });
    expect(moved.ok).toBe(true);
    expect(moved.source).toContain("  other\n    child");
  });

  it("mindmap 可把前一个同名兄弟移动到后一个同名兄弟下", () => {
    const source = "mindmap\n  root\n    child\n      leaf\n    child\n";
    const tree = parseDiagram(source).model as MindmapTree;
    const [firstChild, secondChild] = tree.root.children;
    const moved = applyEdit(source, { kind: "moveNode", nodeId: firstChild!.id, newParentId: secondChild!.id });
    expect(moved.ok).toBe(true);
    const next = (parseDiagram(moved.source).model as MindmapTree).root;
    expect(next.children).toHaveLength(1);
    expect(next.children[0]!.label).toBe("child");
    expect(next.children[0]!.children[0]!.label).toBe("child");
    expect(next.children[0]!.children[0]!.children[0]!.label).toBe("leaf");
  });

  it("erDiagram / classDiagram 支持中文(非 ASCII)实体名,属性块也解析(治可视化编辑空白)", () => {
    const er = "erDiagram\n  学生 ||--o{ 课程 : 选修\n  学生 {\n    int 学号 PK\n    string 姓名\n  }\n  课程 {\n    int 课程号 PK\n  }";
    const erModel = parseDiagram(er).model as ErGraph;
    expect(erModel.entities.map((e) => e.id).sort()).toEqual(["学生", "课程"]);
    expect(erModel.entities.find((e) => e.id === "学生")!.attrs).toHaveLength(2);
    expect(erModel.rels).toHaveLength(1);
    const cls = "classDiagram\n  动物 <|-- 狗\n  class 动物 {\n    +int 年龄\n    +吃()\n  }";
    const clsModel = parseDiagram(cls).model as ClassGraph;
    expect(clsModel.classes.map((c) => c.id).sort()).toEqual(["动物", "狗"]);
    expect(clsModel.classes.find((c) => c.id === "动物")!.members).toHaveLength(2);
    expect(clsModel.rels).toHaveLength(1);
  });

  it("flowchart 删节点保留被孤立的邻居节点(不连带删除只在被删边里 inline 声明的节点)", () => {
    const source = "flowchart TD\n  A[开始] --> B{判断}\n  B --> C[结束]\n  B --> D[分支]\n";
    const b = (parseDiagram(source).model as FlowGraph).nodes.find((n) => n.label === "判断")!;
    const deleted = applyEdit(source, { kind: "deleteNode", nodeId: b.id });
    expect(deleted.ok).toBe(true);
    const after = parseDiagram(deleted.source).model as FlowGraph;
    const labels = after.nodes.map((n) => n.label).sort();
    // 删 B 后 A/C/D 应作为孤立节点保留,B 本身消失
    expect(labels).toEqual(["分支", "开始", "结束"]);
    expect(after.nodes.map((n) => n.label)).not.toContain("判断");
    // 两端都被孤立的情形也保留
    const src2 = "flowchart TD\n  A[开始] --> B{判断}\n  C[孤立] --> B\n";
    const b2 = (parseDiagram(src2).model as FlowGraph).nodes.find((n) => n.label === "判断")!;
    const after2 = parseDiagram(applyEdit(src2, { kind: "deleteNode", nodeId: b2.id }).source).model as FlowGraph;
    expect(after2.nodes.map((n) => n.label).sort()).toEqual(["孤立", "开始"]);
  });

  it("mindmap 形状语法剥离显示文本(根节点不再显示 root((中心)) 字面量),relabel 保留形状", () => {
    const source = "mindmap\n  root((中心))\n    分支1\n    子项[方形]\n    云((圆))";
    const parsed = parseDiagram(source).model as MindmapTree;
    const nodes = flattenMindmap(parsed.root);
    const byLabel = (l: string) => nodes.find((n) => n.label === l);
    // 根节点显示文本是"中心",不是字面量 "root((中心))"
    expect(parsed.root.label).toBe("中心");
    expect(nodes.map((n) => n.label)).not.toContain("root((中心))");
    // 各形状包裹都被剥离成纯文本
    expect(byLabel("分支1")).toBeTruthy();
    expect(byLabel("方形")).toBeTruthy();
    expect(byLabel("圆")).toBeTruthy();
    // 形状节点现在可编辑(不再被标记 unsupported)
    const relabel = applyEdit(source, { kind: "relabelNode", nodeId: parsed.root.id, label: "新中心" });
    expect(relabel.ok).toBe(true);
    // relabel 保留 id 与圆形包裹
    expect(relabel.source).toContain("root((新中心))");
    expect(parseDiagram(relabel.source).model as MindmapTree).toMatchObject({ root: { label: "新中心" } });
  });

  it("mindmap addNode 在父节点下插入新缩进行,不改写现有 label", () => {
    const source = "mindmap\n  根\n    素材\n      复核";
    const parsed = parseDiagram(source).model as MindmapTree;
    const parent = parsed.root.children[0]!;
    const beforeLabels = flattenMindmap(parsed.root).map((node) => node.label);
    const added = applyEdit(source, { kind: "addNode", parentId: parent.id, label: "新节点" });
    expect(added.ok).toBe(true);
    expect(added.source).toContain("      复核\n      新节点\n");
    expect(added.source).not.toContain("复核      新节点");
    const next = parseDiagram(added.source).model as MindmapTree;
    const afterNodes = flattenMindmap(next.root);
    expect(afterNodes).toHaveLength(beforeLabels.length + 1);
    expect(afterNodes.filter((node) => node.label === "新节点")).toHaveLength(1);
    for (const label of beforeLabels) expect(afterNodes.map((node) => node.label)).toContain(label);
  });

  it("mindmap moveNode 暴露能力并把节点改挂到新父下", () => {
    const source = "mindmap\n  根\n    素材\n      访谈\n    大纲\n      结构\n";
    const parsed = parseDiagram(source);
    const tree = parsed.model as MindmapTree;
    const interview = flattenMindmap(tree.root).find((node) => node.label === "访谈")!;
    const outline = flattenMindmap(tree.root).find((node) => node.label === "大纲")!;
    expect(getCapabilities(parsed, { nodeId: interview.id }).find((cap) => cap.op === "moveNode")?.enabled).toBe(true);
    const moved = applyEdit(source, { kind: "moveNode", nodeId: interview.id, newParentId: outline.id });
    expect(moved.ok).toBe(true);
    expect(moved.source).toContain("    素材\n    大纲\n      结构\n      访谈\n");
    expect(moved.source).not.toContain("素材\n      访谈");
    const next = parseDiagram(moved.source).model as MindmapTree;
    const nextOutline = flattenMindmap(next.root).find((node) => node.label === "大纲")!;
    const nextInterview = flattenMindmap(next.root).find((node) => node.label === "访谈")!;
    expect(nextOutline.children.map((node) => node.label)).toEqual(["结构", "访谈"]);
    expect(nextInterview.id).not.toBe(interview.id);
    expect(moved.idMap?.nodes?.[interview.id]).toBe(nextInterview.id);
    expect(flattenMindmap(next.root).some((node) => node.id === moved.idMap?.nodes?.[interview.id])).toBe(true);
  });

  it("mindmap 删除同名兄弟后返回后续兄弟及子树的 id 映射", () => {
    const source = "mindmap\n  根\n    分支\n      删除\n    分支\n      保留\n";
    const before = (parseDiagram(source).model as MindmapTree).root;
    const [deletedBranch, keptBranch] = before.children;
    const keptLeaf = keptBranch!.children[0]!;

    const deleted = applyEdit(source, { kind: "deleteNode", nodeId: deletedBranch!.id });

    expect(deleted.ok).toBe(true);
    const after = (parseDiagram(deleted.source).model as MindmapTree).root;
    const nextBranch = after.children[0]!;
    const nextLeaf = nextBranch.children[0]!;
    expect(deleted.idMap?.nodes?.[keptBranch!.id]).toBe(nextBranch.id);
    expect(deleted.idMap?.nodes?.[keptLeaf.id]).toBe(nextLeaf.id);
  });

  it("mindmap 改名后返回节点及子树的 id 映射", () => {
    const source = "mindmap\n  根\n    旧名称\n      子节点\n";
    const before = (parseDiagram(source).model as MindmapTree).root;
    const renamedNode = before.children[0]!;
    const child = renamedNode.children[0]!;

    const renamed = applyEdit(source, { kind: "relabelNode", nodeId: renamedNode.id, label: "新名称" });

    expect(renamed.ok).toBe(true);
    const after = (parseDiagram(renamed.source).model as MindmapTree).root.children[0]!;
    expect(renamed.idMap?.nodes?.[renamedNode.id]).toBe(after.id);
    expect(renamed.idMap?.nodes?.[child.id]).toBe(after.children[0]!.id);
  });

  it("safeMermaid 转义 id/label", () => {
    expect(safeMermaid("end").id).not.toBe("end");
    expect(safeMermaid("xray").id.startsWith("n_")).toBe(true);
    expect(safeMermaid('a "quote"\n next').label).toBe('a \\"quote\\"<br> next');
    const parsed = parseDiagram('flowchart TD\n  A["一<br>二"] --> B\n').model as FlowGraph;
    expect(parsed.nodes.find((node) => node.id === "A")?.label).toBe("一\n二");
  });

  it("graphToSvg 渲染五类图并保留 overlay 样式与 SVG 安全", () => {
    const sources = [
      "flowchart TD\n  A[<危险>] -->|确认| B[结束]\n",
      "stateDiagram-v2\n  state \"打开\" as Open\n  Open --> Closed : close\n",
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      "classDiagram\n  Animal <|-- Duck\n",
      "mindmap\n  root\n    child\n",
    ];
    for (const source of sources) {
      const svg = graphToSvg(source, { positions: { A: { x: 99, y: 77 } }, styles: { A: { fill: "#d7e7f6", stroke: "#123456", textColor: "#111111" } } });
      expect(svg).toMatch(/^<svg[^>]+viewBox=/);
      expect(svg).toContain("<rect");
      expect(svg).toContain("<path");
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("<危险>");
    }
    const flowSvg = graphToSvg(sources[0]!, { positions: { A: { x: 99, y: 77 } }, styles: { A: { fill: "#d7e7f6", stroke: "#123456", textColor: "#111111" } } })!;
    expect(flowSvg).toContain('x="99"');
    expect(flowSvg).toContain('fill="#d7e7f6"');
    expect(flowSvg).toContain("&lt;危险&gt;");
    // server Chromium 与 generateSvg 的已验证路径统一走系统 sans-serif；不要再写只在
    // Google Fonts 存在、VPS fonts-noto-cjk 未注册的 Noto Serif SC / Songti SC。
    expect(flowSvg).toContain('font-family="sans-serif"');
    expect(flowSvg).not.toContain("Noto Serif SC");
    expect(flowSvg).not.toContain("Songti SC");
  });

  it("graphToSvg 的 viewBox 覆盖负坐标 overlay", () => {
    const svg = graphToSvg("flowchart LR\n  A[左侧] --> B[右侧]\n", {
      positions: { A: { x: -280, y: -150 }, B: { x: 20, y: 30 } },
    })!;
    const [, minX, minY, width, height] = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)!;
    expect(Number(minX)).toBeLessThan(-280);
    expect(Number(minY)).toBeLessThan(-150);
    expect(Number(minX) + Number(width)).toBeGreaterThan(180);
    expect(Number(minY) + Number(height)).toBeGreaterThan(94);
  });

  it("graphToSvg 节点长标签换行截断且节点/边标签不越画布", () => {
    const nodeLabel = "这是一个非常非常长并且必须在节点宽度内换行后截断的节点标签";
    const edgeLabel = "这是一段需要完整计入导出画布边界的超长边标签".repeat(3);
    const svg = graphToSvg(`flowchart LR\n  A[${nodeLabel}] -->|${edgeLabel}| B[结束]\n`, {
      positions: { A: { x: 0, y: 20 }, B: { x: 220, y: 20 } },
    })!;
    const [, minX, , width] = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)!;
    const maxX = Number(minX) + Number(width);
    const edgeCenterX = (160 + 220) / 2;
    const estimatedEdgeHalfWidth = Array.from(edgeLabel).length * 12 / 2;
    expect(Number(minX)).toBeLessThanOrEqual(edgeCenterX - estimatedEdgeHalfWidth);
    expect(maxX).toBeGreaterThanOrEqual(edgeCenterX + estimatedEdgeHalfWidth);
    expect(svg.match(/<tspan/g)).toHaveLength(3);
    expect(svg).toContain("…</tspan>");
    expect(svg).not.toContain(`>${nodeLabel}</text>`);
  });
});

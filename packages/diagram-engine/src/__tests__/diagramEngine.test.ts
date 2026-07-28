import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  applyZOrderCommand,
  carryOverDiagramOverlay,
  dissolveSubgraph,
  filterStableOverlay,
  getCapabilities,
  getFlowShapeGeometry,
  graphToSvg,
  layoutDiagramGraph,
  moveNodeToSubgraph,
  normalizeFlowShapeName,
  parseDiagram,
  renameSubgraph,
  safeMermaid,
  setSubgraphStyle,
  sortIdsByZOrder,
  wrapNodesInSubgraph,
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

  it("flowchart 按分号切分语句并将链式边展开为相邻边", () => {
    const source = "graph TD; A-->B-->D";
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.nodes.map((node) => node.id)).toEqual(["A", "B", "D"]);
    expect(model.edges.map((item) => [item.source, item.target])).toEqual([
      ["A", "B"],
      ["B", "D"],
    ]);
    expect(model.edges.every((item) => source.slice(item.stmt.start, item.stmt.end).trim() === "A-->B-->D")).toBe(true);
    expect(graphToSvg(source)).toContain("<svg");

    const semicolonSeparated = parseDiagram("graph TD; A-->B; B-->D").model as FlowGraph;
    expect(semicolonSeparated.edges.map((item) => [item.source, item.target])).toEqual([
      ["A", "B"],
      ["B", "D"],
    ]);

    const multiline = parseDiagram("graph TD\nA-->B\nB-->D").model as FlowGraph;
    expect(multiline.nodes.map((node) => node.id)).toEqual(["A", "B", "D"]);
    expect(multiline.edges.map((item) => [item.source, item.target])).toEqual([
      ["A", "B"],
      ["B", "D"],
    ]);
  });

  it("flowchart 链式边保留各段标签线型且多目标继续展开", () => {
    const chain = parseDiagram("flowchart LR; A-->|通过|B-.->C").model as FlowGraph;
    expect(chain.edges.map((item) => [item.source, item.target, item.label, item.lineStyle])).toEqual([
      ["A", "B", "通过", "solid"],
      ["B", "C", undefined, "dotted"],
    ]);

    const multiTarget = parseDiagram("flowchart TD; A-->|分支|B & C").model as FlowGraph;
    expect(multiTarget.nodes.map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(multiTarget.edges.map((item) => [item.source, item.target, item.label])).toEqual([
      ["A", "B", "分支"],
      ["A", "C", "分支"],
    ]);

    const punctuationInLabel = parseDiagram('flowchart TD; A["分号; 与箭头 --> 都是正文"]-->B').model as FlowGraph;
    expect(punctuationInLabel.nodes.find((node) => node.id === "A")?.label).toBe("分号; 与箭头 --> 都是正文");
    expect(punctuationInLabel.edges.map((item) => [item.source, item.target])).toEqual([["A", "B"]]);
  });

  it("flowchart 单边标签含 & 时仍可安全回写，多目标保持只读", () => {
    const source = "flowchart TD\n  A -->|a & b| B\n";
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({
      source: "A",
      target: "B",
      label: "a & b",
      rewritable: true,
    });

    const changed = applyEdit(source, {
      kind: "setEdgeLabel",
      edgeId: model.edges[0]!.id,
      label: "更新 & 保留",
    });
    expect(changed.ok).toBe(true);
    const changedEdge = (parseDiagram(changed.source).model as FlowGraph).edges[0]!;
    const restored = applyEdit(changed.source, {
      kind: "setEdgeLabel",
      edgeId: changedEdge.id,
      label: "a & b",
    });
    expect(restored).toMatchObject({ ok: true, source });

    const multiTarget = parseDiagram("flowchart TD\n  A --> B & C\n").model as FlowGraph;
    expect(multiTarget.edges).toHaveLength(2);
    expect(multiTarget.edges.every((item) => item.rewritable === false)).toBe(true);
  });

  it("flowchart 改名精确覆盖带外侧空白和引号的节点正文", () => {
    for (const declaration of ["A[  hello  ]", 'A[  "hello"  ]']) {
      const source = `flowchart TD\n  ${declaration}\n`;
      const renamed = applyEdit(source, { kind: "relabelNode", nodeId: "A", label: "X" });

      expect(renamed.ok).toBe(true);
      expect((parseDiagram(renamed.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.label).toBe("X");
    }
  });

  it("flowchart 按 Mermaid 官方词法区分紧贴圆叉端点与含 -o/-x 的节点 id", () => {
    const cases = [
      {
        source: "flowchart TD\n  x-o-->B\n",
        nodeIds: ["x-o", "B"],
        edge: { source: "x-o", target: "B", syntaxKind: "-->", sourceMarker: "none" },
      },
      {
        source: "flowchart TD\n  x-o --> B\n",
        nodeIds: ["x-o", "B"],
        edge: { source: "x-o", target: "B", syntaxKind: "-->", sourceMarker: "none" },
      },
      {
        source: "flowchart TD\n  a-x-->b\n",
        nodeIds: ["a-x", "b"],
        edge: { source: "a-x", target: "b", syntaxKind: "-->", sourceMarker: "none" },
      },
      {
        source: "flowchart TD\n  a-x --> b\n",
        nodeIds: ["a-x", "b"],
        edge: { source: "a-x", target: "b", syntaxKind: "-->", sourceMarker: "none" },
      },
    ];

    for (const item of cases) {
      const parsed = parseDiagram(item.source);
      expect(parsed.ok, item.source).toBe(true);
      const model = parsed.model as FlowGraph;
      expect(model.nodes.map((node) => node.id), item.source).toEqual(item.nodeIds);
      expect({
        ...model.edges[0],
        sourceMarker: model.edges[0]?.sourceMarker ?? "none",
      }, item.source).toMatchObject(item.edge);
    }
  });

  it("flowchart 未闭合节点仍返回解析错误", () => {
    const source = "graph TD; A[未闭合 --> B";
    expect(parseDiagram(source)).toMatchObject({ ok: false, error: "节点 A 的形状未闭合" });
    expect(graphToSvg(source)).toBeNull();
  });

  it("flowchart accessibility 指令受保护且解析、改写、渲染与往返均可用", () => {
    const sources = [
      [
        "flowchart TD",
        "  accTitle: 我的标题",
        "  accDescr: 这是单行说明",
        "  A[开始] --> B[结束]",
        "",
      ].join("\n"),
      [
        "flowchart TD",
        "  accTitle: 多行说明图",
        "  accDescr {",
        "    这是多行说明",
        "    A --> Ghost 只是无障碍描述正文",
        "  }",
        "  A[开始] --> B[结束]",
        "",
      ].join("\n"),
    ];

    for (const source of sources) {
      const parsed = parseDiagram(source);
      expect(parsed.ok, source).toBe(true);
      const model = parsed.model as FlowGraph;
      expect(model.nodes.map((node) => node.id), source).toEqual(["A", "B"]);
      expect(graphToSvg(source), source).not.toBeNull();

      const changed = applyEdit(source, { kind: "relabelNode", nodeId: "A", label: "已更新" });
      expect(changed.ok, source).toBe(true);
      expect(changed.source).toContain("accTitle:");
      expect(changed.source).toContain("accDescr");
      const restored = applyEdit(changed.source, { kind: "relabelNode", nodeId: "A", label: "开始" });
      expect(restored).toMatchObject({ ok: true, source });
    }
  });

  it("flowchart a-e 矩阵:顶层 Unicode id 在分区前后、边端点、中英混合和数字开头均不丢失", () => {
    const cases = [
      {
        name: "a. 中文顶层声明在 subgraph 前",
        source: "flowchart TD\n  自由[自由节点]\n  subgraph 区A\n    A1[X]\n  end\n  自由 --> A1\n",
        ids: ["自由", "A1"],
        edge: ["自由", "A1"],
      },
      {
        name: "b. 中文顶层声明在 subgraph 后",
        source: "flowchart TD\n  subgraph 区A\n    A1[X]\n  end\n  自由[自由节点]\n  自由 --> A1\n",
        ids: ["A1", "自由"],
        edge: ["自由", "A1"],
      },
      {
        name: "c. ASCII 对照",
        source: "flowchart TD\n  free[FreeNode]\n  subgraph 区A\n    A1[X]\n  end\n  free --> A1\n",
        ids: ["free", "A1"],
        edge: ["free", "A1"],
      },
      {
        name: "d. 中英混合 id",
        source: "flowchart TD\n  自由A1_2[混合节点]\n  subgraph 区A\n    B1[X]\n  end\n  自由A1_2 --> B1\n",
        ids: ["自由A1_2", "B1"],
        edge: ["自由A1_2", "B1"],
      },
      {
        name: "e. 数字开头 id",
        source: "flowchart TD\n  123节点[数字节点]\n  subgraph 区A\n    C1[X]\n  end\n  123节点 --> C1\n",
        ids: ["123节点", "C1"],
        edge: ["123节点", "C1"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = parseDiagram(testCase.source);
      expect(parsed.ok, testCase.name).toBe(true);
      const model = parsed.model as FlowGraph;
      expect(model.nodes.map((node) => node.id), testCase.name).toEqual(testCase.ids);
      expect(model.edges.map((item) => [item.source, item.target]), testCase.name).toEqual([testCase.edge]);
    }
  });

  it("flowchart Unicode id 覆盖分区成员、classDef/class/:::、style 与 click 目标", () => {
    const source = `flowchart TD
  classDef 高亮 fill:#FFF3C4,stroke:#8A6D1D
  顶层中文[顶层]:::高亮
  subgraph 中文分区[区A]
    区内中文[区内]
    中英A1_2[混合]
    123节点[数字]
  end
  顶层中文 --> 区内中文
  class 顶层中文,区内中文 高亮
  style 中英A1_2 fill:#DDEEFF
  click 123节点 "https://example.com"
`;
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.nodes.map((node) => node.id)).toEqual(["顶层中文", "区内中文", "中英A1_2", "123节点"]);
    expect(model.nodes.every((node) => node.hasStableId)).toBe(true);
    expect(model.nodes.find((node) => node.id === "顶层中文")?.scopePath).toEqual([]);
    expect(model.nodes.filter((node) => node.id !== "顶层中文").every((node) => node.scopePath.join("/") === "中文分区")).toBe(true);
    expect(model.edges.map((item) => [item.source, item.target])).toEqual([["顶层中文", "区内中文"]]);
    expect(model.perNodeStyles?.顶层中文).toMatchObject({ fill: "#FFF3C4", stroke: "#8A6D1D" });
    expect(model.perNodeStyles?.区内中文).toMatchObject({ fill: "#FFF3C4", stroke: "#8A6D1D" });
    expect(model.perNodeStyles?.中英A1_2).toMatchObject({ fill: "#DDEEFF" });
    const svg = graphToSvg(source)!;
    expect(svg.match(/data-node-id=/g)).toHaveLength(4);
    expect(svg.match(/data-edge-id=/g)).toHaveLength(1);
    expect(svg).toContain('data-node-id="顶层中文"');
    expect(svg).toContain('data-node-id="区内中文"');
  });

  it("flowchart 无法识别的非空行返回带 span 的错误且保留已解析节点", () => {
    const source = "flowchart TD\n  A[正常]\n  @@@\n";
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("无法解析第 3 行");
    expect(parsed.errorSpan).toEqual({
      start: source.indexOf("  @@@"),
      end: source.indexOf("  @@@") + "  @@@".length,
    });
    expect((parsed.model as FlowGraph).nodes.map((node) => node.id)).toEqual(["A"]);
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

  it("flowchart 嵌入式标签边记录真实尾箭头且改箭头不破坏拓扑", () => {
    const syntaxCases = [
      { statement: "A -- 实线 --> B", syntax: "-->" },
      { statement: "A -. 点线 .-> B", syntax: ".->" },
      { statement: "A == 粗线 ==> B", syntax: "==>" },
    ];
    for (const item of syntaxCases) {
      const source = `flowchart LR\n  ${item.statement}\n`;
      const parsed = parseDiagram(source).model as FlowGraph;
      expect(parsed.edges).toHaveLength(1);
      expect(source.slice(parsed.edges[0]!.syntaxSpan!.start, parsed.edges[0]!.syntaxSpan!.end)).toBe(item.syntax);
    }

    const source = "flowchart LR\n  A[开始] -- 通过 --> B[结束]\n";
    const before = parseDiagram(source).model as FlowGraph;
    const changed = applyEdit(source, {
      kind: "setEdgeArrow",
      edgeId: before.edges[0]!.id,
      direction: "both",
      lineStyle: "dotted",
    });

    expect(changed.ok).toBe(true);
    const after = parseDiagram(changed.source).model as FlowGraph;
    expect(after.edges).toHaveLength(1);
    expect(after.nodes.map((node) => node.id)).toEqual(["A", "B"]);
    expect(after.edges[0]).toMatchObject({
      source: "A",
      target: "B",
      label: "通过",
      direction: "both",
      lineStyle: "dotted",
    });
    expect(changed.idMap?.edges?.[before.edges[0]!.id]).toBe(after.edges[0]!.id);
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
    // 删一条连线只删这条线:端点只在该语句里声明时(A),要补成独立声明留下来,
    // 不能连带把节点删掉(用户只选中了连线)。
    const edgeModel = parseDiagram(deletedEdge.source).model as FlowGraph;
    expect(edgeModel.edges).toHaveLength(1);
    expect(edgeModel.nodes.find((node) => node.id === "A")?.label).toBe("起点");
    expect(edgeModel.nodes.find((node) => node.id === "B")?.label).toBe("处理");
    expect(edgeModel.nodes.find((node) => node.id === "C")?.label).toBe("结束");

    const deletedNode = applyEdit(source, { kind: "deleteNode", nodeId: "A" });
    expect(deletedNode.ok).toBe(true);
    const nodeModel = parseDiagram(deletedNode.source).model as FlowGraph;
    expect(nodeModel.nodes.find((node) => node.id === "A")).toBeUndefined();
    expect(nodeModel.nodes.find((node) => node.id === "B")?.label).toBe("处理");
    expect(nodeModel.nodes.find((node) => node.id === "C")?.label).toBe("结束");
  });

  it("flowchart 删连线不带走只在该语句里声明的端点(形状与标签一并保留)", () => {
    // 用户只选中连线按删除,期望"只少一条线";端点两个节点必须留在画布上。
    const source = "flowchart TD\n  A[开始] --> B{结束}\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const deleted = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deleted.ok).toBe(true);
    const model = parseDiagram(deleted.source).model as FlowGraph;
    expect(model.edges).toHaveLength(0);
    expect(model.nodes.map((node) => `${node.id}:${node.label}`).sort()).toEqual(["A:开始", "B:结束"]);
    // 形状(菱形)不能在补声明时退化成矩形
    expect(model.nodes.find((node) => node.id === "B")?.shape).toBe("{");
    // 往返:再解析一次仍是两个孤立节点
    expect((parseDiagram(deleted.source).model as FlowGraph).nodes).toHaveLength(2);
  });

  it("flowchart 删连线:裸 id 端点补成裸 id,不凭空造标签", () => {
    const source = "flowchart TD\n  A --> B\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const deleted = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deleted.ok).toBe(true);
    expect(deleted.source).toContain("\n  A\n");
    expect(deleted.source).not.toContain('A["A"]');
    const model = parseDiagram(deleted.source).model as FlowGraph;
    expect(model.nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
  });

  it("flowchart 删连线:端点另有独立声明时不重复补行", () => {
    const source = "flowchart TD\n  A[开始]\n  B[结束]\n  A --> B\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    const deleted = applyEdit(source, { kind: "deleteEdge", edgeId: parsed.edges[0]!.id });
    expect(deleted.ok).toBe(true);
    expect(deleted.source).toBe("flowchart TD\n  A[开始]\n  B[结束]\n");
    const model = parseDiagram(deleted.source).model as FlowGraph;
    expect(model.nodes).toHaveLength(2);
  });

  it("flowchart 链式语句里的边维持拒绝改写,不会连带删掉整行", () => {
    const source = "flowchart TD\n  A[开始] --> B[结束] --> C[尾]\n";
    const parsed = parseDiagram(source).model as FlowGraph;
    expect(parsed.edges).toHaveLength(2);
    for (const edge of parsed.edges) {
      const result = applyEdit(source, { kind: "deleteEdge", edgeId: edge.id });
      expect(result.ok).toBe(false);
      expect(result.source).toBe(source);
    }
  });

  it("flowchart 含 subgraph 时允许顶层 addNode、删除无关孤立节点和连接分区内节点", () => {
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
    const connected = applyEdit(source, { kind: "connectEdge", source: "Inside", target: "Outside" });
    expect(connected).toMatchObject({ ok: true });
    expect(connected.source).toContain("Inside --> Outside");
  });

  it("flowchart 新节点 ID 同时避让节点与 subgraph", () => {
    const source = [
      "flowchart TD",
      '  subgraph Group["分区"]',
      "    Inside[内部]",
      "  end",
      "",
    ].join("\n");

    const added = applyEdit(source, { kind: "addNode", label: "Group" });
    expect(added.ok).toBe(true);
    expect(added.newNodeId).not.toBe("Group");

    const reparsed = parseDiagram(added.source);
    expect(reparsed.ok).toBe(true);
    const model = reparsed.model as FlowGraph;
    const allIds = [...model.nodes.map((node) => node.id), ...model.subgraphs.map((subgraph) => subgraph.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("flowchart 缺失 end 保持容错解析并在首次编辑时补全到根级", () => {
    const source = [
      "flowchart TD",
      '  subgraph Outer["外层"]',
      '    subgraph Inner["内层"]',
      "      A[内部]",
    ].join("\n");
    const before = parseDiagram(source);
    expect(before.ok).toBe(true);
    expect((before.model as FlowGraph).subgraphs.map((subgraph) => [subgraph.id, subgraph.scopePath])).toEqual([
      ["Inner", ["Outer"]],
      ["Outer", []],
    ]);

    const added = applyEdit(source, { kind: "addNode", label: "顶层新增" });
    expect(added.ok).toBe(true);
    expect(added.source.split("\n").filter((line) => line.trim() === "end")).toHaveLength(2);

    const after = parseDiagram(added.source);
    expect(after.ok).toBe(true);
    const model = after.model as FlowGraph;
    expect(model.subgraphs.map((subgraph) => [subgraph.id, subgraph.scopePath])).toEqual([
      ["Inner", ["Outer"]],
      ["Outer", []],
    ]);
    expect(model.nodes.find((node) => node.id === added.newNodeId)?.scopePath).toEqual([]);

    const renamed = renameSubgraph(source, "Outer", "新外层");
    expect(renamed.ok).toBe(true);
    expect(renamed.source.split("\n").filter((line) => line.trim() === "end")).toHaveLength(2);
    expect((parseDiagram(renamed.source).model as FlowGraph).subgraphs.find((subgraph) => subgraph.id === "Outer")?.label).toBe("新外层");
  });

  it("flowchart 多余 end 严格拒绝解析与图形编辑", () => {
    const source = "flowchart TD\n  A[节点]\n  end\n";

    expect(parseDiagram(source)).toMatchObject({ ok: false });
    expect(graphToSvg(source)).toBeNull();
    expect(applyEdit(source, { kind: "addNode", label: "不会新增" })).toMatchObject({
      ok: false,
      source,
    });
  });

  it("wrapNodesInSubgraph 原位包裹连续节点并以中文标题 round-trip", () => {
    const source = [
      "flowchart TD",
      "  A[开始]",
      "  B(处理)",
      "  C[结束]",
      "  A --> B",
      "",
    ].join("\n");
    const wrapped = wrapNodesInSubgraph(source, ["A", "B"], "核心流程");
    expect(wrapped.ok).toBe(true);
    expect(wrapped.newSubgraphId).toBe("subgraph_核心流程");
    expect(wrapped.source).toBe([
      "flowchart TD",
      '  subgraph subgraph_核心流程["核心流程"]',
      "  A[开始]",
      "  B(处理)",
      "  end",
      "  C[结束]",
      "  A --> B",
      "",
    ].join("\n"));
    const model = parseDiagram(wrapped.source).model as FlowGraph;
    expect(model.nodes.find((node) => node.id === "A")?.scopePath).toEqual(["subgraph_核心流程"]);
    expect(model.nodes.find((node) => node.id === "B")?.scopePath).toEqual(["subgraph_核心流程"]);
    expect(model.nodes.find((node) => node.id === "C")?.scopePath).toEqual([]);

    const dissolved = dissolveSubgraph(wrapped.source, wrapped.newSubgraphId!);
    expect(dissolved).toEqual({ ok: true, source });
  });

  it("wrapNodesInSubgraph 支持空分区和父分区内嵌，跨父级节点会拒绝", () => {
    const source = [
      "flowchart TD",
      '  subgraph Outer["外层"]',
      "    A[甲]",
      "    B[乙]",
      "  end",
      "  C[丙]",
      "",
    ].join("\n");
    const empty = wrapNodesInSubgraph(source, [], "空分区", "Outer");
    expect(empty.ok).toBe(true);
    expect(empty.source).toContain('    subgraph subgraph_空分区["空分区"]\n    end\n  end');
    expect((parseDiagram(empty.source).model as FlowGraph).subgraphs.find((item) => item.id === "subgraph_空分区")?.scopePath).toEqual(["Outer"]);

    const nested = wrapNodesInSubgraph(source, ["A", "B"], "内层", "Outer");
    expect(nested.ok).toBe(true);
    expect((parseDiagram(nested.source).model as FlowGraph).subgraphs.find((item) => item.id === "subgraph_内层")?.scopePath).toEqual(["Outer"]);
    expect(dissolveSubgraph(nested.source, "subgraph_内层").source).toBe(source);

    const crossed = wrapNodesInSubgraph(source, ["A", "C"], "跨界");
    expect(crossed).toMatchObject({ ok: false, source, error: "节点不在同一父分区内" });
  });

  it("手写空 subgraph 作为普通布局项进入共享几何与 SVG 空态", () => {
    const source = [
      "flowchart LR",
      '  subgraph Gamma["Gamma区"]',
      "  end",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.nodes).toHaveLength(0);
    expect(model.subgraphs).toEqual([
      expect.objectContaining({ id: "Gamma", label: "Gamma区", scopePath: [] }),
    ]);

    const layout = layoutDiagramGraph(model);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]).toMatchObject({
      id: "Gamma",
      empty: true,
    });
    expect(layout.clusters[0]!.width).toBeGreaterThanOrEqual(160);
    expect(layout.clusters[0]!.height).toBeGreaterThanOrEqual(90);

    const svg = graphToSvg(source);
    expect(svg).not.toBeNull();
    expect(svg).toContain('data-cluster-id="Gamma"');
    expect(svg).toContain('data-empty="true"');
    expect(svg).toContain('stroke-dasharray="6 5"');
    expect(svg).toContain(">Gamma区</text>");
    expect(svg).toContain(">拖入节点</text>");
    expect(svg).not.toContain("data-node-id=");
  });

  it("luna1-TC2：建区、拖入、改名、拖出后保留空块，后续改写不吞区，显式解散才删除", () => {
    const baseline = [
      "flowchart LR",
      "  A[自由节点A]",
      "  B[自由节点B]",
      "",
    ].join("\n");
    const created = wrapNodesInSubgraph(baseline, [], "Gamma区");
    expect(created).toMatchObject({ ok: true, newSubgraphId: "Gamma区" });

    const movedIn = moveNodeToSubgraph(created.source, "A", created.newSubgraphId!);
    expect(movedIn.ok).toBe(true);
    expect((parseDiagram(movedIn.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath)
      .toEqual([created.newSubgraphId]);

    const renamed = renameSubgraph(movedIn.source, created.newSubgraphId!, "Gamma改名");
    expect(renamed.ok).toBe(true);
    const movedOut = moveNodeToSubgraph(renamed.source, "A", null);
    expect(movedOut.ok).toBe(true);
    expect(movedOut.source).toContain(
      `subgraph ${created.newSubgraphId}["Gamma改名"]\n  end`,
    );
    const emptyModel = parseDiagram(movedOut.source).model as FlowGraph;
    expect(emptyModel.subgraphs.find((item) => item.id === created.newSubgraphId)?.label)
      .toBe("Gamma改名");
    expect(emptyModel.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);

    const added = applyEdit(movedOut.source, { kind: "addNode", label: "连续保存节点" });
    expect(added.ok).toBe(true);
    expect((parseDiagram(added.source).model as FlowGraph).subgraphs.map((item) => item.id))
      .toContain(created.newSubgraphId);
    const relabeled = applyEdit(added.source, { kind: "relabelNode", nodeId: "B", label: "已保存" });
    expect(relabeled.ok).toBe(true);
    expect((parseDiagram(relabeled.source).model as FlowGraph).subgraphs.map((item) => item.id))
      .toContain(created.newSubgraphId);

    const dissolved = dissolveSubgraph(relabeled.source, created.newSubgraphId!);
    expect(dissolved.ok).toBe(true);
    expect((parseDiagram(dissolved.source).model as FlowGraph).subgraphs).toHaveLength(0);
    expect(dissolved.source).not.toContain("subgraph ");
    expect(dissolved.source.split("\n").filter((line) => line.trim() === "end")).toHaveLength(0);
  });

  it("wrapNodesInSubgraph 迁移内联声明时只剥离目标形状，边和 class/style 字节保持", () => {
    const source = [
      "flowchart LR",
      "  A[甲] -->|保持| B[乙]",
      "  class A hot",
      "  classDef hot fill:#fff,stroke:#333",
      "",
    ].join("\n");
    const wrapped = wrapNodesInSubgraph(source, ["A"], "甲组");
    expect(wrapped.ok).toBe(true);
    expect(wrapped.source).toContain("  A -->|保持| B[乙]");
    expect(wrapped.source).toContain("  class A hot");
    expect(wrapped.source).toContain("  classDef hot fill:#fff,stroke:#333");
    expect(wrapped.source).toContain("    A[甲]");
    const model = parseDiagram(wrapped.source).model as FlowGraph;
    expect(model.nodes.find((node) => node.id === "A")).toMatchObject({ label: "甲", scopePath: ["subgraph_甲组"] });
    expect(model.nodes.find((node) => node.id === "B")).toMatchObject({ label: "乙", scopePath: [] });
  });

  it("moveNodeToSubgraph 可迁入最深层并迁回父级/根级", () => {
    const source = [
      "flowchart TD",
      "  A[甲]",
      '  subgraph Outer["外层"]',
      '    subgraph Inner["内层"]',
      "      B[乙]",
      "    end",
      "  end",
      "  A --> B",
      "",
    ].join("\n");
    const movedIn = moveNodeToSubgraph(source, "A", "Inner");
    expect(movedIn.ok).toBe(true);
    expect((parseDiagram(movedIn.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath).toEqual(["Outer", "Inner"]);

    const movedToParent = moveNodeToSubgraph(movedIn.source, "A", "Outer");
    expect(movedToParent.ok).toBe(true);
    expect((parseDiagram(movedToParent.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath).toEqual(["Outer"]);

    const movedOut = moveNodeToSubgraph(movedToParent.source, "A", null);
    expect(movedOut.ok).toBe(true);
    expect((parseDiagram(movedOut.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
    expect(movedOut.source).toContain("  A --> B");
  });

  it("带 :::class 的独立节点可迁入、迁出及跨分区且绑定随声明保留", () => {
    const rootSource = [
      "flowchart TD",
      "  A[甲]:::hot",
      '  subgraph Left["左区"]',
      "    L[左]",
      "  end",
      '  subgraph Right["右区"]',
      "    R[右]",
      "  end",
      "  classDef hot fill:#ff0000",
      "",
    ].join("\n");
    const movedIn = moveNodeToSubgraph(rootSource, "A", "Left");
    expect(movedIn.ok).toBe(true);
    expect((parseDiagram(movedIn.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath)
      .toEqual(["Left"]);
    expect(movedIn.source.match(/A\[甲\]:::hot/g)).toHaveLength(1);

    const movedAcross = moveNodeToSubgraph(movedIn.source, "A", "Right");
    expect(movedAcross.ok).toBe(true);
    expect((parseDiagram(movedAcross.source).model as FlowGraph).nodes.find((node) => node.id === "A")?.scopePath)
      .toEqual(["Right"]);
    expect(movedAcross.source.match(/A\[甲\]:::hot/g)).toHaveLength(1);

    const movedOut = moveNodeToSubgraph(movedAcross.source, "A", null);
    expect(movedOut.ok).toBe(true);
    const movedOutModel = parseDiagram(movedOut.source).model as FlowGraph;
    expect(movedOutModel.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
    expect(movedOutModel.perNodeStyles?.A).toMatchObject({ fill: "#ff0000" });
    expect(movedOut.source.match(/A\[甲\]:::hot/g)).toHaveLength(1);
  });

  it("renameSubgraph 只改标题 span，dissolveSubgraph 解散后子分区和节点归父", () => {
    const source = [
      "flowchart TD",
      "  %% keep",
      '  subgraph Outer["旧标题"]',
      "    A[甲]",
      '    subgraph Inner["内层"]',
      "      B[乙]",
      "    end",
      "  end",
      "  style A fill:#fff",
      "",
    ].join("\n");
    const renamed = renameSubgraph(source, "Outer", "新标题");
    expect(renamed.ok).toBe(true);
    expect(renamed.source).toBe(source.replace('"旧标题"', '"新标题"'));
    expect((parseDiagram(renamed.source).model as FlowGraph).subgraphs.find((item) => item.id === "Outer")?.label).toBe("新标题");

    const dissolved = dissolveSubgraph(renamed.source, "Outer");
    expect(dissolved.ok).toBe(true);
    expect(dissolved.source).toContain("  %% keep");
    expect(dissolved.source).toContain("  style A fill:#fff");
    const model = parseDiagram(dissolved.source).model as FlowGraph;
    expect(model.subgraphs.find((item) => item.id === "Outer")).toBeUndefined();
    expect(model.subgraphs.find((item) => item.id === "Inner")?.scopePath).toEqual([]);
    expect(model.nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);
    expect(model.nodes.find((node) => node.id === "B")?.scopePath).toEqual(["Inner"]);
  });

  it("真实云原生 fixture 的父分区内 wrap+dissolve 可逐字节还原", () => {
    const source = readFileSync(new URL("./fixtures-user-cloudnative.mmd", import.meta.url), "utf8");
    const wrapped = wrapNodesInSubgraph(source, ["Web", "iOS", "Android", "Mini"], "终端子组", "U");
    expect(wrapped.ok).toBe(true);
    const wrappedModel = parseDiagram(wrapped.source).model as FlowGraph;
    expect(wrappedModel.nodes.filter((node) => ["Web", "iOS", "Android", "Mini"].includes(node.id)).every(
      (node) => node.scopePath.join("/") === "U/subgraph_终端子组",
    )).toBe(true);
    const dissolved = dissolveSubgraph(wrapped.source, wrapped.newSubgraphId!);
    expect(dissolved.ok).toBe(true);
    expect(dissolved.source).toBe(source);
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
    expect(Object.values(carried ?? {})).not.toContain(undefined);
    expect(carried).toEqual(JSON.parse(JSON.stringify(carried)));
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
    expect(Object.keys(filtered ?? {})).toEqual(["edgeHandles"]);
  });

  it("flowchart 边标签、箭头或端点变化后迁移 edgeStyles 与 edgeHandles", () => {
    const cases: Array<{
      source: string;
      op: (edgeId: string) => Parameters<typeof applyEdit>[1];
    }> = [
      {
        source: "flowchart TD\n  A --> B\n",
        op: (edgeId) => ({ kind: "setEdgeLabel", edgeId, label: "通过" }),
      },
      {
        source: "flowchart TD\n  A --> B\n",
        op: (edgeId) => ({ kind: "setEdgeArrow", edgeId, direction: "both", lineStyle: "dotted" }),
      },
      {
        source: "flowchart TD\n  A --> B\n  C\n",
        op: (edgeId) => ({ kind: "reconnectEdge", edgeId, newTarget: "C" }),
      },
    ];

    for (const item of cases) {
      const beforeEdge = edge(parseDiagram(item.source).model as FlowGraph);
      const overlay = {
        edgeStyles: { [beforeEdge.id]: { stroke: "#d14", strokeWidth: 3 } },
        edgeHandles: { [beforeEdge.id]: { sourceHandle: "r", targetHandle: "l" } },
      };
      const changed = applyEdit(item.source, item.op(beforeEdge.id));
      expect(changed.ok).toBe(true);
      const afterEdge = edge(parseDiagram(changed.source).model as FlowGraph);
      expect(afterEdge.id).not.toBe(beforeEdge.id);
      expect(changed.idMap?.edges?.[beforeEdge.id]).toBe(afterEdge.id);
      expect(carryOverDiagramOverlay(item.source, overlay, changed.source, changed.idMap)).toEqual({
        edgeStyles: { [afterEdge.id]: { stroke: "#d14", strokeWidth: 3 } },
        edgeHandles: { [afterEdge.id]: { sourceHandle: "r", targetHandle: "l" } },
      });
    }
  });

  it("state、ER、class 边重连后返回身份映射并保留 overlay", () => {
    const cases: Array<{
      source: string;
      op: (edgeId: string) => Parameters<typeof applyEdit>[1];
    }> = [
      {
        source: "stateDiagram-v2\n  Open --> Closed : close\n  Done\n",
        op: (edgeId) => ({ kind: "reconnectEdge", edgeId, newTarget: "Done" }),
      },
      {
        source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ARCHIVE\n",
        op: (edgeId) => ({ kind: "reconnectEdge", edgeId, newTarget: "ARCHIVE" }),
      },
      {
        source: "classDiagram\n  Animal <|-- Duck\n  class Bird\n",
        op: (edgeId) => ({ kind: "reconnectEdge", edgeId, newSource: "Bird" }),
      },
    ];

    for (const item of cases) {
      const beforeEdge = edge(parseDiagram(item.source).model as StateGraph | ErGraph | ClassGraph);
      const overlay = {
        edgeStyles: { [beforeEdge.id]: { stroke: "#d14" } },
        edgeHandles: { [beforeEdge.id]: { sourceHandle: "b", targetHandle: "t" } },
      };
      const changed = applyEdit(item.source, item.op(beforeEdge.id));
      expect(changed.ok).toBe(true);
      const afterEdge = edge(parseDiagram(changed.source).model as StateGraph | ErGraph | ClassGraph);
      expect(afterEdge.id).not.toBe(beforeEdge.id);
      expect(changed.idMap?.edges?.[beforeEdge.id]).toBe(afterEdge.id);
      expect(carryOverDiagramOverlay(item.source, overlay, changed.source, changed.idMap)).toEqual({
        edgeStyles: { [afterEdge.id]: { stroke: "#d14" } },
        edgeHandles: { [afterEdge.id]: { sourceHandle: "b", targetHandle: "t" } },
      });
    }
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

  it("特殊 State 声明与冒号式 Class 成员禁用同名节点删除", () => {
    const stateCases: Array<[string, string]> = [
      ["stateDiagram-v2\n  state Decision <<choice>>\n  Decision --> Done\n", "Decision"],
      ["stateDiagram-v2\n  state Parallel <<fork>>\n  Parallel --> Done\n", "Parallel"],
      ["stateDiagram-v2\n  state Merge <<join>>\n  Ready --> Merge\n", "Merge"],
      ["stateDiagram-v2\n  state Group {\n    Inner\n  }\n  Group --> Done\n", "Group"],
    ];
    for (const [source, specialId] of stateCases) {
      expect(parseDiagram(source).fullyRepresented).toBe(false);
      expect(getCapabilities(parseDiagram(source), { nodeId: specialId }).find((cap) => cap.op === "deleteNode")).toMatchObject({
        enabled: false,
        reason: "该节点含未完整建模的特殊 State 声明，暂不可删除",
      });
      expect(applyEdit(source, { kind: "deleteNode", nodeId: specialId })).toMatchObject({
        ok: false,
        error: "该节点含未完整建模的特殊 State 声明，暂不可删除",
        source,
      });
    }

    const classSource = "classDiagram\n  Customer : +String name\n  Customer --> Order\n";
    expect(parseDiagram(classSource).fullyRepresented).toBe(false);
    expect(getCapabilities(parseDiagram(classSource), { nodeId: "Customer" }).find((cap) => cap.op === "deleteNode")).toMatchObject({
      enabled: false,
      reason: "该 class 含未完整建模的冒号式成员，暂不可删除",
    });
    expect(applyEdit(classSource, { kind: "deleteNode", nodeId: "Customer" })).toMatchObject({
      ok: false,
      error: "该 class 含未完整建模的冒号式成员，暂不可删除",
      source: classSource,
    });
  });

  it("未建模的 init 配置与样式属性不宣称完整表示", () => {
    const cases = [
      `%%{init: {"theme":"dark"}}%%
flowchart TD
  A --> B
`,
      `%%{init: {"flowchart":{"curve":"basis"}}}%%
flowchart TD
  A --> B
`,
      `flowchart TD
  A --> B
  style A rx:24,ry:24
`,
      `flowchart TD
  A --> B
  classDef rounded fill:#fff,rx:24
  class A rounded
`,
      `flowchart TD
  A --> B
  linkStyle 0 stroke:#333,animation:fast
`,
    ];

    for (const source of cases) {
      expect(parseDiagram(source).ok, source).toBe(true);
      expect(parseDiagram(source).fullyRepresented, source).toBe(false);
    }
  });

  it("无法保真渲染的 bumpX 边曲线不宣称完整表示", () => {
    const source = `flowchart TD
  A --> B
  linkStyle 0 curve:bumpX
`;

    expect(parseDiagram(source)).toMatchObject({
      ok: true,
      fullyRepresented: false,
    });
  });

  it("会被钳制的 99px 节点线宽不宣称完整表示", () => {
    const source = `flowchart TD
  A --> B
  style A stroke-width:99px
`;

    expect(parseDiagram(source)).toMatchObject({
      ok: true,
      fullyRepresented: false,
    });
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

  it("state/ER/class 的 Unicode、混合和数字开头 id 与 flowchart 口径一致", () => {
    const state = parseDiagram(`stateDiagram-v2
  123状态 --> 中英State_2
  classDef 高亮 fill:#FFF3C4
  class 123状态 高亮
  style 中英State_2 fill:#DDEEFF
`).model as StateGraph;
    expect(state.nodes.map((node) => [node.id, node.hasStableId])).toEqual([
      ["123状态", true],
      ["中英State_2", true],
    ]);
    expect(state.edges.map((item) => [item.source, item.target])).toEqual([["123状态", "中英State_2"]]);
    expect(state.perNodeStyles?.["123状态"]).toMatchObject({ fill: "#FFF3C4" });
    expect(state.perNodeStyles?.中英State_2).toMatchObject({ fill: "#DDEEFF" });

    const er = parseDiagram("erDiagram\n  123实体 ||--o{ 中英Entity_2 : 关联\n").model as ErGraph;
    expect(er.entities.map((entity) => entity.id)).toEqual(["123实体", "中英Entity_2"]);
    expect(er.rels.map((item) => [item.source, item.target])).toEqual([["123实体", "中英Entity_2"]]);

    const cls = parseDiagram("classDiagram\n  123类 <|-- 中英Class_2\n").model as ClassGraph;
    expect(cls.classes.map((item) => item.id)).toEqual(["123类", "中英Class_2"]);
    expect(cls.rels.map((item) => [item.source, item.target])).toEqual([["123类", "中英Class_2"]]);

    const mindmap = parseDiagram("mindmap\n  中文根\n    中英Child_2\n    123节点\n").model as MindmapTree;
    expect(flattenMindmap(mindmap.root).map((node) => node.label)).toEqual(["中文根", "中英Child_2", "123节点"]);
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

  it("flowchart 删除嵌入式标签边的一端时保留仅在该边声明的另一端", () => {
    const source = "flowchart TD\n  A[开始] -- 通过 --> B{判断}\n";
    const deleted = applyEdit(source, { kind: "deleteNode", nodeId: "B" });

    expect(deleted.ok).toBe(true);
    const after = parseDiagram(deleted.source).model as FlowGraph;
    expect(after.edges).toHaveLength(0);
    expect(after.nodes.map((node) => [node.id, node.label, node.shape])).toEqual([
      ["A", "开始", "["],
    ]);
  });

  it("空 mindmap 的合成根不可改名且不会覆盖图类型头", () => {
    const source = "mindmap\n";
    const parsed = parseDiagram(source);
    const root = (parsed.model as MindmapTree).root;

    expect(root.hasStableId).toBe(false);
    expect(getCapabilities(parsed, { nodeId: root.id }).find((cap) => cap.op === "relabelNode")).toMatchObject({
      enabled: false,
    });
    expect(applyEdit(source, { kind: "relabelNode", nodeId: root.id, label: "新根" })).toMatchObject({
      ok: false,
      source,
    });
    expect(parseDiagram(source)).toMatchObject({ ok: true, model: { type: "mindmap" } });
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

  it("mindmap 新增和改名可往返引号、反斜杠与换行", () => {
    const label = '引号"、反斜杠\\与\n换行';
    const source = "mindmap\n  root((中心))\n";
    const root = (parseDiagram(source).model as MindmapTree).root;

    const added = applyEdit(source, { kind: "addNode", parentId: root.id, label });
    expect(added.ok).toBe(true);
    expect(added.newNodeId).toBeDefined();
    expect(flattenMindmap((parseDiagram(added.source).model as MindmapTree).root).find((node) => node.id === added.newNodeId)?.label).toBe(label);

    const renamed = applyEdit(source, { kind: "relabelNode", nodeId: root.id, label });
    expect(renamed.ok).toBe(true);
    expect((parseDiagram(renamed.source).model as MindmapTree).root.label).toBe(label);
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

  it("graphToSvg 渲染五类图，flowchart 保留 overlay 样式与 SVG 安全", () => {
    const sources = [
      "flowchart TD\n  A[<危险>] -->|确认| B[结束]\n",
      "stateDiagram-v2\n  state \"打开\" as Open\n  Open --> Closed : close\n",
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      "classDiagram\n  Animal <|-- Duck\n",
      "mindmap\n  root\n    child\n",
    ];
    for (const source of sources) {
      const svg = graphToSvg(source);
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

  it("专有语义图带 overlay 时拒绝通用 SVG，交给官方 Mermaid 渲染", () => {
    const sources = [
      "stateDiagram-v2\n  [*] --> Active\n  Active --> [*]\n",
      "erDiagram\n  CUSTOMER {\n    string name PK\n  }\n  CUSTOMER ||--o{ ORDER : places\n",
      "classDiagram\n  class Customer {\n    +String name\n  }\n  Customer <|-- VipCustomer\n",
      "mindmap\n  root\n    child\n",
    ];
    const overlay = { positions: { CUSTOMER: { x: 120, y: 80 } } };

    for (const source of sources) {
      expect(graphToSvg(source), source).not.toBeNull();
      expect(graphToSvg(source, overlay), source).toBeNull();
    }

    expect(graphToSvg("flowchart TD\n  A --> B\n", { positions: { A: { x: 120, y: 80 } } })).not.toBeNull();
  });

  it("解析经典色板 init 与 classDef/class,graphToSvg 按节点样式和图级色板上色", () => {
    const source = `%%{init: {'theme':'base','themeVariables':{'primaryColor':'#F0F4FC','mainBkg':'#FFFFFF','primaryBorderColor':'#345678','nodeBorder':'#5178C6','lineColor':'#BBBFC4','primaryTextColor':'#333333','textColor':'#1F2329','clusterBkg':'#F0F4FC','clusterBorder':'#5178C6'}}}%%
flowchart TD
  A[开始]:::blue --> B[复核]
  B --> C[结束]
  classDef blue fill:#FFFFFF,stroke:#5178C6,stroke-width:2px,color:#1F2329
  classDef purple fill:#F8F5FF,stroke:#8569CB,stroke-width:3px,color:#31265C
  class B,C purple
`;
    const parsed = parseDiagram(source);
    const model = parsed.model as FlowGraph;

    expect(parsed.themePalette).toEqual({
      nodeFill: "#FFFFFF",
      nodeStroke: "#5178C6",
      lineColor: "#BBBFC4",
      textColor: "#1F2329",
      clusterFill: "#F0F4FC",
      clusterStroke: "#5178C6",
    });
    expect(model.themePalette).toEqual(parsed.themePalette);
    expect(model.perNodeStyles).toEqual({
      A: { fill: "#FFFFFF", stroke: "#5178C6", strokeWidth: 2, textColor: "#1F2329" },
      B: { fill: "#F8F5FF", stroke: "#8569CB", strokeWidth: 3, textColor: "#31265C" },
      C: { fill: "#F8F5FF", stroke: "#8569CB", strokeWidth: 3, textColor: "#31265C" },
    });

    const svg = graphToSvg(source)!;
    expect(svg).toMatch(/data-node-id="A"><rect[^>]+fill="#FFFFFF"[^>]+stroke="#5178C6"/);
    expect(svg).toMatch(/data-node-id="B"><rect[^>]+fill="#F8F5FF"[^>]+stroke="#8569CB"/);
    expect(svg).toContain('stroke="#BBBFC4"');
    expect(svg).toContain('d="M0,0 L0,6 L9,3 z" fill="#BBBFC4"');
    expect(svg).not.toContain('stroke="#b08a3e"');

    const overlaySvg = graphToSvg(source, { styles: { A: { fill: "#D7E7F6", stroke: "#123456", textColor: "#111111" } } })!;
    expect(overlaySvg).toMatch(/data-node-id="A"><rect[^>]+fill="#D7E7F6"[^>]+stroke="#123456"/);
  });

  it("classDef 与 linkStyle 的行尾 %% 注释不影响样式及 # 颜色值", () => {
    const source = [
      "flowchart TD",
      "  A[开始] --> B[结束]",
      "  classDef hot fill:#ff0000,stroke:#112233 %% 节点样式注释",
      "  class A hot",
      "  linkStyle 0 stroke:#445566,stroke-width:3px %% 边样式注释",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.perNodeStyles?.A).toMatchObject({
      fill: "#ff0000",
      stroke: "#112233",
    });
    expect(model.perEdgeStyles?.[model.edges[0]!.id]).toMatchObject({
      stroke: "#445566",
      strokeWidth: 3,
    });
  });

  it("flowchart 分区支持 classDef/class 与 style，并可保留其它声明安全改色", () => {
    const source = [
      "flowchart TD",
      '  subgraph Zone["业务区"]',
      "    A[开始]",
      "  end",
      "  classDef paper fill:#f3ecdd,stroke:#8f6d30",
      "  class Zone paper",
      "  style Zone stroke-width:3px,fill:#efe3cc %% 分区样式",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    expect((parsed.model as FlowGraph).perSubgraphStyles?.Zone).toMatchObject({
      fill: "#efe3cc",
      stroke: "#8f6d30",
      strokeWidth: 3,
    });
    expect(graphToSvg(source)).toMatch(/data-cluster-id="Zone"[\s\S]*?<rect[^>]+fill="#efe3cc"[^>]+stroke="#8f6d30"/);

    const rewritten = setSubgraphStyle(source, "Zone", { fill: "#f8e7a1", stroke: "#6a6256" });
    expect(rewritten.ok).toBe(true);
    expect(rewritten.source).toContain("style Zone stroke-width:3px,fill:#f8e7a1,stroke:#6a6256 %% 分区样式");
    expect((parseDiagram(rewritten.source).model as FlowGraph).perSubgraphStyles?.Zone).toMatchObject({
      fill: "#f8e7a1",
      stroke: "#6a6256",
      strokeWidth: 3,
    });
  });

  it("flowchart 节点 width/height 可由 Mermaid style 或持久化 overlay 驱动布局与导出", () => {
    const source = [
      "flowchart LR",
      "  A[可调节点] --> B[结束]",
      "  style A width:240px,height:112px",
      "",
    ].join("\n");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    expect((parsed.model as FlowGraph).perNodeStyles?.A).toMatchObject({ width: 240, height: 112 });

    const sourceLayout = layoutDiagramGraph(parsed.model);
    expect(sourceLayout.nodes.A).toMatchObject({ width: 240, height: 112 });

    const overlay = { styles: { A: { width: 296, height: 144 } } };
    const overlayLayout = layoutDiagramGraph(parsed.model, overlay);
    expect(overlayLayout.nodes.A).toMatchObject({ width: 296, height: 144 });
    const svg = graphToSvg(source, overlay)!;
    expect(svg).toContain('data-layout-width="296"');
    expect(svg).toContain('data-layout-height="144"');
  });

  it("五类图都接住 init 图级色板,无 init 的 graphToSvg 保持纸墨默认", () => {
    const init = "%%{init: {\"themeVariables\":{\"mainBkg\":\"#FFFFFF\",\"nodeBorder\":\"#5178C6\",\"lineColor\":\"#BBBFC4\",\"textColor\":\"#1F2329\"}}}%%\n";
    const sources = [
      `${init}flowchart TD\n  A --> B\n`,
      `${init}stateDiagram-v2\n  Open --> Closed\n`,
      `${init}erDiagram\n  CUSTOMER ||--o{ ORDER : places\n`,
      `${init}classDiagram\n  Animal <|-- Duck\n`,
      `${init}mindmap\n  root\n    child\n`,
    ];
    for (const source of sources) {
      expect(parseDiagram(source).model.themePalette).toMatchObject({
        nodeFill: "#FFFFFF",
        nodeStroke: "#5178C6",
        lineColor: "#BBBFC4",
        textColor: "#1F2329",
      });
    }

    const defaultSvg = graphToSvg("flowchart TD\n  A[开始] --> B[结束]\n")!;
    expect(defaultSvg).toMatch(/data-node-id="A"><rect[^>]+fill="#efe3cc"[^>]+stroke="#b08a3e"/);
    expect(defaultSvg).toContain('d="M0,0 L0,6 L9,3 z" fill="#8d7447"');

    const invalidColorSource = `%%{init: {'themeVariables':{'mainBkg':'url(javascript:alert(1))','primaryColor':'#FFFFFF','nodeBorder':'red','primaryBorderColor':'#5178C6','lineColor':'var(--bad)'}}}%%
flowchart TD
  A --> B
  classDef bad fill:url(javascript:alert(1)),stroke:expression(alert(1)),color:red
  class A bad
`;
    const invalidParsed = parseDiagram(invalidColorSource).model;
    expect(invalidParsed.themePalette).toEqual({ nodeFill: "#FFFFFF", nodeStroke: "#5178C6" });
    expect(invalidParsed.perNodeStyles).toBeUndefined();
    expect(graphToSvg(invalidColorSource)).not.toContain("javascript:");
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

  it("真实云原生 fixture:8 个分区、节点归属、色板、线型和标签完整进入共享布局与 SVG", () => {
    const source = readFileSync(new URL("./fixtures-user-cloudnative.mmd", import.meta.url), "utf8");
    const parsed = parseDiagram(source);
    expect(parsed.ok).toBe(true);
    const model = parsed.model as FlowGraph;
    expect(model.nodes).toHaveLength(35);
    expect(model.edges).toHaveLength(48);
    expect(model.subgraphs.map((subgraph) => [subgraph.id, subgraph.label])).toEqual([
      ["U", "用户终端层"],
      ["AS", "接入与安全层"],
      ["GW", "服务网关层"],
      ["BIZ", "业务中台"],
      ["DATA", "数据与中间件层"],
      ["INFRA", "基础设施层"],
      ["OBS", "监控可观测性"],
      ["FLOW", "核心业务流程"],
    ]);
    expect(model.themePalette).toMatchObject({ clusterFill: "#F0F4FC", clusterStroke: "#5178C6" });
    expect(new Set(model.edges.map((item) => item.lineStyle))).toEqual(new Set(["solid", "dotted", "thick"]));
    expect(model.edges.filter((item) => item.lineStyle === "dotted").map((item) => item.label)).toEqual(
      expect.arrayContaining(["触发", "扣减", "采集指标", "追踪链路", "采集日志"]),
    );

    const layout = layoutDiagramGraph(model);
    expect(layout.clusters).toHaveLength(8);
    const clusterById = new Map(layout.clusters.map((cluster) => [cluster.id, cluster]));
    for (const node of model.nodes.filter((item) => item.scopePath.length > 0)) {
      const rect = layout.nodes[node.id]!;
      const cluster = clusterById.get(node.scopePath.at(-1)!)!;
      expect(rect.x).toBeGreaterThanOrEqual(cluster.x);
      expect(rect.y).toBeGreaterThanOrEqual(cluster.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(cluster.x + cluster.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(cluster.y + cluster.height);
    }

    const svg = graphToSvg(source)!;
    expect(svg.match(/data-cluster-id=/g)).toHaveLength(8);
    expect(svg).toContain('fill="#F0F4FC"');
    expect(svg).toContain('stroke="#5178C6"');
    expect(svg).toContain('data-line-style="dotted"');
    expect(svg).toContain('data-line-style="thick"');
    expect(svg).toContain(">触发</text>");
  });

  it("subgraph 显式标题、递归嵌套、内部 direction 与边到分区 id 共享同一几何", () => {
    const source = `flowchart TB
  Start[开始] --> Outer
  subgraph Outer["外层"]
    direction LR
    A[入口] --> Inner
    subgraph Inner["内层"]
      direction BT
      B[下游] --> C[上游]
    end
  end
`;
    const model = parseDiagram(source).model as FlowGraph;
    expect(model.nodes.some((node) => node.id === "Outer" || node.id === "Inner")).toBe(false);
    expect(model.subgraphs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Outer", label: "外层", scopePath: [], direction: "LR" }),
      expect.objectContaining({ id: "Inner", label: "内层", scopePath: ["Outer"], direction: "BT" }),
    ]));
    expect(model.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "Start", target: "Outer" }),
      expect.objectContaining({ source: "A", target: "Inner" }),
    ]));

    const layout = layoutDiagramGraph(model);
    const outer = layout.clusters.find((cluster) => cluster.id === "Outer")!;
    const inner = layout.clusters.find((cluster) => cluster.id === "Inner")!;
    expect(outer.direction).toBe("LR");
    expect(inner.direction).toBe("BT");
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
    expect(layout.nodes.B!.y).toBeGreaterThan(layout.nodes.C!.y);

    const svg = graphToSvg(source)!;
    for (const cluster of layout.clusters) {
      expect(svg).toContain(`data-cluster-id="${cluster.id}" data-layout-x="${cluster.x}" data-layout-y="${cluster.y}" data-layout-width="${cluster.width}" data-layout-height="${cluster.height}"`);
    }
  });

  it("subgraph 跟随全部成员的 overlay 位移等量平移并保持包络尺寸", () => {
    const model = parseDiagram(`flowchart LR
  subgraph Outer["外层"]
    A[甲]
    B[乙]
  end
`).model as FlowGraph;
    const before = layoutDiagramGraph(model, {
      positions: { A: { x: 80, y: 90 }, B: { x: 300, y: 90 } },
    }).clusters.find((cluster) => cluster.id === "Outer")!;
    const after = layoutDiagramGraph(model, {
      positions: { A: { x: 220, y: 160 }, B: { x: 440, y: 160 } },
    }).clusters.find((cluster) => cluster.id === "Outer")!;

    expect(after.x - before.x).toBe(140);
    expect(after.y - before.y).toBe(70);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });

  it("subgraph 自身位置可写入 overlay，空分区和后代节点都随位置稳定往返", () => {
    const source = `flowchart LR
  subgraph Outer["外层"]
    A[甲]
  end
  subgraph Empty["空区"]
  end
`;
    const model = parseDiagram(source).model as FlowGraph;
    const before = layoutDiagramGraph(model);
    const outerBefore = before.clusters.find((cluster) => cluster.id === "Outer")!;
    const emptyBefore = before.clusters.find((cluster) => cluster.id === "Empty")!;
    const overlay = {
      positions: {
        Outer: { x: outerBefore.x + 120, y: outerBefore.y + 60 },
        Empty: { x: 680, y: 420 },
        ORPHAN: { x: 1, y: 2 },
      },
    };
    const after = layoutDiagramGraph(model, overlay);
    const outerAfter = after.clusters.find((cluster) => cluster.id === "Outer")!;
    const emptyAfter = after.clusters.find((cluster) => cluster.id === "Empty")!;

    expect(outerAfter).toMatchObject({ x: outerBefore.x + 120, y: outerBefore.y + 60 });
    expect(after.nodes.A!.x - before.nodes.A!.x).toBe(120);
    expect(after.nodes.A!.y - before.nodes.A!.y).toBe(60);
    expect(emptyAfter).toMatchObject({ x: 680, y: 420 });
    expect(filterStableOverlay(source, overlay)?.positions).toEqual({
      Outer: overlay.positions.Outer,
      Empty: overlay.positions.Empty,
    });
  });

  it("链式、多目标、两种标签、不可见边、圆/叉端点与 linkStyle 都进入边模型", () => {
    const source = `flowchart LR
  A -->|管道标签| B --> C
  A -- 文本标签 --> D
  A --> E & F
  B ~~~ F
  C o--x D
  linkStyle 0,2 stroke:#123456,stroke-width:4px,color:#654321,stroke-dasharray:8 3
`;
    const model = parseDiagram(source).model as FlowGraph;
    expect(model.edges.map((item) => [item.source, item.target])).toEqual([
      ["A", "B"],
      ["B", "C"],
      ["A", "D"],
      ["A", "E"],
      ["A", "F"],
      ["B", "F"],
      ["C", "D"],
    ]);
    expect(model.edges[0]?.label).toBe("管道标签");
    expect(model.edges[2]?.label).toBe("文本标签");
    expect(model.edges[5]).toMatchObject({ lineStyle: "invisible", direction: "none" });
    expect(model.edges[6]).toMatchObject({ sourceMarker: "circle", targetMarker: "cross" });
    expect(model.perEdgeStyles?.[model.edges[0]!.id]).toMatchObject({
      stroke: "#123456",
      textColor: "#654321",
      strokeWidth: 4,
      dashArray: "8 3",
    });
    expect(model.perEdgeStyles?.[model.edges[2]!.id]).toMatchObject({ stroke: "#123456" });
    const svg = graphToSvg(source)!;
    expect(svg).toContain('data-line-style="invisible"');
    expect(svg).toContain('visibility="hidden"');
    expect(svg).toContain('marker-start="url(#circle-edge)"');
    expect(svg).toContain('marker-end="url(#cross-edge)"');
  });

  it("加长 link token 增加共享布局的层级间距", () => {
    const shortModel = parseDiagram("flowchart LR\n  A --> B\n").model as FlowGraph;
    const longModel = parseDiagram("flowchart LR\n  A ----> B\n").model as FlowGraph;
    expect(longModel.edges[0]).toMatchObject({ syntaxKind: "---->", minLength: 3 });
    const shortLayout = layoutDiagramGraph(shortModel);
    const longLayout = layoutDiagramGraph(longModel);
    expect(longLayout.nodes.B!.x - longLayout.nodes.A!.x).toBeGreaterThan(
      shortLayout.nodes.B!.x - shortLayout.nodes.A!.x,
    );
  });

  it("经典全部括号形状与 Mermaid 11.3 扩展 shape 语法均保留为可渲染形状", () => {
    const source = String.raw`flowchart TD
  A[矩形]
  B(圆角)
  C([体育场])
  D[[子流程]]
  E[(数据库)]
  F((圆形))
  G(((双圆)))
  H>非对称]
  I{菱形}
  J{{六边形}}
  K[/平行/]
  L[\反向平行\]
  M[/梯形\]
  N[\反向梯形/]
  O@{ shape: cloud, label: "云" }
  P@{ shape: doc, label: "文档" }
`;
    const model = parseDiagram(source).model as FlowGraph;
    expect(Object.fromEntries(model.nodes.map((node) => [node.id, normalizeFlowShapeName(node.shape)]))).toMatchObject({
      A: "rect",
      B: "round",
      C: "stadium",
      D: "subroutine",
      E: "cylinder",
      F: "circle",
      G: "doublecircle",
      H: "asymmetric",
      I: "diamond",
      J: "hexagon",
      K: "parallelogram",
      L: "parallelogram-alt",
      M: "trapezoid",
      N: "trapezoid-alt",
      O: "cloud",
      P: "doc",
    });
    const svg = graphToSvg(source)!;
    expect(svg.match(/data-node-id=/g)).toHaveLength(16);
    expect(svg).toContain(">云</tspan>");
    expect(svg).toContain(">文档</tspan>");
  });

  it("Mermaid 官方 48 个 flowchart shape shortName 全部归一化并进入 SVG", () => {
    const officialShapes: Array<[string, string]> = [
      ["rect", "rect"],
      ["rounded", "round"],
      ["stadium", "stadium"],
      ["fr-rect", "subroutine"],
      ["cyl", "cylinder"],
      ["datastore", "datastore"],
      ["circle", "circle"],
      ["bang", "bang"],
      ["cloud", "cloud"],
      ["diam", "diamond"],
      ["hex", "hexagon"],
      ["lean-r", "parallelogram"],
      ["lean-l", "parallelogram-alt"],
      ["trap-b", "trapezoid"],
      ["trap-t", "trapezoid-alt"],
      ["dbl-circ", "doublecircle"],
      ["text", "text"],
      ["notch-rect", "notch-rect"],
      ["lin-rect", "lin-rect"],
      ["sm-circ", "sm-circ"],
      ["fr-circ", "fr-circ"],
      ["fork", "fork"],
      ["hourglass", "hourglass"],
      ["brace", "brace"],
      ["brace-r", "brace-r"],
      ["braces", "braces"],
      ["bolt", "bolt"],
      ["doc", "doc"],
      ["delay", "delay"],
      ["h-cyl", "h-cyl"],
      ["lin-cyl", "lin-cyl"],
      ["curv-trap", "curv-trap"],
      ["div-rect", "div-rect"],
      ["tri", "tri"],
      ["win-pane", "win-pane"],
      ["f-circ", "f-circ"],
      ["notch-pent", "notch-pent"],
      ["flip-tri", "flip-tri"],
      ["sl-rect", "sl-rect"],
      ["docs", "docs"],
      ["st-rect", "st-rect"],
      ["bow-rect", "bow-rect"],
      ["cross-circ", "cross-circ"],
      ["tag-doc", "tag-doc"],
      ["tag-rect", "tag-rect"],
      ["flag", "flag"],
      ["odd", "odd"],
      ["lin-doc", "lin-doc"],
    ];
    const source = [
      "flowchart TD",
      ...officialShapes.map(([shape], index) => `  N${index}@{ shape: ${shape}, label: "${shape}" }`),
    ].join("\n");
    const model = parseDiagram(source).model as FlowGraph;
    expect(model.nodes).toHaveLength(officialShapes.length);
    officialShapes.forEach(([shape, normalized], index) => {
      expect(model.nodes[index]?.shape, shape).toBe(normalized);
    });
    expect(normalizeFlowShapeName("document")).toBe("doc");
    expect(getFlowShapeGeometry("text").outlineVisible).toBe(false);
    const svg = graphToSvg(source)!;
    expect(svg.match(/data-node-id=/g)).toHaveLength(officialShapes.length);
    expect(svg).toContain('data-node-id="N16"');
    expect(svg).toMatch(/data-node-id="N16"[\s\S]*?stroke="none"/);
  });

  it("classDef/class/:::、style、default、注释、引号与 HTML entity 不丢失", () => {
    const source = `flowchart RL
  %% A --> Ghost
  classDef default fill:#FFFFFF,stroke:#111111,color:#222222
  classDef hot,warm fill:#FFEEDD,stroke:#AA5500
  A["含 ] 与 &#35;、&amp;、\\\\\\"引号\\\\\\""]:::hot --> B[普通]
  class B warm
  style B fill:#DDEEFF,stroke-dasharray:6 4,font-size:18px
`;
    const model = parseDiagram(source).model as FlowGraph;
    expect(model.direction).toBe("RL");
    expect(model.nodes.map((node) => node.id)).toEqual(["A", "B"]);
    expect(model.nodes.find((node) => node.id === "A")?.label).toBe('含 ] 与 #、&、"引号"');
    expect(model.perNodeStyles?.A).toMatchObject({ fill: "#FFEEDD", stroke: "#AA5500", textColor: "#222222" });
    expect(model.perNodeStyles?.B).toMatchObject({
      fill: "#DDEEFF",
      stroke: "#AA5500",
      textColor: "#222222",
      dashArray: "6 4",
      fontSize: 18,
    });
  });
});

describe("元素层级(z 轴)", () => {
  const order = ["A", "B", "C"];

  it("上移一层与下移一层只和相邻一层交换", () => {
    expect(applyZOrderCommand({ order, selected: ["A"], command: "raise" })).toMatchObject({ A: 1, B: 0 });
    expect(applyZOrderCommand({ order, selected: ["C"], command: "lower" })).toMatchObject({ B: 2, C: 1 });
  });

  it("移到顶层/底层排到序列两端", () => {
    const front = applyZOrderCommand({ order, selected: ["A"], command: "front" });
    expect(sortIdsByZOrder(order, front)).toEqual(["B", "C", "A"]);
    const back = applyZOrderCommand({ order, selected: ["C"], command: "back" });
    expect(sortIdsByZOrder(order, back)).toEqual(["C", "A", "B"]);
  });

  it("多选整体同向移动并保持彼此相对次序", () => {
    const next = applyZOrderCommand({ order: ["A", "B", "C", "D"], selected: ["A", "B"], command: "front" });
    expect(sortIdsByZOrder(["A", "B", "C", "D"], next)).toEqual(["C", "D", "A", "B"]);
    const raised = applyZOrderCommand({ order: ["A", "B", "C", "D"], selected: ["A", "B"], command: "raise" });
    expect(sortIdsByZOrder(["A", "B", "C", "D"], raised)).toEqual(["C", "A", "B", "D"]);
  });

  it("到顶/到底后再移动不越界,层级保持稳定", () => {
    const atTop = applyZOrderCommand({ order, selected: ["C"], command: "raise" });
    expect(sortIdsByZOrder(order, atTop)).toEqual(["A", "B", "C"]);
    const atBottom = applyZOrderCommand({ order, selected: ["A"], command: "lower" });
    expect(sortIdsByZOrder(order, atBottom)).toEqual(["A", "B", "C"]);
  });

  it("在既有层级之上继续重排(以 overlay 现值为准而非声明次序)", () => {
    const first = applyZOrderCommand({ order, selected: ["A"], command: "front" });
    const second = applyZOrderCommand({ order, selected: ["B"], command: "front", zOrders: first });
    expect(sortIdsByZOrder(order, second)).toEqual(["C", "A", "B"]);
  });

  it("导出 SVG 的节点绘制顺序跟随层级", () => {
    const source = "flowchart TD\n  A[甲]\n  B[乙]\n";
    const zOrders = applyZOrderCommand({ order: ["A", "B"], selected: ["A"], command: "front" });
    const svg = graphToSvg(source, { zOrders })!;
    expect(svg).toContain('data-node-id="A"');
    expect(svg.indexOf('data-node-id="B"')).toBeLessThan(svg.indexOf('data-node-id="A"'));
    // 默认次序下 A 先画
    const plain = graphToSvg(source)!;
    expect(plain.indexOf('data-node-id="A"')).toBeLessThan(plain.indexOf('data-node-id="B"'));
  });

  it("层级随 overlay 一起做稳定过滤与改名迁移", () => {
    const source = "flowchart TD\n  A[甲]\n  B[乙]\n";
    const filtered = filterStableOverlay(source, { zOrders: { A: 1, B: 0, Ghost: 9 } });
    expect(filtered?.zOrders).toEqual({ A: 1, B: 0 });
  });
});

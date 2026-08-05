import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const expectedPublicExports = [
  "BaseEdge",
  "BaseNode",
  "Capability",
  "ClassGraph",
  "DiagramAdapter",
  "DiagramGraphLayout",
  "DiagramModel",
  "DiagramOverlay",
  "DiagramThemeMetadata",
  "DiagramType",
  "EdgeDirection",
  "EdgeHandleOverride",
  "EdgeLineStyle",
  "EdgeMarkerKind",
  "EdgeStyleOverride",
  "EditOp",
  "ElementIdMap",
  "ErGraph",
  "FlowGraph",
  "FlowNodeShape",
  "FlowShapeGeometry",
  "FlowSubgraph",
  "GRAPH_LAYOUT_NODE_HEIGHT",
  "GRAPH_LAYOUT_NODE_MAX_HEIGHT",
  "GRAPH_LAYOUT_NODE_MAX_WIDTH",
  "GRAPH_LAYOUT_NODE_MIN_HEIGHT",
  "GRAPH_LAYOUT_NODE_MIN_WIDTH",
  "GRAPH_LAYOUT_NODE_WIDTH",
  "GraphLayoutCluster",
  "GraphLayoutRect",
  "MindNode",
  "MindmapTree",
  "NodeStyleOverride",
  "ParseResult",
  "RewriteResult",
  "Span",
  "SpanMap",
  "StateGraph",
  "ThemePalette",
  "ZOrderCommand",
  "applyEdit",
  "applyZOrderCommand",
  "canUseGraphVisualEditor",
  "carryOverDiagramOverlay",
  "detectType",
  "dissolveSubgraph",
  "filterStableOverlay",
  "getCapabilities",
  "getFlowShapeGeometry",
  "getGraphVisualEditorUnavailableReason",
  "getStableElementIds",
  "graphToSvg",
  "layoutDiagramGraph",
  "moveNodeToSubgraph",
  "normalizeFlowShapeName",
  "parseDiagram",
  "registry",
  "renameSubgraph",
  "safeMermaid",
  "safeMermaidId",
  "safeMermaidLabel",
  "setSubgraphStyle",
  "sortIdsByZOrder",
  "wrapNodesInSubgraph",
];

describe("diagram-engine 公共 API", () => {
  it("保持拆分前的导出名单不变", () => {
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const program = ts.createProgram([entry], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    });
    const sourceFile = program.getSourceFile(entry);
    expect(sourceFile).toBeDefined();

    const moduleSymbol = sourceFile && program.getTypeChecker().getSymbolAtLocation(sourceFile);
    expect(moduleSymbol).toBeDefined();

    const actual = moduleSymbol
      ? program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort()
      : [];
    expect(actual).toEqual(expectedPublicExports);
  });
});

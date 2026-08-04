import { classCapabilities, parseClass, rewriteClass } from "./class.js";

import { erCapabilities, parseEr, rewriteEr } from "./er.js";

import { flowchartCapabilities, parseFlowchart, rewriteFlowchart } from "./flowchart.js";

import { completeOpenFlowSubgraphs, verifyFlowSubgraphsPreserved } from "./flowchart-subgraphs.js";

import { mindmapCapabilities, parseMindmap, rewriteMindmap } from "./mindmap.js";

import { parseDiagram } from "./parser.js";

import { registry } from "./registry.js";

import { parseState, rewriteState, stateCapabilities } from "./state.js";

import { Capability, DiagramAdapter, DiagramType, EditOp, ParseResult, RewriteResult } from "./types.js";



Object.assign(registry, {
  flowchart: makeFlowchartAdapter(),
  state: makeStateAdapter(),
  er: makeErAdapter(),
  class: makeClassAdapter(),
  mindmap: makeMindmapAdapter(),
});

export { detectType, parseDiagram } from "./parser.js";
export { registry } from "./registry.js";

/** 图画布与“可视化编辑”入口共用的能力判定，避免按钮存在但消费者未挂载。 */
export function canUseGraphVisualEditor(parsed: ParseResult | null | undefined): boolean {
  return !!(
    parsed?.ok
    && parsed.fullyRepresented
    && (
      parsed.model.type === "flowchart"
      || parsed.model.type === "state"
      || parsed.model.type === "er"
      || parsed.model.type === "class"
      || parsed.model.type === "mindmap"
    )
  );
}

export function getCapabilities(
  sourceOrParse: string | ParseResult,
  target?: { nodeId?: string; edgeId?: string },
): Capability[] {
  const parsed = typeof sourceOrParse === "string" ? parseDiagram(sourceOrParse) : sourceOrParse;
  return registry[parsed.model.type].capabilities(parsed, target);
}

export function applyEdit(source: string, op: EditOp): RewriteResult {
  const parsed = parseDiagram(source);
  if (!parsed.ok) return { ok: false, source, error: parsed.error ?? "图表解析失败" };
  if (parsed.model.type !== "flowchart") {
    return registry[parsed.model.type].rewrite(source, parsed, op);
  }
  const rewriteSource = completeOpenFlowSubgraphs(source, parsed.model);
  const rewriteParsed = rewriteSource === source ? parsed : parseFlowchart(rewriteSource);
  if (!rewriteParsed.ok || rewriteParsed.model.type !== "flowchart") {
    return { ok: false, source, error: rewriteParsed.error ?? "分区补全后无法重新解析" };
  }
  const result = registry.flowchart.rewrite(rewriteSource, rewriteParsed, op);
  const verified = verifyFlowSubgraphsPreserved(rewriteSource, result);
  return verified.ok || rewriteSource === source ? verified : { ...verified, source };
}

export function makeFlowchartAdapter(): DiagramAdapter {
  return {
    type: "flowchart",
    detect: (source) => /^\s*(?:flowchart|graph)\s+/m.test(source),
    parse: parseFlowchart,
    capabilities: flowchartCapabilities,
    rewrite: rewriteFlowchart,
  };
}

export function makeStateAdapter(): DiagramAdapter {
  return {
    type: "state",
    detect: (source) => /^\s*stateDiagram(?:-v2)?\b/m.test(source),
    parse: parseState,
    capabilities: stateCapabilities,
    rewrite: rewriteState,
  };
}

export function makeErAdapter(): DiagramAdapter {
  return {
    type: "er",
    detect: (source) => /^\s*erDiagram\b/m.test(source),
    parse: parseEr,
    capabilities: erCapabilities,
    rewrite: rewriteEr,
  };
}

export function makeClassAdapter(): DiagramAdapter {
  return {
    type: "class",
    detect: (source) => /^\s*classDiagram\b/m.test(source),
    parse: parseClass,
    capabilities: classCapabilities,
    rewrite: rewriteClass,
  };
}

export function makeMindmapAdapter(): DiagramAdapter {
  return {
    type: "mindmap",
    detect: (source) => /^\s*mindmap\b/m.test(source),
    parse: parseMindmap,
    capabilities: mindmapCapabilities,
    rewrite: rewriteMindmap,
  };
}

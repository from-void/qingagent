import { registry } from "./registry.js";
import { emptyParse } from "./shared.js";
import type { DiagramType, ParseResult } from "./types.js";

export function detectType(source: string): DiagramType | null {
  for (const adapter of Object.values(registry)) {
    if (adapter.detect(source)) return adapter.type;
  }
  return null;
}

export function parseDiagram(source: string): ParseResult {
  const type = detectType(source);
  if (!type) return emptyParse("flowchart", "不支持的 Mermaid 图类型");
  return registry[type].parse(source);
}

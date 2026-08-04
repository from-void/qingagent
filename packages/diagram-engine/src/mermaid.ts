import { countGraphemes, truncateGraphemes } from "@qingagent/contract-ts";

import { MAX_MERMAID_ID_GRAPHEMES, isStableMermaidId } from "./shared.js";



export function safeMermaidId(label: string, prefix = "n"): string {
  const normalized = label
    .trim()
    .replace(/["'`]/g, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  let id = normalized || prefix;
  if (!/^[A-Za-z_]/.test(id)) id = `${prefix}_${id}`;
  if (/^end$/i.test(id)) id = `${id}_node`;
  if (/^[ox]/i.test(id)) id = `${prefix}_${id}`;
  const truncated = truncateGraphemes(id, MAX_MERMAID_ID_GRAPHEMES);
  return isStableMermaidId(truncated) ? truncated : "n";
}

export function safeMermaidLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "<br>").trim();
}

export function safeMermaid(value: string): { id: string; label: string } {
  return { id: safeMermaidId(value), label: safeMermaidLabel(value) };
}

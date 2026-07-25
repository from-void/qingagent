import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mermaid from "mermaid";
import { normalizeDrawioSource } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { renderDrawio } from "./drawioRender";

const templates = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/core/skills/capability/diagram-viz/references/templates.md",
  ),
  "utf8",
);

function extractTemplate(kind: "mermaid" | "drawio", fence: "mermaid" | "xml"): string {
  const start = `<!-- diagram-viz:template:${kind}:start -->`;
  const end = `<!-- diagram-viz:template:${kind}:end -->`;
  const section = templates.slice(
    templates.indexOf(start) + start.length,
    templates.indexOf(end),
  );
  const match = section.match(new RegExp("```" + fence + "\\n([\\s\\S]*?)\\n```"));
  if (!match?.[1]) throw new Error(`无法从 templates.md 提取 ${kind} 范本`);
  return match[1];
}

describe("diagram-viz 范本", () => {
  it("Mermaid 范本通过实际 Mermaid parser", async () => {
    const source = extractTemplate("mermaid", "mermaid");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

    await expect(mermaid.parse(source, { suppressErrors: true })).resolves.not.toBe(false);
  });

  it("draw.io 范本先通过 normalizeDrawioSource，再由 maxGraph 渲染成安全 SVG", async () => {
    const source = extractTemplate("drawio", "xml");
    const normalized = normalizeDrawioSource(source);
    const svg = await renderDrawio(normalized);

    expect(normalized).toContain('<mxCell id="client-zone"');
    expect(normalized).toContain('<mxCell id="edge-service-db"');
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain("接入层");
    expect(svg).toContain("订单服务");
    expect(svg).not.toMatch(/foreignObject|<script|\son\w+=/i);
  });
});

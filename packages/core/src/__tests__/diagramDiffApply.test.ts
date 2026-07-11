import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { buildDraftDiff, applyDiffHunks } from "../bridge/proposalDiff.js";
import { isRenderableSvg } from "../export/shared.js";

// 回归:diagram 此前不在 BLOCK_NODE_TYPES,导致 diff 接受 diagram 的 insert/replace
// 会被 applyDiffHunks 静默过滤成 no-op(改写图表表面成功实则没改)。补进白名单后必须真应用。
function para(blockId: string, text: string) {
  return { type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] };
}
function diagram(blockId: string, source: string) {
  return { type: "diagram", attrs: { blockId, lang: "mermaid", source, svg: null } };
}
function doc(content: unknown[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content } as unknown as PmDoc;
}
function diagramSources(d: PmDoc): string[] {
  return d.content.filter((b) => b.type === "diagram").map((b) => (b as { attrs: { source: string } }).attrs.source);
}

describe("diagram diff 应用(BLOCK_NODE_TYPES 回归)", () => {
  it("插入 diagram 的 hunk 会真正落到文档,而不是被过滤成 no-op", () => {
    const base = doc([para("p1", "第一段")]);
    const draft = doc([para("p1", "第一段"), diagram("d1", "flowchart TD\n A-->B")]);
    const hunks = buildDraftDiff(base, draft);
    const applied = applyDiffHunks(base, hunks).doc;
    expect(diagramSources(applied)).toEqual(["flowchart TD\n A-->B"]);
  });

  it("替换 diagram 源码的 hunk 会改到新源码", () => {
    const base = doc([diagram("d1", "flowchart TD\n A-->B")]);
    const draft = doc([diagram("d1", "sequenceDiagram\n A->>B: hi")]);
    const hunks = buildDraftDiff(base, draft);
    const applied = applyDiffHunks(base, hunks).doc;
    expect(diagramSources(applied)).toEqual(["sequenceDiagram\n A->>B: hi"]);
  });

  it("删除 diagram 的 hunk 会真正删掉它", () => {
    const base = doc([para("p1", "第一段"), diagram("d1", "flowchart TD\n A-->B")]);
    const draft = doc([para("p1", "第一段")]);
    const hunks = buildDraftDiff(base, draft);
    const applied = applyDiffHunks(base, hunks).doc;
    expect(diagramSources(applied)).toEqual([]);
  });

  it("只有 svg 缓存不同(源码相同)不产生假替换 hunk(round-1 ccreview 发现)", () => {
    const withSvg = { type: "diagram", attrs: { blockId: "d1", lang: "mermaid", source: "flowchart TD\n A-->B", svg: "<svg viewBox='0 0 1 1'></svg>" } };
    const noSvg = { type: "diagram", attrs: { blockId: "d1", lang: "mermaid", source: "flowchart TD\n A-->B", svg: null } };
    expect(buildDraftDiff(doc([withSvg]), doc([noSvg]))).toEqual([]);
    expect(buildDraftDiff(doc([noSvg]), doc([withSvg]))).toEqual([]);
  });

  it.each([
    ["replace", doc([diagram("d1", "flowchart TD\n A-->B")]), doc([diagram("d1", "flowchart TD\n B-->C")])],
    ["delete", doc([diagram("d1", "flowchart TD\n A-->B")]), doc([])],
  ] as const)("%s hunk 缺少 before 前置条件时 fail-closed", (_op, base, draft) => {
    const [hunk] = buildDraftDiff(base, draft);
    if (!hunk) throw new Error("fixture missing hunk");
    const { beforeBlock: _beforeBlock, ...withoutBeforeBlock } = hunk;
    const damaged = { ...withoutBeforeBlock, before: null };

    const result = applyDiffHunks(base, [damaged]);

    expect(result.doc).toEqual(base);
    expect(result.applied).toEqual([]);
    expect(result.skippedDetails[0]?.reason).toContain("missing expected block");
  });

  it("insert hunk 缺少 after 块时 fail-closed，不把 no-op 记成 applied", () => {
    const base = doc([para("p1", "第一段")]);
    const [hunk] = buildDraftDiff(base, doc([para("p1", "第一段"), diagram("d1", "flowchart TD\n A-->B")]));
    if (!hunk) throw new Error("fixture missing insert hunk");
    const damaged = { ...hunk, after: null };

    const result = applyDiffHunks(base, [damaged]);

    expect(result.doc).toEqual(base);
    expect(result.applied).toEqual([]);
    expect(result.skippedDetails[0]?.reason).toContain("missing inserted blocks");
  });
});

describe("isRenderableSvg 导出安全护栏", () => {
  it("空 / 非 svg / 超大 一律拒绝", () => {
    expect(isRenderableSvg(null)).toBe(false);
    expect(isRenderableSvg("")).toBe(false);
    expect(isRenderableSvg("alert(1)")).toBe(false);
    expect(isRenderableSvg("<div>not svg</div>")).toBe(false);
    expect(isRenderableSvg("<svg viewBox='0 0 1 1'>" + "x".repeat(2_000_001) + "</svg>")).toBe(false);
  });

  it("无尺寸信息(无 viewBox 且无 width/height)的 svg 被拒绝——否则 pdfmake 崩整篇导出", () => {
    // round-1 端到端实测发现:此形态 svg 让 pdfmake 抛 "SVG is missing defined height"。
    expect(isRenderableSvg("<svg></svg>")).toBe(false);
    expect(isRenderableSvg('<svg onload="x()"><script>y()</script></svg>')).toBe(false);
    expect(isRenderableSvg('<?xml version="1.0"?><svg></svg>')).toBe(false);
  });

  it("带 viewBox 或 width+height 的合法 svg 被接受", () => {
    expect(isRenderableSvg("<svg viewBox='0 0 1 1'></svg>")).toBe(true);
    expect(isRenderableSvg('<svg width="10" height="10"></svg>')).toBe(true);
    expect(isRenderableSvg("  <!-- c --><svg viewBox='0 0 2 2' ></svg>")).toBe(true);
  });
});

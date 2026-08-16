import { describe, expect, it } from "vitest";
import { markdownToPm, pmToMarkdown, pmToMarkdownWithLineMap } from "@qingagent/pm-schema";
import { applyExternalProposalOps, compileExternalQingmlDraft } from "../docWriteCommands";

describe("compileExternalQingmlDraft", () => {
  it("编译失败使用 compile_failed，且不伪造 QingML warning 与位置", () => {
    const result = compileExternalQingmlDraft("<p>正文</p>", () => ({
      ok: false,
      doc: null,
      blockErrors: [{ index: 0, message: "compile failed" }],
    }));

    expect(result).toEqual({
      ok: false,
      diagnostic: {
        failureKind: "compile_failed",
        warningKinds: [],
        tagSkeleton: "<p></p>",
        errorLocations: [],
      },
    });
  });

  it("局部插入只拼接受影响区间，未触碰块保留原节点引用与 blockId", () => {
    const canonical = markdownToPm("第一段。\n\n第二段。\n\n第三段。");
    const candidate = structuredClone(canonical);
    const untouched = [...candidate.content];
    expect(candidate).not.toBe(canonical);
    expect(candidate.content[0]).not.toBe(canonical.content[0]);

    const result = applyExternalProposalOps(candidate, [
      { kind: "insertAfterLine", line: 2, markdown: "插入段。" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).not.toBe(candidate);
    expect(result.doc.content).toHaveLength(4);
    expect(result.doc.content[0]).toBe(untouched[0]);
    expect(result.doc.content[2]).toBe(untouched[1]);
    expect(result.doc.content[3]).toBe(untouched[2]);
    expect(result.doc.content.filter((block) => untouched.includes(block)))
      .toHaveLength(untouched.length);
    expect(candidate.content).toEqual(untouched);
    expect(canonical).toEqual(markdownToPm("第一段。\n\n第二段。\n\n第三段。"));
  });

  it("P34：整篇行偏移跨 30+ 行表格后仍把插入落在第 36/37 项之间", () => {
    const table = [
      "| 序号 | 内容 |",
      "| --- | --- |",
      ...Array.from({ length: 32 }, (_, index) => `| ${index + 1} | 值 ${index + 1} |`),
    ].join("\n");
    const markdown = [
      table,
      ...Array.from({ length: 37 }, (_, index) => `第 ${index + 1} 项`),
    ].join("\n\n");
    const candidate = markdownToPm(markdown);
    const serialized = pmToMarkdownWithLineMap(candidate);
    const target = serialized.blocks.find((span) =>
      pmToMarkdown({ ...candidate, content: [candidate.content[span.blockIndex]!] }).includes("第 36 项")
    );
    expect(target).toBeTruthy();

    const result = applyExternalProposalOps(candidate, [{
      kind: "insertAfterLine",
      line: target!.contentEndLine,
      markdown: "插在 36/37 之间",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = pmToMarkdown(result.doc);
    expect(out.indexOf("第 36 项")).toBeLessThan(out.indexOf("插在 36/37 之间"));
    expect(out.indexOf("插在 36/37 之间")).toBeLessThan(out.indexOf("第 37 项"));
  });

  it("P34：多行大块内部行拒绝吸附，并提示内容锚点与同批行号过期", () => {
    const candidate = markdownToPm("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n尾段");
    const table = pmToMarkdownWithLineMap(candidate).blocks.find((span) => span.blockType === "table");
    expect(table).toBeTruthy();
    const result = applyExternalProposalOps(candidate, [{
      kind: "insertAfterLine",
      line: table!.startLine + 1,
      markdown: "不应插入",
    }]);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain("多行 table 块");
    expect(result.error).toContain("内容锚点");
    expect(result.error).toContain("同批前序操作会使后续行号过期");
  });

  it("P34：整篇序列化过滤的空块不再额外占两行", () => {
    const candidate = markdownToPm("第一段\n\n第二段");
    candidate.content.splice(1, 0, {
      type: "paragraph",
      attrs: { blockId: "empty-shell" },
      content: [],
    });
    const serialized = pmToMarkdownWithLineMap(candidate);
    expect(serialized.markdown).toBe("第一段\n\n第二段");
    expect(serialized.blocks.map((span) => span.blockIndex)).toEqual([0, 2]);

    const result = applyExternalProposalOps(candidate, [{
      kind: "insertAfterLine",
      line: 2,
      markdown: "插入段",
    }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content.map((block) => block.attrs.blockId)).toEqual([
      candidate.content[0]!.attrs.blockId,
      result.doc.content[1]!.attrs.blockId,
      "empty-shell",
      candidate.content[2]!.attrs.blockId,
    ]);
  });

  it("结构操作整批失败不泄漏前序删除", () => {
    const candidate = markdownToPm("第一段\n\n第二段");
    const before = structuredClone(candidate);
    const result = applyExternalProposalOps(candidate, [
      { kind: "deleteBlock", blockId: candidate.content[0]!.attrs.blockId },
      { kind: "deleteBlock", blockId: "missing-block" },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect(candidate).toEqual(before);
  });
});

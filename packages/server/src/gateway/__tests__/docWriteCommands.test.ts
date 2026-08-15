import { describe, expect, it } from "vitest";
import { markdownToPm } from "@qingagent/pm-schema";
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
});

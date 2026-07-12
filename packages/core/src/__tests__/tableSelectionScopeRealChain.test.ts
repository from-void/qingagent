import { describe, expect, it } from "vitest";
import { pmToAiIr, aiIrToPm, type PmDoc, type PmTableNode } from "@qingagent/pm-schema";
import { validateTableSelectionScope } from "../doc-engine/draftScratch.js";

// 真实链路回归(2026-07-12 浏览器验收实录):编辑器真实形状的表(随机段落 blockId、
// 显式 textAlign:null 等默认键)经 pmToAiIr→aiIrToPm 整表往返重建后,未选行仅存在
// id/默认键差异——validator 必须放行;真实内容变化仍必须拒绝。
function editorShapedTable(mutate?: (t: PmTableNode) => void): PmTableNode {
  const table = {
    type: "table",
    attrs: { blockId: "block-real123" },
    content: [0, 1, 2].map((r) => ({
      type: "tableRow" as const,
      content: [0, 1, 2].map((c) => ({
        type: "tableCell" as const,
        attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
        content: [{
          type: "paragraph" as const,
          attrs: { blockId: `p-rand-${r}-${c}`, textAlign: null },
          content: r === 0 && c === 0 ? [{ type: "text" as const, text: "甲" }] : [],
        }],
      })),
    })),
  } as unknown as PmTableNode;
  mutate?.(table);
  return table;
}

function rebuildViaAiRoundTrip(table: PmTableNode): PmTableNode {
  const doc: PmDoc = { type: "doc", attrs: { schemaVersion: 1 }, content: [table] } as unknown as PmDoc;
  const rebuilt = aiIrToPm(pmToAiIr(doc)) as unknown as PmDoc;
  return rebuilt.content[0] as unknown as PmTableNode;
}

describe("tableSelection scope validator × AI 整表往返(真实编辑器节点形状)", () => {
  it("未选行仅 id/默认键差异 → 放行", () => {
    const before = editorShapedTable();
    const after = rebuildViaAiRoundTrip(before);
    const result = validateTableSelectionScope({
      before, after, tableRef: "block-real123",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    });
    expect(result).toEqual({ ok: true });
  });

  it("未选行文本被改 → 仍拒绝", () => {
    const before = editorShapedTable();
    const after = rebuildViaAiRoundTrip(before);
    const cell = (after.content[0]!.content[0]! as { content: Array<{ content: unknown[] }> }).content[0]!;
    cell.content = [{ type: "text", text: "被偷改" }];
    const result = validateTableSelectionScope({
      before, after, tableRef: "block-real123",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    });
    expect(result.ok).toBe(false);
  });

  it("未选行 cell 底色被改 → 仍拒绝", () => {
    const before = editorShapedTable();
    const after = rebuildViaAiRoundTrip(before);
    const target = after.content[2]!.content[1]! as { attrs?: Record<string, unknown> };
    target.attrs = { ...target.attrs, backgroundColor: "rose" };
    const result = validateTableSelectionScope({
      before, after, tableRef: "block-real123",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    });
    expect(result.ok).toBe(false);
  });
});

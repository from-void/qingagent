import { describe, expect, it } from "vitest";
import { compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import {
  allocateMaterializedBlockIds,
  isGeneratedAiBlockId,
  materializeDraftBlockIds,
} from "../ai-ir/draftBlockIds";
import { getStablePmJson } from "../hash";
import { safeParsePmDoc } from "../validators";
import type { PmBlockNode, PmDoc, PmNode } from "../types";

function compileDoc(blocks: readonly unknown[]): PmDoc {
  const result = compileAiDocumentToPm({ blocks });
  expect(result.ok).toBe(true);
  return result.doc!;
}

function collectBlockIds(node: PmNode | PmDoc): string[] {
  const record = node as unknown as { attrs?: { blockId?: unknown }; content?: unknown[] };
  const ids = typeof record.attrs?.blockId === "string" ? [record.attrs.blockId] : [];
  for (const child of record.content ?? []) {
    if (child && typeof child === "object") ids.push(...collectBlockIds(child as PmNode));
  }
  return ids;
}

describe("draftBlockIds", () => {
  it("materialize 后顶层 ai-block-* 全部转为真实 block-* 且过 schema", () => {
    const doc = compileDoc([
      { type: "heading", level: 1, runs: [{ text: "标题" }] },
      { type: "paragraph", runs: [{ text: "正文" }] },
      { type: "bulletList", items: [[{ text: "列表" }]] },
      { type: "table", rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "单元格" }] }] }] }] },
    ]);
    expect(doc.content.every((node) => isGeneratedAiBlockId(node.attrs.blockId))).toBe(true);

    const materialized = materializeDraftBlockIds(doc);

    expect(materialized.content.every((node) => !isGeneratedAiBlockId(node.attrs.blockId))).toBe(true);
    expect(new Set(materialized.content.map((node) => node.attrs.blockId)).size).toBe(materialized.content.length);
    expect(safeParsePmDoc(materialized).success).toBe(true);
  });

  it("materialize 幂等且保留真实 block-* id", () => {
    const doc = compileDoc([
      { type: "paragraph", runs: [{ text: "同文" }] },
      { type: "paragraph", runs: [{ text: "同文" }] },
    ]);
    const firstReal: PmBlockNode = { type: "paragraph", attrs: { blockId: "block-real" }, content: [] };
    const mixed: PmDoc = { ...doc, content: [firstReal, doc.content[1]!] };

    const once = materializeDraftBlockIds(mixed);
    const twice = materializeDraftBlockIds(once);

    expect(once.content[0]!.attrs.blockId).toBe("block-real");
    expect(getStablePmJson(twice)).toBe(getStablePmJson(once));
  });

  it("后代 blockId 以前顶层 ai-block-* 为前缀时同步换前缀", () => {
    const doc = compileDoc([{ type: "bulletList", items: [[{ text: "一" }], [{ text: "二" }]] }]);
    const oldPrefix = doc.content[0]!.attrs.blockId;

    const materialized = materializeDraftBlockIds(doc);
    const allIds = collectBlockIds(materialized);

    expect(allIds.some((id) => id.startsWith(oldPrefix))).toBe(false);
    expect(allIds.every((id) => !isGeneratedAiBlockId(id))).toBe(true);
  });

  it("表格 cell 深嵌套列表的独立临时前缀也会递归转正且保持唯一", () => {
    const cell = {
      blocks: [{
        type: "bulletList",
        items: [{
          runs: [{ text: "父项" }],
          children: [{ type: "bulletList", items: [{ runs: [{ text: "子项" }] }] }],
        }],
      }],
    };
    const source = compileDoc([
      { type: "table", rows: [{ cells: [cell, cell] }] },
      { type: "table", rows: [{ cells: [cell, cell] }] },
    ]);

    const materialized = materializeDraftBlockIds(source, { namespace: "test.table.deep" });
    const allIds = collectBlockIds(materialized);

    expect(allIds.every((id) => !isGeneratedAiBlockId(id))).toBe(true);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(getStablePmJson(materializeDraftBlockIds(materialized))).toBe(getStablePmJson(materialized));
  });

  it("连续相同空段分配会基于 existingIds 和 occurrence 稳定去重", () => {
    const first = compileDoc([{ type: "paragraph", runs: [] }]).content[0]!;
    const base = allocateMaterializedBlockIds([first], { namespace: "test.alloc" });
    const duplicated = allocateMaterializedBlockIds([first, first], {
      namespace: "test.alloc",
      existingIds: new Set([base.ids[0]!]),
      occurrence: 0,
    });
    const repeated = allocateMaterializedBlockIds([first, first], {
      namespace: "test.alloc",
      existingIds: new Set([base.ids[0]!]),
      occurrence: 0,
    });

    expect(duplicated.ids[0]).not.toBe(base.ids[0]);
    expect(duplicated.ids[0]).toContain("~0");
    expect(duplicated.ids[1]).not.toBe(duplicated.ids[0]);
    expect(duplicated.ids).toEqual(repeated.ids);
  });

  it("nextOccurrence 可喂回下一次分配并继续去重", () => {
    const block = compileDoc([{ type: "paragraph", runs: [{ text: "重复" }] }]).content[0]!;
    const first = allocateMaterializedBlockIds([block], { namespace: "test.next" });
    const second = allocateMaterializedBlockIds([block], {
      namespace: "test.next",
      existingIds: new Set(first.ids),
      occurrence: first.nextOccurrence,
    });

    expect(second.ids[0]).not.toBe(first.ids[0]);
    expect(second.nextOccurrence).toBeGreaterThanOrEqual(first.nextOccurrence);
  });

  it("整 doc materialize 后拒绝仍重复的真实顶层 blockId", () => {
    const node: PmBlockNode = { type: "paragraph", attrs: { blockId: "block-dup" }, content: [] };
    const doc: PmDoc = { type: "doc", attrs: { schemaVersion: 1 }, content: [node, { ...node }] };

    expect(() => materializeDraftBlockIds(doc)).toThrow(/重复 blockId/);
  });

  it("isGeneratedAiBlockId 只识别 ai-block-* 前缀", () => {
    expect(isGeneratedAiBlockId("ai-block-x")).toBe(true);
    expect(isGeneratedAiBlockId("block-x")).toBe(false);
    expect(isGeneratedAiBlockId(undefined)).toBe(false);
    expect(isGeneratedAiBlockId(123)).toBe(false);
  });
});

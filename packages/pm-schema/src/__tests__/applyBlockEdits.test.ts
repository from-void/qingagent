import { describe, expect, it } from "vitest";
import { applyBlockEdits } from "../ai-ir/applyBlockEdits";
import { aiIrToPm } from "../ai-ir/aiIrToPm";
import { isGeneratedAiBlockId } from "../ai-ir/draftBlockIds";
import { getStablePmJson } from "../hash";
import { pmToPlainText } from "../pmToPlainText";
import { safeParsePmDoc } from "../validators";
import type { PmBlockNode, PmDoc, PmNode } from "../types";

function makeOriginal() {
  const doc = aiIrToPm({
    blocks: [
      { type: "heading", level: 1, runs: [{ text: "标题" }] },
      { type: "paragraph", runs: [{ text: "第一段" }] },
      { type: "paragraph", runs: [{ text: "第二段", marks: [{ type: "bold" }] }] },
    ],
  });
  const [h, p1, p2] = doc.content;
  return { doc, refH: h!.attrs.blockId, ref1: p1!.attrs.blockId, ref2: p2!.attrs.blockId };
}

const text = (node: PmBlockNode) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [node] });

function paragraph(blockId: string, value: string): Extract<PmBlockNode, { type: "paragraph" }> {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: value ? [{ type: "text", text: value }] : [],
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function bulletList(
  blockId: string,
  items: Array<{ blockId: string; paragraphId: string; text: string; children?: PmBlockNode[] }>,
): Extract<PmBlockNode, { type: "bulletList" }> {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: items.map((item) => ({
      type: "listItem",
      attrs: { blockId: item.blockId },
      content: [paragraph(item.paragraphId, item.text), ...(item.children ?? [])],
    })),
  };
}

function taskList(
  blockId: string,
  items: Array<{ blockId: string; paragraphId: string; checked: boolean; text: string }>,
): Extract<PmBlockNode, { type: "taskList" }> {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item) => ({
      type: "taskItem",
      attrs: { blockId: item.blockId, checked: item.checked },
      content: [paragraph(item.paragraphId, item.text)],
    })),
  };
}

function firstText(node: PmNode): string {
  const content = (node as { content?: unknown[] }).content ?? [];
  return content
    .map((child) => {
      if (!child || typeof child !== "object") return "";
      const record = child as { type?: string; text?: string; content?: unknown[] };
      if (record.type === "text") return record.text ?? "";
      return firstText(record as PmNode);
    })
    .join("");
}

function collectBlockIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectBlockIds);
  if (!value || typeof value !== "object") return [];
  const record = value as { attrs?: { blockId?: unknown }; content?: unknown[] };
  const own = typeof record.attrs?.blockId === "string" ? [record.attrs.blockId] : [];
  return [...own, ...collectBlockIds(record.content)];
}

describe("applyBlockEdits", () => {
  it("replaceBlock 保留原 blockId,未改块逐字不变(含 marks)", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "replaceBlock", ref: ref1, block: { type: "paragraph", runs: [{ text: "改后的第一段" }] } },
    ]);

    expect(r.ok).toBe(true);
    expect(r.applied).toEqual([ref1]);
    const out = r.doc!;
    expect(out.content.length).toBe(3);
    // 改过的块:ref(blockId)不变、内容是新的
    expect(out.content[1]!.attrs.blockId).toBe(ref1);
    expect(text(out.content[1]!)).toBe("改后的第一段");
    // 未触碰块:逐字不变(blockId、bold marks 全留)—— 不变量 #3
    expect(out.content[0]).toEqual(doc.content[0]);
    expect(out.content[2]).toEqual(doc.content[2]);
  });

  it("insertBlock after 给新 ref,其余块不变", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "insertBlock", position: "after", ref: ref1, blocks: [{ type: "paragraph", runs: [{ text: "插入段" }] }] },
    ]);

    expect(r.ok).toBe(true);
    const out = r.doc!;
    expect(out.content.length).toBe(4);
    expect(text(out.content[2]!)).toBe("插入段");
    expect(out.content[2]!.attrs.blockId).toBe(r.applied[0]);
    expect(out.content[2]!.attrs.blockId).not.toBe(ref1);
    expect(out.content[0]).toEqual(doc.content[0]);
    expect(out.content[1]).toEqual(doc.content[1]);
    expect(out.content[3]).toEqual(doc.content[2]);
  });

  it("insertBlock 返回真实 ref,并可立即用该 ref replaceBlock 且 ref 不变", () => {
    const { doc, ref1 } = makeOriginal();
    const inserted = applyBlockEdits(doc, [
      { action: "insertBlock", position: "after", ref: ref1, blocks: [{ type: "paragraph", runs: [{ text: "插入段" }] }] },
    ]);
    expect(inserted.ok).toBe(true);
    const insertedRef = inserted.applied[0]!;
    expect(isGeneratedAiBlockId(insertedRef)).toBe(false);

    const replaced = applyBlockEdits(inserted.doc!, [
      { action: "replaceBlock", ref: insertedRef, block: { type: "heading", level: 2, runs: [{ text: "替换标题" }] } },
    ]);

    expect(replaced.ok).toBe(true);
    expect(replaced.applied).toEqual([insertedRef]);
    expect(replaced.doc!.content[2]!.attrs.blockId).toBe(insertedRef);
    expect(replaced.doc!.content[2]!.type).toBe("heading");
  });

  it("同次连续插入两个相同空段不会撞 blockId", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "insertBlock", position: "after", ref: ref1, blocks: [{ type: "paragraph", runs: [] }] },
      { action: "insertBlock", position: "after", ref: ref1, blocks: [{ type: "paragraph", runs: [] }] },
    ]);

    expect(r.ok).toBe(true);
    expect(r.applied).toHaveLength(2);
    expect(new Set(r.applied).size).toBe(2);
    expect(r.applied.every((id) => !isGeneratedAiBlockId(id))).toBe(true);
    expect(safeParsePmDoc(r.doc).success).toBe(true);
  });

  it("连续两次插入相同空段和相同文本段都成功且 ref 不同", () => {
    const { doc, ref1 } = makeOriginal();
    let current = doc;
    const refs: string[] = [];
    for (const block of [
      { type: "paragraph" as const, runs: [] },
      { type: "paragraph" as const, runs: [] },
      { type: "paragraph" as const, runs: [{ text: "重复文本" }] },
      { type: "paragraph" as const, runs: [{ text: "重复文本" }] },
    ]) {
      const r = applyBlockEdits(current, [{ action: "insertBlock", position: "after", ref: ref1, blocks: [block] }]);
      expect(r.ok).toBe(true);
      refs.push(r.applied[0]!);
      current = r.doc!;
    }

    expect(new Set(refs).size).toBe(4);
    expect(refs.every((id) => !isGeneratedAiBlockId(id))).toBe(true);
    expect(safeParsePmDoc(current).success).toBe(true);
  });

  it("deleteBlock 移除目标,其余不变", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [{ action: "deleteBlock", ref: ref1 }]);

    expect(r.ok).toBe(true);
    const out = r.doc!;
    expect(out.content.length).toBe(2);
    expect(out.content[0]).toEqual(doc.content[0]);
    expect(out.content[1]).toEqual(doc.content[2]);
  });

  it("insertBlock start / end", () => {
    const { doc } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "insertBlock", position: "start", blocks: [{ type: "paragraph", runs: [{ text: "头" }] }] },
      { action: "insertBlock", position: "end", blocks: [{ type: "paragraph", runs: [{ text: "尾" }] }] },
    ]);

    expect(r.ok).toBe(true);
    const out = r.doc!;
    expect(out.content.length).toBe(5);
    expect(text(out.content[0]!)).toBe("头");
    expect(text(out.content[4]!)).toBe("尾");
  });

  it("非法 AI-IR 块(外链图片)→ 整组失败、doc=null、原 doc 不动", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "replaceBlock", ref: ref1, block: { type: "image", src: "https://evil.com/x.png", alt: "x" } },
    ]);

    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    expect(r.failedOpIndex).toBe(0);
    expect(text(doc.content[1]!)).toBe("第一段"); // 原 doc 纯函数,从未被改
  });

  it("readDraft 壳误传到底层时返回 QingML 结构载荷提示", () => {
    const { doc, ref1 } = makeOriginal();
    const r = applyBlockEdits(doc, [
      {
        action: "replaceBlock",
        ref: ref1,
        block: {
          ref: ref1,
          type: "paragraph",
          aiIr: { type: "paragraph", runs: [{ text: "应该传这个子对象" }] },
          text: "只读文本",
          editability: { replaceBlockAllowed: true, lossyReasons: [] },
        },
      },
    ]);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("editDraft 结构载荷请传 QingML 片段");
    expect(r.error).not.toContain("heading/paragraph 顶层必须有 runs");
  });

  it("ref 不存在 → 失败", () => {
    const { doc } = makeOriginal();
    const r = applyBlockEdits(doc, [
      { action: "replaceBlock", ref: "不存在", block: { type: "paragraph", runs: [{ text: "x" }] } },
    ]);

    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    expect(r.failedOpIndex).toBe(0);
  });

  it("多 op 原子:第 2 个 op 坏 → 整组回滚(doc=null),不部分应用", () => {
    const { doc, ref1 } = makeOriginal();
    const before = getStablePmJson(doc);
    const r = applyBlockEdits(doc, [
      { action: "replaceBlock", ref: ref1, block: { type: "paragraph", runs: [{ text: "本该改但要被回滚" }] } },
      { action: "deleteBlock", ref: "不存在" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    expect(r.failedOpIndex).toBe(1);
    expect(text(doc.content[1]!)).toBe("第一段"); // 第 1 个 op 也没生效
    expect(getStablePmJson(doc)).toBe(before);
  });

  it("replaceListItem 保留目标 item blockId,嵌套子 list 结构保真且新 id 全树唯一", () => {
    const base = doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "保留行" },
        { blockId: "item-b", paragraphId: "item-b-p", text: "旧行" },
      ]),
    ]);

    const r = applyBlockEdits(base, [{
      action: "replaceListItem",
      ref: "item-b",
      item: {
        runs: [{ text: "新行" }],
        children: [{
          type: "bulletList",
          items: [
            { runs: [{ text: "子项一" }] },
            { runs: [{ text: "子项二" }] },
          ],
        }],
      },
    }]);

    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["item-b"]);
    const list = r.doc!.content[0]!;
    expect(list.type).toBe("bulletList");
    if (list.type !== "bulletList") return;
    expect(list.content[1]!.attrs.blockId).toBe("item-b");
    expect(firstText(list.content[1]!)).toContain("新行");
    expect(list.content[1]!.content[1]).toMatchObject({ type: "bulletList" });
    expect(firstText(list.content[1]!.content[1] as PmNode)).toContain("子项一");
    const ids = collectBlockIds(r.doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !id.startsWith("ai-block-"))).toBe(true);
    expect(safeParsePmDoc(r.doc).success).toBe(true);
  });

  it("replaceListItem 替换 taskItem 时未给 checked 会保留原勾选状态", () => {
    const base = doc([
      taskList("tasks-a", [
        { blockId: "task-a", paragraphId: "task-a-p", checked: true, text: "旧任务" },
      ]),
    ]);

    const r = applyBlockEdits(base, [{
      action: "replaceListItem",
      ref: "task-a",
      item: { runs: [{ text: "新任务" }] },
    }]);

    expect(r.ok).toBe(true);
    const list = r.doc!.content[0]!;
    expect(list.type).toBe("taskList");
    if (list.type !== "taskList") return;
    expect(list.content[0]!.attrs.blockId).toBe("task-a");
    expect(list.content[0]!.attrs.checked).toBe(true);
    expect(firstText(list.content[0]!)).toBe("新任务");
  });

  it("insertListItem 支持 start/end/before/after,插入行生成全树唯一真实 id", () => {
    const base = doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "A" },
        { blockId: "item-b", paragraphId: "item-b-p", text: "B" },
      ]),
    ]);

    const r = applyBlockEdits(base, [
      { action: "insertListItem", parentRef: "list-a", at: "start", item: { runs: [{ text: "Start" }] } },
      { action: "insertListItem", parentRef: "list-a", at: "after", ref: "item-a", item: { runs: [{ text: "AfterA" }] } },
      { action: "insertListItem", parentRef: "list-a", at: "before", ref: "item-b", item: { runs: [{ text: "BeforeB" }] } },
      { action: "insertListItem", parentRef: "list-a", at: "end", item: { runs: [{ text: "End" }] } },
    ]);

    expect(r.ok).toBe(true);
    const list = r.doc!.content[0]!;
    expect(list.type).toBe("bulletList");
    if (list.type !== "bulletList") return;
    expect(list.content.map((item) => firstText(item))).toEqual(["Start", "A", "AfterA", "BeforeB", "B", "End"]);
    const ids = collectBlockIds(r.doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.applied).toHaveLength(4);
    expect(r.applied.every((id) => !id.startsWith("ai-block-"))).toBe(true);
  });

  it("deleteListItem 删除行;删除父列表唯一行时拒绝且原 doc 不变", () => {
    const base = doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "A" },
        { blockId: "item-b", paragraphId: "item-b-p", text: "B" },
      ]),
    ]);
    const deleted = applyBlockEdits(base, [{ action: "deleteListItem", ref: "item-a" }]);
    expect(deleted.ok).toBe(true);
    const list = deleted.doc!.content[0]!;
    expect(list.type).toBe("bulletList");
    if (list.type !== "bulletList") return;
    expect(list.content.map((item) => item.attrs.blockId)).toEqual(["item-b"]);

    const single = doc([bulletList("list-one", [{ blockId: "only", paragraphId: "only-p", text: "唯一" }])]);
    const before = getStablePmJson(single);
    const rejected = applyBlockEdits(single, [{ action: "deleteListItem", ref: "only" }]);
    expect(rejected.ok).toBe(false);
    expect(rejected.doc).toBeNull();
    expect(rejected.error).toContain("拒绝删除后留下空列表");
    expect(getStablePmJson(single)).toBe(before);
  });

  it("行级 op 对非法 shape 和过期 ref fail-closed", () => {
    const base = doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "A" },
      ]),
      taskList("tasks-a", [
        { blockId: "task-a", paragraphId: "task-a-p", checked: false, text: "T" },
      ]),
    ]);
    const before = getStablePmJson(base);

    const checkedOnListItem = applyBlockEdits(base, [{
      action: "replaceListItem",
      ref: "item-a",
      item: { checked: true, runs: [{ text: "坏" }] },
    }]);
    expect(checkedOnListItem.ok).toBe(false);
    expect(checkedOnListItem.error).toContain("不支持 checked");

    const taskWithoutRuns = applyBlockEdits(base, [{
      action: "replaceListItem",
      ref: "task-a",
      item: { children: [{ type: "bulletList", items: [{ runs: [{ text: "子任务" }] }] }] },
    }]);
    expect(taskWithoutRuns.ok).toBe(false);
    expect(taskWithoutRuns.error).toContain("taskItem 必须提供 runs");

    const badChild = applyBlockEdits(base, [{
      action: "replaceListItem",
      ref: "item-a",
      item: { runs: [{ text: "父" }], children: [{ type: "notARealBlock" }] },
    }]);
    expect(badChild.ok).toBe(false);
    expect(badChild.error).toContain("listItem block 0");
    expect(badChild.error).toContain("children");

    const staleRef = applyBlockEdits(base, [{ action: "deleteListItem", ref: "missing-item" }]);
    expect(staleRef.ok).toBe(false);
    expect(staleRef.error).toContain("不存在");
    expect(getStablePmJson(base)).toBe(before);
  });
});

describe("applyBlockEdits 改表保留表头(table-header-lost-on-followup 回归)", () => {
  function headerTableDoc() {
    const d = aiIrToPm({
      blocks: [
        {
          type: "table",
          rows: [
            { cells: [{ runs: [{ text: "列A" }], header: true }, { runs: [{ text: "列B" }], header: true }] },
            { cells: [{ runs: [{ text: "a1" }] }, { runs: [{ text: "b1" }] }] },
          ],
        },
      ],
    });
    return { doc: d, ref: d.content[0]!.attrs.blockId };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellTypes = (table: any, row: number): string[] =>
    table.content[row].content.map((c: { type: string }) => c.type);

  it("改表后模型丢表头标记时,用旧表结构确定性还原首行 tableHeader", () => {
    const { doc, ref } = headerTableDoc();
    // 模型重生成的新表(加了一列)却全是 tableCell —— 复现表头丢失。
    const r = applyBlockEdits(doc, [
      {
        action: "replaceBlock",
        ref,
        block: {
          type: "table",
          rows: [
            { cells: [{ runs: [{ text: "列A" }] }, { runs: [{ text: "列B" }] }, { runs: [{ text: "列C" }] }] },
            { cells: [{ runs: [{ text: "a1" }] }, { runs: [{ text: "b1" }] }, { runs: [{ text: "c1" }] }] },
          ],
        },
      },
    ]);
    expect(r.ok).toBe(true);
    const table = r.doc!.content[0] as unknown as { type: string; content: unknown[] };
    expect(table.type).toBe("table");
    expect(cellTypes(table, 0)).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(cellTypes(table, 1)).toEqual(["tableCell", "tableCell", "tableCell"]);
  });

  it("新表已显式标了表头时尊重模型,不重写", () => {
    const { doc, ref } = headerTableDoc();
    const r = applyBlockEdits(doc, [
      {
        action: "replaceBlock",
        ref,
        block: {
          type: "table",
          rows: [
            { cells: [{ runs: [{ text: "X" }], header: true }] },
            { cells: [{ runs: [{ text: "y" }] }] },
          ],
        },
      },
    ]);
    const table = r.doc!.content[0] as unknown as { type: string; content: unknown[] };
    expect(cellTypes(table, 0)).toEqual(["tableHeader"]);
    expect(cellTypes(table, 1)).toEqual(["tableCell"]);
  });

  it("用户有意删表头(新表首行换成不同内容)时,尊重模型不强还原", () => {
    const { doc, ref } = headerTableDoc();
    // 新表首行不再保留旧表头标签(列A/列B),而是数据行内容 —— 视为有意去表头/重构。
    const r = applyBlockEdits(doc, [
      {
        action: "replaceBlock",
        ref,
        block: {
          type: "table",
          rows: [
            { cells: [{ runs: [{ text: "a1" }] }, { runs: [{ text: "b1" }] }] },
            { cells: [{ runs: [{ text: "a2" }] }, { runs: [{ text: "b2" }] }] },
          ],
        },
      },
    ]);
    const table = r.doc!.content[0] as unknown as { type: string; content: unknown[] };
    expect(cellTypes(table, 0)).toEqual(["tableCell", "tableCell"]); // 未被强加表头
  });

  it("旧表本就无表头时,不给新表强加表头", () => {
    const d = aiIrToPm({
      blocks: [
        {
          type: "table",
          rows: [{ cells: [{ runs: [{ text: "a" }] }] }, { cells: [{ runs: [{ text: "b" }] }] }],
        },
      ],
    });
    const ref = d.content[0]!.attrs.blockId;
    const r = applyBlockEdits(d, [
      {
        action: "replaceBlock",
        ref,
        block: {
          type: "table",
          rows: [{ cells: [{ runs: [{ text: "a2" }] }] }, { cells: [{ runs: [{ text: "b2" }] }] }],
        },
      },
    ]);
    const table = r.doc!.content[0] as unknown as { type: string; content: unknown[] };
    expect(cellTypes(table, 0)).toEqual(["tableCell"]);
  });
});

describe("applyBlockEdits 表格行列增量 op", () => {
  function richTableDoc() {
    const d = aiIrToPm({
      blocks: [
        {
          type: "table",
          rows: [
            {
              cells: [
                { runs: [{ text: "字段，含全角。" }], header: true },
                { runs: [{ text: "链接\"列\"", marks: [{ type: "link", href: "https://example.com" }] }], header: true },
              ],
            },
            {
              cells: [
                { runs: [{ text: "数值，保持。" }] },
                { runs: [{ text: "他说\"好\"，然后继续。" }] },
              ],
            },
          ],
        },
      ],
    });
    return { doc: d, ref: d.content[0]!.attrs.blockId };
  }

  function tableOf(d: PmDoc): Extract<PmBlockNode, { type: "table" }> {
    const table = d.content[0];
    expect(table?.type).toBe("table");
    return table as Extract<PmBlockNode, { type: "table" }>;
  }

  const rowTexts = (table: Extract<PmBlockNode, { type: "table" }>): string[][] =>
    table.content.map((row) => row.content.map(firstText));

  it("insertTableRow/insertTableColumn 只新增行列,既有单元格字节级不变", () => {
    const { doc, ref } = richTableDoc();
    const beforeTable = tableOf(doc);
    const beforeCells = beforeTable.content.map((row) => row.content.map(getStablePmJson));

    const r = applyBlockEdits(doc, [
      {
        action: "insertTableRow",
        ref,
        at: "end",
        cells: [{ runs: [{ text: "新增，A。" }] }, { runs: [{ text: "新增\"B\"" }] }],
      },
      {
        action: "insertTableColumn",
        ref,
        at: "end",
        cells: [{ runs: [{ text: "新增列，表头。" }] }, { runs: [{ text: "c1，保持。" }] }],
      },
    ]);

    expect(r.ok).toBe(true);
    const table = tableOf(r.doc!);
    expect(table.content).toHaveLength(3);
    expect(table.content.map((row) => row.content.length)).toEqual([3, 3, 3]);
    expect(table.content[0]!.content[2]!.type).toBe("tableHeader");
    expect(table.content[1]!.content[2]!.type).toBe("tableCell");
    expect(getStablePmJson(table.content[0]!.content[0])).toBe(beforeCells[0]![0]);
    expect(getStablePmJson(table.content[0]!.content[1])).toBe(beforeCells[0]![1]);
    expect(getStablePmJson(table.content[1]!.content[0])).toBe(beforeCells[1]![0]);
    expect(getStablePmJson(table.content[1]!.content[1])).toBe(beforeCells[1]![1]);
    expect(rowTexts(table)).toEqual([
      ["字段，含全角。", "链接\"列\"", "新增列，表头。"],
      ["数值，保持。", "他说\"好\"，然后继续。", "c1，保持。"],
      ["新增，A。", "新增\"B\"", ""],
    ]);
  });

  it("同一次调用内表格 op 按声明顺序应用,后续索引基于当前表", () => {
    const d = aiIrToPm({
      blocks: [{
        type: "table",
        rows: [
          { cells: [{ runs: [{ text: "H" }], header: true }] },
          { cells: [{ runs: [{ text: "A" }] }] },
          { cells: [{ runs: [{ text: "B" }] }] },
        ],
      }],
    });
    const ref = d.content[0]!.attrs.blockId;

    const r = applyBlockEdits(d, [
      { action: "deleteTableRow", ref, rowIndex: 1 },
      { action: "insertTableRow", ref, at: "after", rowIndex: 1, cells: [{ runs: [{ text: "C" }] }] },
    ]);

    expect(r.ok).toBe(true);
    expect(rowTexts(tableOf(r.doc!))).toEqual([["H"], ["B"], ["C"]]);
  });

  it("删除唯一数据行合法,保留只含表头的表", () => {
    const { doc, ref } = richTableDoc();

    const r = applyBlockEdits(doc, [{ action: "deleteTableRow", ref, rowIndex: 1 }]);

    expect(r.ok).toBe(true);
    const table = tableOf(r.doc!);
    expect(table.content).toHaveLength(1);
    expect(table.content[0]!.content.every((cell) => cell.type === "tableHeader")).toBe(true);
  });

  it("删表头行、删除最后一列和索引越界 fail-closed 且原 doc 不变", () => {
    const { doc, ref } = richTableDoc();
    const before = getStablePmJson(doc);

    const header = applyBlockEdits(doc, [{ action: "deleteTableRow", ref, rowIndex: 0 }]);
    expect(header.ok).toBe(false);
    expect(header.error).toContain("拒绝删除表头行");
    expect(getStablePmJson(doc)).toBe(before);

    const outOfRange = applyBlockEdits(doc, [{ action: "insertTableColumn", ref, at: "before", columnIndex: 9 }]);
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.error).toContain("columnIndex:9 越界");
    expect(getStablePmJson(doc)).toBe(before);

    const beforeHeader = applyBlockEdits(doc, [{ action: "insertTableRow", ref, at: "before", rowIndex: 0 }]);
    expect(beforeHeader.ok).toBe(false);
    expect(beforeHeader.error).toContain("拒绝在表头行之前插入数据行");
    expect(getStablePmJson(doc)).toBe(before);

    const negativeDeleteColumn = applyBlockEdits(doc, [{ action: "deleteTableColumn", ref, columnIndex: -1 }]);
    expect(negativeDeleteColumn.ok).toBe(false);
    expect(negativeDeleteColumn.error).toContain("columnIndex:-1 必须是非负整数");
    expect(getStablePmJson(doc)).toBe(before);

    const negativeInsertRow = applyBlockEdits(doc, [{ action: "insertTableRow", ref, at: "before", rowIndex: -1 }]);
    expect(negativeInsertRow.ok).toBe(false);
    expect(negativeInsertRow.error).toContain("rowIndex:-1 必须是非负整数");
    expect(getStablePmJson(doc)).toBe(before);

    const decimalInsertColumn = applyBlockEdits(doc, [{ action: "insertTableColumn", ref, at: "after", columnIndex: 1.5 }]);
    expect(decimalInsertColumn.ok).toBe(false);
    expect(decimalInsertColumn.error).toContain("columnIndex:1.5 必须是非负整数");
    expect(getStablePmJson(doc)).toBe(before);

    const mergedDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "merged-table" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: { colspan: 2 },
            content: [paragraph("merged-table-p", "合并单元格")],
          }],
        }],
      }],
    };
    const mergedBefore = getStablePmJson(mergedDoc);
    const merged = applyBlockEdits(mergedDoc, [{ action: "insertTableColumn", ref: "merged-table", at: "end" }]);
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain("含合并单元格");
    expect(getStablePmJson(mergedDoc)).toBe(mergedBefore);

    const oneColumn = aiIrToPm({
      blocks: [{ type: "table", rows: [{ cells: [{ runs: [{ text: "H" }], header: true }] }] }],
    });
    const oneColumnRef = oneColumn.content[0]!.attrs.blockId;
    const lastColumn = applyBlockEdits(oneColumn, [{ action: "deleteTableColumn", ref: oneColumnRef, columnIndex: 0 }]);
    expect(lastColumn.ok).toBe(false);
    expect(lastColumn.error).toContain("至少需要保留一列");
  });
});

// BB② 幂等护栏:跨调用累积候选时,同一条"单块 insert after/before"被重复作用会在插入位旁
// 留下完全相同的相邻块(线上偶发重复 heading)。护栏只丢弃「与紧邻已存在块内容完全相同、且
// 本身有实义内容」的块;分隔线/空段/不同内容/块内重复项一律放过。
describe("applyBlockEdits insertBlock 相邻同内容幂等去重(BB②)", () => {
  function countHeadingText(d: PmDoc, value: string): number {
    return d.content.filter((node) => node.type === "heading" && firstText(node) === value).length;
  }

  it("① 与紧邻已存在 heading 内容完全相同的插入被去重(after)", () => {
    const base = aiIrToPm({
      blocks: [
        { type: "heading", level: 1, runs: [{ text: "章" }] },
        { type: "heading", level: 2, runs: [{ text: "小标题" }] },
        { type: "paragraph", runs: [{ text: "正文" }] },
      ],
    });
    const refTop = base.content[0]!.attrs.blockId;
    // 在 refTop 之后插入与其紧邻(idx+1)的 "小标题" 完全相同的 heading → 应被丢弃
    const r = applyBlockEdits(base, [
      { action: "insertBlock", position: "after", ref: refTop, blocks: [{ type: "heading", level: 2, runs: [{ text: "小标题" }] }] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.doc!.content.length).toBe(3); // 没有新增
    expect(countHeadingText(r.doc!, "小标题")).toBe(1); // 仍只有一个
    expect(r.applied).toEqual([]); // 被去重 → 无新增 ref
    expect(r.skippedDuplicateInserts).toBe(1);
  });

  it("① before 方向同样去重(与左邻完全相同)", () => {
    const base = aiIrToPm({
      blocks: [
        { type: "heading", level: 2, runs: [{ text: "小标题" }] },
        { type: "paragraph", runs: [{ text: "正文" }] },
      ],
    });
    const refP = base.content[1]!.attrs.blockId;
    // 在 "正文"(refP)之前插入与其左邻(idx-1)的 "小标题" 相同的 heading → 应被丢弃
    const r = applyBlockEdits(base, [
      { action: "insertBlock", position: "before", ref: refP, blocks: [{ type: "heading", level: 2, runs: [{ text: "小标题" }] }] },
    ]);
    expect(r.ok).toBe(true);
    expect(countHeadingText(r.doc!, "小标题")).toBe(1);
    expect(r.skippedDuplicateInserts).toBe(1);
  });

  it("① 多块 insert 任一块命中重复护栏时整条 op 跳过,不留下乱序残块", () => {
    const base = aiIrToPm({
      blocks: [
        { type: "heading", level: 1, runs: [{ text: "章" }] },
        { type: "heading", level: 2, runs: [{ text: "小标题" }] },
        { type: "paragraph", runs: [{ text: "正文" }] },
      ],
    });
    const refTop = base.content[0]!.attrs.blockId;
    const r = applyBlockEdits(base, [
      {
        action: "insertBlock",
        position: "after",
        ref: refTop,
        blocks: [
          { type: "paragraph", runs: [{ text: "本来会变成残块" }] },
          { type: "heading", level: 2, runs: [{ text: "小标题" }] },
        ],
      },
    ]);

    expect(r.ok).toBe(true);
    expect(r.doc!.content.map(firstText)).toEqual(["章", "小标题", "正文"]);
    expect(r.applied).toEqual([]);
    expect(r.skippedDuplicateInserts).toBe(1);
  });

  it("② 合法相邻重复分隔线(horizontalRule)不被误删", () => {
    const base = aiIrToPm({
      blocks: [
        { type: "paragraph", runs: [{ text: "上文" }] },
        { type: "horizontalRule" },
        { type: "paragraph", runs: [{ text: "下文" }] },
      ],
    });
    const refTop = base.content[0]!.attrs.blockId;
    // 紧邻(idx+1)已是分隔线,再插一条分隔线 → 结构块不去重,保留
    const r = applyBlockEdits(base, [
      { action: "insertBlock", position: "after", ref: refTop, blocks: [{ type: "horizontalRule" }] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.doc!.content.filter((n) => n.type === "horizontalRule").length).toBe(2);
    expect(r.skippedDuplicateInserts).toBe(0);
  });

  it("② 块内重复列表项(同一 list 内两条同文本)不被误删", () => {
    const base = aiIrToPm({ blocks: [{ type: "paragraph", runs: [{ text: "锚点" }] }] });
    const refP = base.content[0]!.attrs.blockId;
    // 单 op 插入一个含两条相同 item 的 list:护栏只比对"整块 vs 相邻整块",绝不动块内 item
    const r = applyBlockEdits(base, [
      {
        action: "insertBlock",
        position: "after",
        ref: refP,
        blocks: [
          { type: "bulletList", items: [{ runs: [{ text: "重复项" }] }, { runs: [{ text: "重复项" }] }] },
        ],
      },
    ]);
    expect(r.ok).toBe(true);
    const list = r.doc!.content.find((n) => n.type === "bulletList") as PmBlockNode & { content: unknown[] };
    expect(list).toBeDefined();
    expect(list.content.length).toBe(2); // 两条 item 都在
  });

  it("② 相邻内容不同的 heading 正常插入(护栏不误伤)", () => {
    const base = aiIrToPm({
      blocks: [
        { type: "heading", level: 1, runs: [{ text: "章" }] },
        { type: "heading", level: 2, runs: [{ text: "小标题A" }] },
      ],
    });
    const refTop = base.content[0]!.attrs.blockId;
    const r = applyBlockEdits(base, [
      { action: "insertBlock", position: "after", ref: refTop, blocks: [{ type: "heading", level: 2, runs: [{ text: "小标题B" }] }] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.doc!.content.length).toBe(3);
    expect(countHeadingText(r.doc!, "小标题B")).toBe(1);
    expect(r.skippedDuplicateInserts).toBe(0);
  });
});

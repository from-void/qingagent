import { describe, expect, it } from "vitest";
import {
  aiBlockToQingml,
  aiBlocksToQingml,
  aiRunMarkToPmMark,
  compileAiDocumentToPm,
  getStablePmJson,
  materializeDraftBlockIds,
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
} from "@qingagent/pm-schema";
import {
  clearDraftMutationScratch,
  createSession,
  createSessionScopedTools,
} from "../bridge/index.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import { qingagentAgent } from "../agents/qingagent.js";

const ctx = {} as any;

function aiParagraph(text: string) {
  return { type: "paragraph", runs: [{ text }] };
}

function qingmlBlock(block: unknown): string {
  return aiBlockToQingml(block as never);
}

function qingmlBlocks(blocks: readonly unknown[]): string {
  return aiBlocksToQingml(blocks as never);
}

function qingmlParagraph(text: string): string {
  return qingmlBlock(aiParagraph(text));
}

function compileDoc(blocks: unknown[]): PmDoc {
  const result = compileAiDocumentToPm({ blocks });
  if (!result.ok || !result.doc) throw new Error("fixture compile failed");
  return result.doc;
}

function paragraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function bulletList(blockId: string, items: Array<{ blockId: string; paragraphId: string; text: string }>): PmBlockNode {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: items.map((item) => ({
      type: "listItem",
      attrs: { blockId: item.blockId },
      content: [paragraph(item.paragraphId, item.text)],
    })),
  } as unknown as PmBlockNode;
}

function codeBlock(blockId: string, text: string, language = "ts"): PmBlockNode {
  return {
    type: "codeBlock",
    attrs: { blockId, language },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function bindDoc(state: ReturnType<typeof createSession>, value: PmDoc): void {
  state.doc = value;
  state.legacySections = pmToLegacySections(value) as any;
  state.docVersion = 1;
}

function inlineText(block: PmBlockNode): string {
  if (!("content" in block) || !Array.isArray(block.content)) return "";
  return block.content.map((node: any) => node.type === "hardBreak" ? "\n" : node.text).join("");
}

describe("QingML draft tools", () => {
  it("agent 只暴露常驻基础工具,草稿工具由 sessionScoped toolset 注入", async () => {
    const tools = await qingagentAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      "askUserQuestion",
      "fetchArticle",
      "parseFile",
      "planDraft",
      "storeMaterial",
    ]);
  });

  it("editDraft 工具描述继续要求 children 递归,不回退到扁平 depth 中间格式", () => {
    const state = createSession("s-edit-description");
    const { editDraft } = createSessionScopedTools(state);
    const description = (editDraft as { description?: string }).description ?? "";

    expect(description).toContain("嵌套 QingML");
    expect(description).toContain("QingML 片段字符串");
    expect(description).toContain("insertTableRow");
    expect(description).toContain("rowIndex/columnIndex 一律是当前表的 0-based 索引");
    expect(description).toContain("同一次 editDraft 调用内多个表格 op 按声明顺序依次应用");
    expect(description).toContain("新增列在表头行对应的新 cell 自动作为表头单元格");
    expect(description).toContain("在表头行前插入数据行");
    expect(description).toContain("<td><p>结论</p><ul><li>依据</li></ul></td>");
    expect(description).toContain("逐块保留 readDraft 返回的 cell 内容");
    expect(description).toContain("colspan/rowspan 属性照抄");
    expect(description).toContain("列宽由系统自动保留");
    expect(description).not.toContain("items+depth");
    expect(description).not.toContain("必须用扁平");
  });

  it("readDraft 默认只返回 qingml,range/outline/query 使用顶层 ref", async () => {
    const state = createSession("s-read");
    bindDoc(state, doc([
      { type: "heading", attrs: { blockId: "block-h", level: 2 }, content: [{ type: "text", text: "标题" }] },
      paragraph("block-a", "春水初生"),
      paragraph("block-b", "春林初盛"),
    ]));
    const { readDraftAiIr } = createSessionScopedTools(state);

    const full = await readDraftAiIr.execute!({ mode: "full" }, ctx) as any;
    expect(full.ok).toBe(true);
    expect(full.blocks[0].ref).toBe("block-h");
    expect(full.blocks[0].qingml).toBe("<h2>标题</h2>");
    expect(full.blocks[0].text).toBeUndefined();

    const range = await readDraftAiIr.execute!({ mode: "range", from: "block-a", to: "block-b", includeText: true }, ctx) as any;
    expect(range.blocks.map((b: any) => b.ref)).toEqual(["block-a", "block-b"]);

    const outline = await readDraftAiIr.execute!({ mode: "outline" }, ctx) as any;
    expect(outline.blocks).toMatchObject([{ ref: "block-h", sectionFrom: "block-h", sectionTo: "block-b" }]);

    const query = await readDraftAiIr.execute!({ query: "春林" }, ctx) as any;
    expect(query.blocks.map((b: any) => b.ref)).toEqual(["block-b"]);
    expect(query.blocks[0].text).toBe("春林初盛");
  });

  it("readDraft range 支持 listItem ref 读取该行文本,full 仍只返回顶层块", async () => {
    const state = createSession("s-read-list-item");
    bindDoc(state, doc([
      bulletList("list-1", [
        { blockId: "item-1", paragraphId: "item-1-p", text: "第一行" },
        { blockId: "item-2", paragraphId: "item-2-p", text: "第二行" },
      ]),
      paragraph("block-after", "列表后段落"),
    ]));
    const { readDraftAiIr } = createSessionScopedTools(state);

    const full = await readDraftAiIr.execute!({ mode: "full", includeText: true }, ctx) as any;
    expect(full.blocks.map((b: any) => b.ref)).toEqual(["list-1", "block-after"]);

    const item = await readDraftAiIr.execute!({
      mode: "range",
      from: "item-2",
      to: "item-2",
      includeText: true,
    }, ctx) as any;

    expect(item.ok).toBe(true);
    expect(item.blocks).toHaveLength(1);
    expect(item.blocks[0]).toMatchObject({
      ref: "item-2",
      type: "listItem",
      text: "第二行",
      editability: { replaceBlockAllowed: false },
    });
    expect(item.blocks[0].qingml).toBeUndefined();
  });

  it("editDraft 混合事务先块后文本,成功后直接写候选", async () => {
    const state = createSession("s-edit");
    bindDoc(state, doc([paragraph("block-a", "旧文本"), paragraph("block-b", "保留")]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [
        { action: "replaceBlock", ref: "block-a", block: qingmlParagraph("新文本") },
        { action: "replaceText", find: "新文本", replace: "最终文本" },
      ],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(state.docDraftCandidateDoc?.content[0]?.attrs.blockId).toBe("block-a");
    expect(inlineText(state.docDraftCandidateDoc!.content[0]!)).toBe("最终文本");
    expect(inlineText(state.doc!.content[0]!)).toBe("旧文本");
  });

  it("editDraft replaceBlock 使用 readDraft 返回的 qingml 片段", async () => {
    const state = createSession("s-edit-envelope-replace");
    bindDoc(state, doc([paragraph("block-a", "旧文本")]));
    const { editDraft, readDraftAiIr } = createSessionScopedTools(state);
    const draft = await readDraftAiIr.execute!({ mode: "full", includeText: true }, ctx) as any;
    expect(draft.blocks[0].qingml).toBe("<p>旧文本</p>");

    const result = await editDraft.execute!({
      ops: [{ action: "replaceBlock", ref: "block-a", block: "<p>片段新文本</p>" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(inlineText(state.docDraftCandidateDoc!.content[0]!)).toBe("片段新文本");
    expect(state.docDraftCandidateDoc!.content[0]!.attrs.blockId).toBe("block-a");
  });

  it("editDraft replaceBlock 保留 codeBlock.text,不把代码正文当 readDraft 外壳剥掉", async () => {
    const state = createSession("s-edit-codeblock-text");
    bindDoc(state, doc([codeBlock("block-code", "const oldValue = 1;")]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{
        action: "replaceBlock",
        ref: "block-code",
        block: "<pre lang=\"ts\">const nextValue = 2;</pre>",
      }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.hunkCount).toBeGreaterThan(0);
    expect(state.docDraftCandidateDoc!.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: expect.objectContaining({ blockId: "block-code", language: "ts" }),
      content: [{ type: "text", text: "const nextValue = 2;" }],
    });
  });

  it("editDraft insertBlock 接受一段含多个块的 QingML", async () => {
    const state = createSession("s-edit-envelope-insert");
    bindDoc(state, doc([paragraph("block-a", "基准")]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-a",
        blocks: "<p>第一段</p><p>第二段</p><p>裸块</p>",
      }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(state.docDraftCandidateDoc!.content.map(inlineText)).toEqual([
      "基准",
      "第一段",
      "第二段",
      "裸块",
    ]);
  });

  it("editDraft 坏 QingML 片段返回 ok:false,非字符串 blocks 也不崩", async () => {
    const state = createSession("s-edit-envelope-bad");
    bindDoc(state, doc([paragraph("block-a", "基准")]));
    const { editDraft } = createSessionScopedTools(state);

    const badFragment = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-a",
        blocks: "<callout><p>块级越界</p></callout>",
      }],
    }, ctx) as any;
    expect(badFragment.ok).toBe(false);
    expect(badFragment.failedOpIndex).toBe(0);
    expect(badFragment.error).toContain("QingML bad-block");

    // 这里钉住“不会落到 TypeError / 不污染草稿”的脏输入行为。
    const nonArray = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-a",
        blocks: { type: "paragraph", runs: [{ text: "不是数组" }] },
      }],
    } as any, ctx) as any;
    expect(nonArray?.ok).not.toBe(true);
    expect((state.docDraftCandidateDoc ?? state.doc)!.content.map(inlineText)).toEqual(["基准"]);
  });

  it("editDraft 任一文本 op 失败则整组回滚", async () => {
    const state = createSession("s-rollback");
    bindDoc(state, doc([paragraph("block-a", "旧文本")]));
    const { editDraft } = createSessionScopedTools(state);
    const before = getStablePmJson(state.doc!);

    const result = await editDraft.execute!({
      ops: [
        { action: "replaceBlock", ref: "block-a", block: qingmlParagraph("新文本") },
        { action: "replaceText", find: "不存在", replace: "不会写入" },
      ],
    }, ctx) as any;

    expect(result.ok).toBe(false);
    expect(result.failedOpIndex).toBe(1);
    expect(state.docDraftCandidateDoc ? getStablePmJson(state.docDraftCandidateDoc) : before).toBe(before);
  });

  it("editDraft 保留重复 blockId 防线，并把刷新自愈指引返回给模型", async () => {
    const state = createSession("s-duplicate-block-id-guidance");
    bindDoc(state, doc([
      paragraph("duplicate-ref", "第一段"),
      paragraph("duplicate-ref", "第二段"),
    ]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{
        action: "replaceBlock",
        ref: "duplicate-ref",
        block: qingmlParagraph("尝试修改"),
      }],
    }, ctx) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("重复 blockId");
    expect(result.error).toContain("请提示用户刷新文档");
    expect(state.docDraftCandidateDoc).toBeNull();
  });

  it("editDraft 服务端 fail-closed 拒绝仍有损的 replaceBlock,但 deleteBlock 放行", async () => {
    const state = createSession("s-lossy");
    const multiParagraphCallout: PmBlockNode = {
      type: "callout",
      attrs: { blockId: "block-callout", emoji: "⚠️", tone: "warning" },
      content: [
        paragraph("block-callout-p1", "第一段") as Extract<PmBlockNode, { type: "paragraph" }>,
        paragraph("block-callout-p2", "第二段") as Extract<PmBlockNode, { type: "paragraph" }>,
      ],
    };
    bindDoc(state, doc([multiParagraphCallout]));
    const { editDraft } = createSessionScopedTools(state);

    const rejected = await editDraft.execute!({
      ops: [{ action: "replaceBlock", ref: "block-callout", block: qingmlParagraph("普通段") }],
    }, ctx) as any;
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("replaceBlock 拒绝有损块");

    const deleted = await editDraft.execute!({
      ops: [{ action: "deleteBlock", ref: "block-callout" }],
    }, ctx) as any;
    expect(deleted.ok).toBe(true);
    expect(state.docDraftCandidateDoc?.content).toHaveLength(0);
  });

  it("editDraft 放行多块 table cell，并拒绝 span+colwidth 合并表", async () => {
    const multiBlockTable: PmBlockNode = {
      type: "table",
      attrs: { blockId: "block-table" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [
            paragraph("block-table-p1", "第一段") as Extract<PmBlockNode, { type: "paragraph" }>,
            {
              type: "bulletList",
              attrs: { blockId: "block-table-list" },
              content: [{
                type: "listItem",
                attrs: { blockId: "block-table-item" },
                content: [paragraph("block-table-item-p", "列表项") as Extract<PmBlockNode, { type: "paragraph" }>],
              }],
            },
          ],
        }],
      }],
    };
    const state = createSession("s-rich-table");
    bindDoc(state, doc([multiBlockTable]));
    const { editDraft, readDraftAiIr } = createSessionScopedTools(state);

    const readable = await readDraftAiIr.execute!({ mode: "full" }, ctx) as any;
    expect(readable.blocks[0].editability).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });

    const allowed = await editDraft.execute!({
      ops: [{
        action: "replaceBlock",
        ref: "block-table",
        block: "<table><tr><td><p>新段落</p><ul><li>新列表</li></ul><callout tone=\"warning\">提示</callout></td></tr></table>",
      }],
    }, ctx) as any;
    expect(allowed.ok).toBe(true);
    const candidate = state.docDraftCandidateDoc?.content[0];
    expect(candidate?.type === "table" ? candidate.content[0]!.content[0]!.content.map((block) => block.type) : []).toEqual([
      "paragraph",
      "bulletList",
      "callout",
    ]);

    const mergedState = createSession("s-merged-width-table");
    bindDoc(mergedState, doc([{
      type: "table",
      attrs: { blockId: "block-merged" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: { colspan: 2, colwidth: [120, 180] },
          content: [paragraph("block-merged-p", "合并") as Extract<PmBlockNode, { type: "paragraph" }>],
        }],
      }],
    }]));
    const mergedTools = createSessionScopedTools(mergedState);
    const mergedResult = await mergedTools.editDraft.execute!({
      ops: [{ action: "replaceBlock", ref: "block-merged", block: "<table><tr><td colspan=\"2\"><p>新</p></td></tr></table>" }],
    }, ctx) as any;
    expect(mergedResult.ok).toBe(true);
    const mergedCandidate = mergedState.docDraftCandidateDoc?.content[0];
    expect(mergedCandidate?.type === "table" ? mergedCandidate.content[0]?.content[0]?.attrs?.colwidth : null)
      .toEqual([120, 180]);
  });

  it("editDraft ok:true 但实际 0 diff 时返回 changed:false/hunkCount:0", async () => {
    const state = createSession("s-noop-edit");
    bindDoc(state, doc([paragraph("block-a", "原文")]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{ action: "replaceText", find: "原文", replace: "原文" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.hunkCount).toBe(0);
    expect(state.docDraftCandidateDoc ? getStablePmJson(state.docDraftCandidateDoc) : getStablePmJson(state.doc!))
      .toBe(getStablePmJson(state.doc!));
  });

  it("editDraft 连续插入相同空段得到不同 ref", async () => {
    const state = createSession("s-insert");
    bindDoc(state, doc([paragraph("block-a", "基准")]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [
        { action: "insertBlock", position: "after", ref: "block-a", blocks: qingmlParagraph("") },
        { action: "insertBlock", position: "after", ref: "block-a", blocks: qingmlParagraph("") },
      ],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    const refs = state.docDraftCandidateDoc!.content.map((block) => block.attrs.blockId);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.some((ref) => ref.startsWith("ai-block-"))).toBe(false);
  });

  it("editDraft insertBlock 相邻重复被整条跳过时返回模型可见 warning", async () => {
    const state = createSession("s-insert-duplicate-warning");
    bindDoc(state, doc([
      { type: "heading", attrs: { blockId: "block-top", level: 1 }, content: [{ type: "text", text: "章" }] },
      { type: "heading", attrs: { blockId: "block-sub", level: 2 }, content: [{ type: "text", text: "小标题" }] },
      paragraph("block-tail", "正文"),
    ]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [
        {
          action: "insertBlock",
          position: "after",
          ref: "block-top",
          blocks: qingmlBlocks([
            aiParagraph("不应留下的残块"),
            { type: "heading", level: 2, runs: [{ text: "小标题" }] },
          ]),
        },
      ],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.skippedDuplicateInserts).toBe(1);
    expect(result.warning).toBe("1 处插入与相邻内容重复被跳过;若确需重复内容,请用 replaceBlock 或换插入位置");
    expect(state.docDraftCandidateDoc?.content.map(inlineText)).toEqual(["章", "小标题", "正文"]);
  });

  it("editDraft 行级 replaceListItem 保留 item ref,并继续产出父 list replace hunk", async () => {
    const state = createSession("s-edit-list-item-structure");
    const base = doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "第一行" },
        { blockId: "item-b", paragraphId: "item-b-p", text: "第二行" },
      ]),
      paragraph("block-tail", "尾段"),
    ]);
    bindDoc(state, base);
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{
        action: "replaceListItem",
        ref: "item-b",
        item: "<li>第二行已改<ul><li>新增子项</li></ul></li>",
      }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    const list = state.docDraftCandidateDoc!.content[0]!;
    expect(list.type).toBe("bulletList");
    if (list.type !== "bulletList") return;
    expect(list.content[1]!.attrs.blockId).toBe("item-b");
    expect(inlineText(list.content[1]!.content[0] as PmBlockNode)).toBe("第二行已改");
    expect(list.content[1]!.content[1]).toMatchObject({ type: "bulletList" });

    const hunks = buildDraftDiff(base, state.docDraftCandidateDoc!);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      blockPath: [0],
      anchor: { blockId: "list-a" },
      beforeBlock: { type: "bulletList" },
      afterBlock: { type: "bulletList" },
    });
  });

  it("editDraft 行级 op 对过期 ref fail-closed,不 fallback 到整 list 误改", async () => {
    const state = createSession("s-edit-list-item-stale-ref");
    bindDoc(state, doc([
      bulletList("list-a", [
        { blockId: "item-a", paragraphId: "item-a-p", text: "第一行" },
      ]),
    ]));
    const { editDraft } = createSessionScopedTools(state);
    const before = getStablePmJson(state.doc!);

    const result = await editDraft.execute!({
      ops: [{
        action: "replaceListItem",
        ref: "missing-item",
        item: "<li>不应写入</li>",
      }],
    }, ctx) as any;

    expect(result.ok).toBe(false);
    expect(result.failedOpIndex).toBe(0);
    expect(result.error).toContain("列表行 missing-item 不存在");
    expect(state.docDraftCandidateDoc ? getStablePmJson(state.docDraftCandidateDoc) : before).toBe(before);
  });

  it("editDraft 表格增量 op 进入 readDiff,且既有单元格字节级不变", async () => {
    const state = createSession("s-edit-table-incremental");
    const base = materializeDraftBlockIds(compileDoc([{
      type: "table",
      rows: [
        {
          cells: [
            { blocks: [{ type: "paragraph", runs: [{ text: "列A，表头。" }] }], header: true },
            { blocks: [{ type: "paragraph", runs: [{ text: "列B\"引用\"", marks: [{ type: "link", href: "https://example.com" }] }] }], header: true },
          ],
        },
        {
          cells: [
            { blocks: [{ type: "paragraph", runs: [{ text: "a1，全角。" }] }] },
            { blocks: [{ type: "paragraph", runs: [{ text: "b1，保持。" }] }] },
          ],
        },
      ],
    }]));
    const tableRef = base.content[0]!.attrs.blockId;
    const beforeTable = base.content[0] as Extract<PmBlockNode, { type: "table" }>;
    const beforeCells = beforeTable.content.map((row) => row.content.map(getStablePmJson));
    bindDoc(state, base);
    const { editDraft, readDiff } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{
        action: "insertTableColumn",
        ref: tableRef,
        at: "end",
        cells: "<th>列C，新增。</th><td>c1，新增。</td>",
      }],
    }, ctx) as any;

    expect(result).toMatchObject({ ok: true });
    expect(result.changed).toBe(true);
    expect(result.hunkCount).toBe(1);
    expect(result.applied).toEqual([tableRef]);
    const table = state.docDraftCandidateDoc!.content[0] as Extract<PmBlockNode, { type: "table" }>;
    expect(table.content[0]!.content[2]!.type).toBe("tableHeader");
    expect(getStablePmJson(table.content[0]!.content[0])).toBe(beforeCells[0]![0]);
    expect(getStablePmJson(table.content[0]!.content[1])).toBe(beforeCells[0]![1]);
    expect(getStablePmJson(table.content[1]!.content[0])).toBe(beforeCells[1]![0]);
    expect(getStablePmJson(table.content[1]!.content[1])).toBe(beforeCells[1]![1]);

    const diff = await readDiff.execute!({}, ctx) as any;
    expect(diff.ok).toBe(true);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ kind: "replace", ref: tableRef });
    expect(diff.stats.blocksChanged).toBe(1);
  });

  it("readDiff 把纯 mark 编辑归并为 markChange 且跨多次 edit 累计", async () => {
    const state = createSession("s-diff");
    bindDoc(state, doc([paragraph("block-a", "山水"), paragraph("block-b", "春风")]));
    const { editDraft, readDiff } = createSessionScopedTools(state);

    await editDraft.execute!({
      ops: [{ action: "markText", find: "山水", mark: { type: "bold" }, op: "add" }],
    }, ctx);
    await editDraft.execute!({
      ops: [{ action: "replaceText", find: "春风", replace: "秋月" }],
    }, ctx);
    const diff = await readDiff.execute!({}, ctx) as any;

    expect(diff.ok).toBe(true);
    expect(diff.changes.map((c: any) => c.kind)).toContain("markChange");
    expect(diff.stats.marksChanged).toBeGreaterThan(0);
    expect(diff.stats.blocksChanged).toBeGreaterThan(0);
    expect(diff.stats.totalWords).toBeGreaterThanOrEqual(4);
  });

  it("clearDraftMutationScratch 只清 scratch,保留 pending base/candidate 供下一轮读取", async () => {
    const state = createSession("s-cross");
    bindDoc(state, doc([paragraph("block-a", "原文")]));
    const { editDraft, readDraftAiIr } = createSessionScopedTools(state);

    await editDraft.execute!({
      ops: [{ action: "replaceText", find: "原文", replace: "候选文" }],
    }, ctx);
    state.patchValidationResults.set("tc", { ok: true, applied: true });
    clearDraftMutationScratch(state);
    const nextRead = await readDraftAiIr.execute!({ includeText: true }, ctx) as any;

    expect(state.patchValidationResults.size).toBe(0);
    expect(state.docDraftBaseDoc).not.toBeNull();
    expect(state.docDraftCandidateDoc).not.toBeNull();
    expect(nextRead.blocks[0].text).toBe("候选文");
  });

  it("markText 继承 S1 mark 边界: remove 只去指定 mark,保留 link", async () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const link = { type: "link" as const, attrs: { href: "#a" } };
    const state = createSession("s-mark-boundary");
    bindDoc(state, doc([{
      type: "paragraph",
      attrs: { blockId: "block-a" },
      content: [{ type: "text", text: "青山", marks: [bold, link] }],
    }]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [{ action: "markText", find: "山", mark: { type: "bold" }, op: "remove" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(state.docDraftCandidateDoc?.content[0]).toMatchObject({
      content: [
        { text: "青", marks: [bold, link] },
        { text: "山", marks: [link] },
      ],
    });
  });
});

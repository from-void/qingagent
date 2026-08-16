import { describe, expect, it } from "vitest";
import {
  EXTERNAL_STRUCTURAL_OP_KINDS,
  type ExternalProposeOp,
} from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import {
  assertUniquePmBlockIds,
  markdownToPm,
  pmToMarkdown,
  pmToMarkdownWithLineMap,
} from "@qingagent/pm-schema";
import {
  applyExternalProposalOps,
  compileExternalQingmlDraft,
  hasExternalStructuralOp,
} from "../docWriteCommands";

describe("compileExternalQingmlDraft", () => {
  it("结构操作 kind 在 contract schema 与服务端幂等判定中保持一致", () => {
    const opSamples = {
      fullDraft: { kind: "fullDraft", markdown: "正文" },
      qingmlDraft: { kind: "qingmlDraft", qingml: "<p>正文</p>" },
      setTitle: { kind: "setTitle", title: "标题" },
      strReplace: { kind: "strReplace", old: "旧", new: "新" },
      markText: { kind: "markText", find: "正文", mark: { type: "bold" }, op: "add" },
      insertAfterLine: { kind: "insertAfterLine", line: 1, markdown: "插入" },
      insertAfterBlock: { kind: "insertAfterBlock", blockId: "block-1", markdown: "插入" },
      appendSection: { kind: "appendSection", markdown: "追加" },
      deleteBlock: { kind: "deleteBlock", blockId: "block-1" },
      deleteListItem: { kind: "deleteListItem", blockId: "item-1" },
    } satisfies {
      [Kind in ExternalProposeOp["kind"]]: Extract<ExternalProposeOp, { kind: Kind }>;
    };
    const allKinds = Object.keys(opSamples) as ExternalProposeOp["kind"][];
    const schemaKinds = allKinds.filter((kind) => !commandSchema.safeParse({
      kind: "externalPropose",
      data: {
        sessionId: "session-1",
        expectedDocVersion: 1,
        ops: [opSamples[kind]],
      },
    }).success);
    const serverKinds = allKinds.filter((kind) =>
      hasExternalStructuralOp([opSamples[kind]])
    );

    expect(schemaKinds).toEqual([...EXTERNAL_STRUCTURAL_OP_KINDS]);
    expect(serverKinds).toEqual(schemaKinds);
  });

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

  it("markText add 为唯一命中文本添加行内标记", async () => {
    const result = await applyExternalProposalOps(markdownToPm("前缀目标后缀"), [{
      kind: "markText",
      find: "目标",
      mark: { type: "highlight", color: "yellow" },
      op: "add",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]).toMatchObject({
      content: [
        { text: "前缀" },
        { text: "目标", marks: [{ type: "highlight", attrs: { color: "yellow" } }] },
        { text: "后缀" },
      ],
    });
  });

  it("markText remove 移除指定标记并保留正文", async () => {
    const result = await applyExternalProposalOps(markdownToPm("**目标**"), [{
      kind: "markText",
      find: "目标",
      mark: { type: "bold" },
      op: "remove",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]).toMatchObject({ content: [{ text: "目标" }] });
    expect(JSON.stringify(result.doc)).not.toContain('"type":"bold"');
  });

  it("markText all:true 应用全部命中", async () => {
    const result = await applyExternalProposalOps(markdownToPm("目标一\n\n目标二"), [{
      kind: "markText",
      find: "目标",
      mark: { type: "underline" },
      op: "add",
      all: true,
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.doc).match(/"type":"underline"/g)).toHaveLength(2);
  });

  it("markText withinRef 只在指定块内匹配", async () => {
    const candidate = markdownToPm("目标一\n\n目标二");
    const targetBlockId = candidate.content[1]!.attrs.blockId;
    const result = await applyExternalProposalOps(candidate, [{
      kind: "markText",
      find: "目标",
      mark: { type: "italic" },
      op: "add",
      withinRef: targetBlockId,
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.doc.content[0])).not.toContain('"type":"italic"');
    expect(JSON.stringify(result.doc.content[1])).toContain('"type":"italic"');
  });

  it("markText 非 all 多义命中返回可自纠文案", async () => {
    const result = await applyExternalProposalOps(markdownToPm("目标一\n\n目标二"), [{
      kind: "markText",
      find: "目标",
      mark: { type: "bold" },
      op: "add",
    }]);

    expect(result).toEqual({
      ok: false,
      error: "文本未命中或未唯一命中,请缩小 withinRef 或设 all:true",
    });
  });

  it("markText isRegex 通过安全正则应用匹配", async () => {
    const result = await applyExternalProposalOps(markdownToPm("目标1 与目标2"), [{
      kind: "markText",
      find: "目标\\d",
      mark: { type: "code" },
      op: "add",
      all: true,
      isRegex: true,
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.doc).match(/"type":"code"/g)).toHaveLength(2);
  });

  it("局部插入只拼接受影响区间，未触碰块保留原节点引用与 blockId", async () => {
    const canonical = markdownToPm("第一段。\n\n第二段。\n\n第三段。");
    const candidate = structuredClone(canonical);
    const untouched = [...candidate.content];
    expect(candidate).not.toBe(canonical);
    expect(candidate.content[0]).not.toBe(canonical.content[0]);

    const result = await applyExternalProposalOps(candidate, [
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

  it("P34：整篇行偏移跨 30+ 行表格后仍把插入落在第 36/37 项之间", async () => {
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

    const result = await applyExternalProposalOps(candidate, [{
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

  it("P34：多行大块内部行拒绝吸附，并指向 insertAfterBlock 与同批行号过期", async () => {
    const candidate = markdownToPm("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n尾段");
    const table = pmToMarkdownWithLineMap(candidate).blocks.find((span) => span.blockType === "table");
    expect(table).toBeTruthy();
    const result = await applyExternalProposalOps(candidate, [{
      kind: "insertAfterLine",
      line: table!.startLine + 1,
      markdown: "不应插入",
    }]);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain("多行 table 块");
    expect(result.error).toContain("insertAfterBlock");
    expect(result.error).toContain("同批前序操作会使后续行号过期");
  });

  it("insertAfterBlock 对顶层末尾锚点插入多个块，清单容器锚点仍按顶层解释", async () => {
    const candidate = markdownToPm("- [ ] 清单项");
    const taskListId = candidate.content[0]!.attrs.blockId;
    const result = await applyExternalProposalOps(candidate, [{
      kind: "insertAfterBlock",
      blockId: taskListId,
      markdown: "新增一\n\n新增二",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content.map((block) => block.type)).toEqual([
      "taskList", "paragraph", "paragraph",
    ]);
    expect(pmToMarkdown(result.doc)).toContain("清单项\n\n新增一\n\n新增二");
    assertUniquePmBlockIds(result.doc);
  });

  it("insertAfterBlock 在嵌套列表项后插入同深度兄弟，并保留新项后代", async () => {
    const candidate = markdownToPm("- 父项\n  - 子项甲\n  - 子项乙\n- 尾项");
    const root = candidate.content[0]!;
    expect(root.type).toBe("bulletList");
    if (root.type !== "bulletList") return;
    const nested = root.content[0]!.content[1];
    expect(nested?.type).toBe("bulletList");
    if (nested?.type !== "bulletList") return;

    const result = await applyExternalProposalOps(candidate, [{
      kind: "insertAfterBlock",
      blockId: nested.content[0]!.attrs.blockId,
      markdown: "- 新子项\n  - 随行后代",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = pmToMarkdown(result.doc);
    expect(out.indexOf("子项甲")).toBeLessThan(out.indexOf("新子项"));
    expect(out.indexOf("新子项")).toBeLessThan(out.indexOf("子项乙"));
    expect(out).toContain("  - 随行后代");
    expect(result.doc.content).toHaveLength(1);
    assertUniquePmBlockIds(result.doc);
  });

  it("insertAfterBlock 拒绝表格 cell 内锚点", async () => {
    const candidate = markdownToPm("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const table = candidate.content[0]!;
    expect(table.type).toBe("table");
    if (table.type !== "table") return;
    const cellParagraphId = table.content[1]!.content[0]!.content[0]!.attrs.blockId;

    const result = await applyExternalProposalOps(candidate, [{
      kind: "insertAfterBlock",
      blockId: cellParagraphId,
      markdown: "不应插入",
    }]);

    expect(result).toEqual({ ok: false, error: "暂不支持表格内锚点" });
  });

  it.each([
    ["非列表 markdown", "普通段落"],
    ["不同类列表", "- 普通列表项"],
    ["多个同类列表项", "- [ ] 新任务一\n- [ ] 新任务二"],
  ])("insertAfterBlock 列表锚点拒绝%s", async (_label, markdown) => {
    const candidate = markdownToPm("- [ ] 原任务");
    const taskList = candidate.content[0]!;
    expect(taskList.type).toBe("taskList");
    if (taskList.type !== "taskList") return;

    const result = await applyExternalProposalOps(candidate, [{
      kind: "insertAfterBlock",
      blockId: taskList.content[0]!.attrs.blockId,
      markdown,
    }]);

    expect(result).toMatchObject({
      ok: false,
      error: "列表项锚点的 markdown 必须恰好包含 1 条同类列表项",
    });
  });

  it("insertAfterBlock 拒绝空 Markdown 与空 taskItem", async () => {
    const paragraph = markdownToPm("原段");
    expect(await applyExternalProposalOps(paragraph, [{
      kind: "insertAfterBlock",
      blockId: paragraph.content[0]!.attrs.blockId,
      markdown: " \n ",
    }])).toMatchObject({ ok: false, error: expect.stringContaining("不能为空") });
    expect(await applyExternalProposalOps(paragraph, [{
      kind: "insertAfterBlock",
      blockId: paragraph.content[0]!.attrs.blockId,
      markdown: "- [ ]   ",
    }])).toMatchObject({ ok: false, error: expect.stringContaining("taskItem 内容不能为空") });

    const tasks = markdownToPm("- [ ] 原任务");
    const taskList = tasks.content[0]!;
    expect(taskList.type).toBe("taskList");
    if (taskList.type !== "taskList") return;
    expect(await applyExternalProposalOps(tasks, [{
      kind: "insertAfterBlock",
      blockId: taskList.content[0]!.attrs.blockId,
      markdown: "- [ ]   ",
    }])).toMatchObject({ ok: false, error: expect.stringContaining("不能为空") });
  });

  it("insertAfterBlock 同批先删锚点时整批失败且不泄漏删除", async () => {
    const candidate = markdownToPm("- [ ] 任务甲\n- [ ] 任务乙");
    const before = structuredClone(candidate);
    const taskList = candidate.content[0]!;
    expect(taskList.type).toBe("taskList");
    if (taskList.type !== "taskList") return;
    const anchorId = taskList.content[0]!.attrs.blockId;

    const result = await applyExternalProposalOps(candidate, [
      { kind: "deleteListItem", blockId: anchorId },
      { kind: "insertAfterBlock", blockId: anchorId, markdown: "- [ ] 新任务" },
    ]);

    expect(result).toEqual({ ok: false, error: "锚点块已被同批前序操作删除" });
    expect(candidate).toEqual(before);
  });

  it("insertAfterBlock 同批多个同锚点插入按 op 顺序排列", async () => {
    const candidate = markdownToPm("- [ ] 任务甲\n- [ ] 任务乙");
    const taskList = candidate.content[0]!;
    expect(taskList.type).toBe("taskList");
    if (taskList.type !== "taskList") return;
    const anchorId = taskList.content[0]!.attrs.blockId;

    const result = await applyExternalProposalOps(candidate, [
      { kind: "insertAfterBlock", blockId: anchorId, markdown: "- [ ] 新任务一" },
      { kind: "insertAfterBlock", blockId: anchorId, markdown: "- [ ] 新任务二" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pmToMarkdown(result.doc)).toBe([
      "- [ ] 任务甲", "- [ ] 新任务一", "- [ ] 新任务二", "- [ ] 任务乙",
    ].join("\n"));
  });

  it("P34：整篇序列化过滤的空块不再额外占两行", async () => {
    const candidate = markdownToPm("第一段\n\n第二段");
    candidate.content.splice(1, 0, {
      type: "paragraph",
      attrs: { blockId: "empty-shell" },
      content: [],
    });
    const serialized = pmToMarkdownWithLineMap(candidate);
    expect(serialized.markdown).toBe("第一段\n\n第二段");
    expect(serialized.blocks.map((span) => span.blockIndex)).toEqual([0, 2]);

    const result = await applyExternalProposalOps(candidate, [{
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

  it("结构操作整批失败不泄漏前序删除", async () => {
    const candidate = markdownToPm("第一段\n\n第二段");
    const before = structuredClone(candidate);
    const result = await applyExternalProposalOps(candidate, [
      { kind: "deleteBlock", blockId: candidate.content[0]!.attrs.blockId },
      { kind: "deleteBlock", blockId: "missing-block" },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect(candidate).toEqual(before);
  });
});

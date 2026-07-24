import { describe, expect, it } from "vitest";
import {
  aiRunMarkToPmMark,
  getStablePmJson,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { buildDraftDiff } from "../proposalDiff.js";
import {
  collectTopLevelTextBlocks,
  containsLiteralMatch,
  findAnnotationQuoteMatches,
  findLiteralMatches,
  findSafeRegexMatches,
  markTextRuns,
  replaceTextRuns,
} from "../textEditOps.js";

function text(textValue: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: textValue, marks }
    : { type: "text", text: textValue };
}

function hardBreak(): PmInlineNode {
  return { type: "hardBreak" };
}

function paragraph(blockId: string, content: string | PmInlineNode[]): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function bulletList(blockId: string, items: Array<{ blockId: string; paragraphId: string; content: PmInlineNode[] }>): PmBlockNode {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: items.map((item) => ({
      type: "listItem",
      attrs: { blockId: item.blockId },
      content: [paragraph(item.paragraphId, item.content)],
    })),
  } as unknown as PmBlockNode;
}

function inlineText(docValue: PmDoc): string {
  return (docValue.content[0] as Extract<PmBlockNode, { type: "paragraph" }>)
    .content?.map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return "￼";
      return node.text;
    })
    .join("") ?? "";
}

function listItemTexts(docValue: PmDoc): string[] {
  const list = docValue.content[0] as any;
  return (list.content ?? []).map((item: any) =>
    (item.content?.[0]?.content ?? []).map((node: any) => node.type === "hardBreak" ? "\n" : node.text).join(""),
  );
}

describe("textEditOps", () => {
  it("tx-contains-literal-normalize: 素材引文校验兼容空白和全半角差异", () => {
    expect(containsLiteralMatch("收入为１２０\n亿元", "收入为 120亿元")).toBe(true);
  });

  it("批注锚点精确失败后按空白与引号变体二次匹配", () => {
    const base = doc([paragraph("block-a", "  他说：“别   相信她”。  ")]);
    const matches = findAnnotationQuoteMatches(
      collectTopLevelTextBlocks(base),
      "「别 相信她」",
      false,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      blockId: "block-a",
      matchText: "“别   相信她”",
    });
  });

  it("批注锚点有精确候选时不进入归一化回退", () => {
    const base = doc([paragraph("block-a", "“原句”与「原句」")]);
    const matches = findAnnotationQuoteMatches(
      collectTopLevelTextBlocks(base),
      "「原句」",
      false,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchText).toBe("「原句」");
  });

  it("tx-replaceText-keepMarks: 替换文本继承命中处 marks", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const link = aiRunMarkToPmMark({ type: "link", href: "https://example.com", title: "示例" });
    const base = doc([paragraph("block-a", [text("这是"), text("春天", [bold, link]), text("。")])]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "春天", false);

    const next = replaceTextRuns(base, matches, "初春");

    expect(next.content[0]).toMatchObject({
      content: [
        { text: "这是" },
        { text: "初春", marks: [bold, link] },
        { text: "。" },
      ],
    });
  });

  it("tx-replaceText-reassembledPrefix: 选区前缀改写,replace 含选区外已有后缀时不重复拼接", () => {
    // 复现 edit-aimodify-duplicate-punct(R14/16/21/22/25):用户只选中标题前缀,
    // 模型把整条新标题塞进 replace,旧链路只替换选区→选区外后缀保留→重复。
    const base = doc([
      {
        type: "heading",
        attrs: { blockId: "h1", level: 1 },
        content: [text("多模态大模型综述：架构、对齐与数据治理")],
      } as unknown as PmBlockNode,
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "多模态大模型综述", false);

    const next = replaceTextRuns(base, matches, "多模态大模型综述：架构、对齐与数据治理");

    expect(inlineText(next)).toBe("多模态大模型综述：架构、对齐与数据治理");
  });

  it("tx-replaceText-reassembledRewrittenPrefix: 选区前缀被改写+带上旧后缀时也不重复(最长重叠裁剪)", () => {
    // 复审变体:find=「多模态大模型综述」被改写成「…研究综述」,replace 仍带旧后缀。
    // replace 不再以 find 开头/包含 find,靠尾部最长重叠裁掉重复后缀。
    const base = doc([
      {
        type: "heading",
        attrs: { blockId: "h1", level: 1 },
        content: [text("多模态大模型综述：架构、对齐与数据治理")],
      } as unknown as PmBlockNode,
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "多模态大模型综述", false);

    const next = replaceTextRuns(base, matches, "多模态大模型研究综述：架构、对齐与数据治理");

    expect(inlineText(next)).toBe("多模态大模型研究综述：架构、对齐与数据治理");
  });

  it("tx-replaceText-reassembledKeepsSuffixMarks: 裁掉重复后缀时,选区外后缀原有 marks 不丢", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const base = doc([
      {
        type: "heading",
        attrs: { blockId: "h1", level: 1 },
        content: [text("综述"), text("：要点", [bold])],
      } as unknown as PmBlockNode,
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "综述", false);

    const next = replaceTextRuns(base, matches, "研究综述：要点");

    // 后缀「：要点」是原节点保留(仍带 bold),replace 里重复的那份被裁掉。
    expect(next.content[0]).toMatchObject({
      content: [{ text: "研究综述" }, { text: "：要点", marks: [bold] }],
    });
  });

  it("tx-replaceText-reassembledSuffix: 选区后缀改写,replace 含选区外已有前缀时不重复拼接", () => {
    const base = doc([paragraph("p1", "第一章 总则")]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "总则", false);

    const next = replaceTextRuns(base, matches, "第一章 总则");

    expect(inlineText(next)).toBe("第一章 总则");
  });

  it("tx-replaceText-noFalseDedup: replace 以 find 开头但延伸不等于紧邻原文时,不误吞后文", () => {
    // 选中 "测试" 改成 "测试用例";延伸 "用例" 不等于块内紧邻的 " 通过" → 守卫不触发,正常替换。
    const base = doc([paragraph("p1", "测试 通过")]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "测试", false);

    const next = replaceTextRuns(base, matches, "测试用例");

    expect(inlineText(next)).toBe("测试用例 通过");
  });

  it("tx-replaceText-captures: 正则捕获组替换正确展开", async () => {
    const base = doc([paragraph("block-a", "中A混B")]);
    const result = await findSafeRegexMatches(
      collectTopLevelTextBlocks(base),
      "([一-龥])([A-Za-z])",
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = replaceTextRuns(base, result.matches, "$1 $2", true);

    expect(inlineText(next)).toBe("中 A混 B");
  });

  it("tx-withinRef: withinRef 只命中指定顶层块", () => {
    const base = doc([
      paragraph("block-a", "华章在前"),
      paragraph("block-b", "华章在后"),
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base, "block-b"), "华章", false);

    const next = replaceTextRuns(base, matches, "新章");

    expect(next.content.map((block) => block.type === "paragraph" ? inlineText(doc([block])) : "")).toEqual([
      "华章在前",
      "新章在后",
    ]);
  });

  it("tx-withinRef-listItem: item ref 只命中该行子树,同文案 sibling 和 hardBreak 不误改", () => {
    const base = doc([
      bulletList("list-1", [
        { blockId: "item-1", paragraphId: "item-1-p", content: [text("同词"), hardBreak(), text("保留")] },
        { blockId: "item-2", paragraphId: "item-2-p", content: [text("同词"), hardBreak(), text("目标")] },
      ]),
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base, "item-2"), "同词\n目标", false);

    const next = replaceTextRuns(base, matches, "改好");

    expect(listItemTexts(next)).toEqual(["同词\n保留", "改好"]);
  });

  it("tx-withinRef-listTop: 顶层 list ref 仍命中全部 descendants", () => {
    const base = doc([
      bulletList("list-1", [
        { blockId: "item-1", paragraphId: "item-1-p", content: [text("华章")] },
        { blockId: "item-2", paragraphId: "item-2-p", content: [text("华章")] },
      ]),
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base, "list-1"), "华章", true);

    const next = replaceTextRuns(base, matches, "新章");

    expect(listItemTexts(next)).toEqual(["新章", "新章"]);
  });

  it("tx-withinRef-missingItem: 不存在 item ref fail-closed,不退回整 list", () => {
    const base = doc([
      bulletList("list-1", [
        { blockId: "item-1", paragraphId: "item-1-p", content: [text("华章")] },
        { blockId: "item-2", paragraphId: "item-2-p", content: [text("华章")] },
      ]),
    ]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base, "missing-item"), "华章", true);

    const next = replaceTextRuns(base, matches, "新章");

    expect(matches).toEqual([]);
    expect(getStablePmJson(next)).toBe(getStablePmJson(base));
  });

  it("tx-all-false-multi: all=false 多命中时不返回可应用命中", () => {
    const base = doc([paragraph("block-a", "山山山")]);
    const before = getStablePmJson(base);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "山", false);

    const next = replaceTextRuns(base, matches, "水");

    expect(matches).toHaveLength(0);
    expect(getStablePmJson(next)).toBe(before);
  });

  it("tx-zeroHit: 0 命中时文档不变", () => {
    const base = doc([paragraph("block-a", "春水初生")]);
    const before = getStablePmJson(base);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "不存在", true);

    const next = replaceTextRuns(base, matches, "替换");

    expect(matches).toHaveLength(0);
    expect(getStablePmJson(next)).toBe(before);
  });

  it("tx-markText-add: add bold 只给命中区间加 mark", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const base = doc([paragraph("block-a", "远山如黛")]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "山", false);

    const next = markTextRuns(base, matches, bold, "add");

    expect(inlineText(next)).toBe("远山如黛");
    expect(next.content[0]).toMatchObject({
      content: [
        { text: "远" },
        { text: "山", marks: [bold] },
        { text: "如黛" },
      ],
    });
  });

  it("tx-markText-remove: remove 只去指定 mark 且保留其它 mark", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const link = aiRunMarkToPmMark({ type: "link", href: "https://example.com", title: "示例" });
    const base = doc([paragraph("block-a", [text("青山", [bold, link])])]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "山", false);

    const next = markTextRuns(base, matches, bold, "remove");

    expect(next.content[0]).toMatchObject({
      content: [
        { text: "青", marks: [bold, link] },
        { text: "山", marks: [link] },
      ],
    });
  });

  it("tx-markText-link/highlight: 支持 link 和 highlight", () => {
    const link = aiRunMarkToPmMark({ type: "link", href: "#mountain", title: "山" });
    const highlight = aiRunMarkToPmMark({ type: "highlight", color: "green" });
    const base = doc([paragraph("block-a", "山水")]);
    const linkMatches = findLiteralMatches(collectTopLevelTextBlocks(base), "山", false);
    const linked = markTextRuns(base, linkMatches, link, "add");
    const highlightMatches = findLiteralMatches(collectTopLevelTextBlocks(linked), "水", false);

    const next = markTextRuns(linked, highlightMatches, highlight, "add");

    expect(next.content[0]).toMatchObject({
      content: [
        { text: "山", marks: [link] },
        { text: "水", marks: [highlight] },
      ],
    });
  });

  it("tx-markText-overlap: mark 区间套和部分 remove 正确切分", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const highlight = aiRunMarkToPmMark({ type: "highlight", color: "yellow" });
    const base = doc([paragraph("block-a", [text("春"), text("天山", [bold]), text("水")])]);
    const addMatches = findLiteralMatches(collectTopLevelTextBlocks(base), "山水", false);
    const highlighted = markTextRuns(base, addMatches, highlight, "add");
    const removeMatches = findLiteralMatches(collectTopLevelTextBlocks(highlighted), "山", false);

    const next = markTextRuns(highlighted, removeMatches, bold, "remove");

    expect(next.content[0]).toMatchObject({
      content: [
        { text: "春" },
        { text: "天", marks: [bold] },
        { text: "山", marks: [highlight] },
        { text: "水", marks: [highlight] },
      ],
    });
  });

  it("tx-markText-readDiff-visible: 纯 markText 会产生 markAdd hunk", () => {
    const bold = aiRunMarkToPmMark({ type: "bold" });
    const base = doc([paragraph("block-a", "山水")]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "山水", false);
    const next = markTextRuns(base, matches, bold, "add");

    const hunks = buildDraftDiff(base, next);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "markAdd",
      beforeText: "山水",
      afterText: "山水",
      marks: [bold],
    });
  });
});

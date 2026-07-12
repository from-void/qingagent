import { describe, expect, it } from "vitest";
import { applyBlockEdits, type BlockEdit } from "../ai-ir/applyBlockEdits";
import { aiBlockSchema, type AiBlock, type AiDocument } from "../ai-ir/aiIrSchema";
import { aiIrToPm, compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import { pmToAiIr } from "../ai-ir/pmToAiIr";
import { getStablePmJson } from "../hash";
import { PM_CALLOUT_TONES, PM_HIGHLIGHT_COLORS, PM_TEXT_ALIGN_VALUES } from "../spec";
import type {
  PmBlockNode,
  PmDoc,
  PmInlineNode,
  PmListItemNode,
  PmMark,
  PmParagraphNode,
  PmTableCellNode,
  PmTableRowNode,
  PmTextAlign,
} from "../types";
import { safeParsePmDoc } from "../validators";

const ROUND_TRIP_BASE_SEED = 0xb300_1001;
const DIRTY_AI_IR_BASE_SEED = 0xb300_2001;
const BLOCK_EDIT_BASE_SEED = 0xb300_3001;

const ALL_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "codeBlock",
  "table",
  "image",
  "fileAttachment",
  "penNote",
  "taskList",
  "callout",
  "blockMath",
] as const satisfies readonly PmBlockNode["type"][];

const SIMPLE_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "horizontalRule",
  "codeBlock",
  "image",
  "fileAttachment",
  "penNote",
  "blockMath",
] as const satisfies readonly PmBlockNode["type"][];

// tableCell/tableHeader 的 runtime schema 明确排除直接 table；fuzz 必须从同一白名单取样，
// 否则会把产品已禁止的嵌套表误当合法基线，后续脏变体的错误索引也会被基线错误污染。
const TABLE_CELL_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "codeBlock",
  "image",
  "fileAttachment",
  "penNote",
  "taskList",
  "callout",
  "blockMath",
] as const satisfies readonly PmBlockNode["type"][];

const PM_MARK_BITS = ["bold", "italic", "underline", "strike", "code", "link", "highlight"] as const;
const MARK_COMBINATION_COUNT = 1 << PM_MARK_BITS.length;

const TEXT_FRAGMENTS = [
  "甲",
  "Beta",
  "含 ] } 和 \"quote\"",
  "路径 C:\\drafts\\alpha",
  "A | B",
  "emoji ",
  "line\nbreak",
  "空格 与 tab\t",
  "标点，。、；：",
] as const;

const LATEX_CHARS = "abcXYZ0123456789+-=*/_^{}[]()\\,.;:<>|~!@#%&? '";
const MULTI_CODEPOINT_EMOJI = ["💡", "⚠️", "✅", "🧪", "👩‍💻", "🏳️‍🌈", "☕️", "🧠", "🧑🏽‍🚀"] as const;

class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  int(min: number, max: number): number {
    return min + (this.nextUint32() % (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.nextUint32() / 0x1_0000_0000 < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

interface GenCtx {
  seed: number;
  nextId: number;
}

describe("rich format fuzz round trips", () => {
  it("固定 seed 生成 200 份 PM 富文档:PM → AI-IR → PM 第二轮字节稳定", () => {
    const seenBlockTypes = new Set<PmBlockNode["type"]>();
    const seenMarkMasks = new Set<number>();
    let seenInlineMath = false;

    for (let caseIndex = 0; caseIndex < 200; caseIndex += 1) {
      const seed = seedFor(ROUND_TRIP_BASE_SEED, caseIndex);
      const doc = randomPmDoc(seed, caseIndex);
      collectCoverage(doc, seenBlockTypes, seenMarkMasks, (value) => {
        seenInlineMath ||= value;
      });

      const failure = roundTripFailure(doc);
      if (failure) {
        const minimal = minimizePmDoc(doc, (candidate) => roundTripFailure(candidate) !== null);
        const minimalFailure = roundTripFailure(minimal) ?? failure;
        throw new Error(
          [
            "round-trip fuzz case failed",
            `seed=${formatSeed(seed)}`,
            `minimalRepro=${getStablePmJson(minimal)}`,
            `cause=${minimalFailure}`,
          ].join("\n"),
        );
      }
    }

    expect([...seenBlockTypes].sort()).toEqual([...ALL_BLOCK_TYPES].sort());
    expect(seenInlineMath).toBe(true);
    expect(seenMarkMasks.size).toBe(MARK_COMBINATION_COUNT);
  });

  it("固定 seed 随机 AI-IR 脏变体:要么修复成功,要么返回带块索引的 blockErrors", () => {
    for (let caseIndex = 0; caseIndex < 160; caseIndex += 1) {
      const seed = seedFor(DIRTY_AI_IR_BASE_SEED, caseIndex);
      const rng = new Prng(seed);
      const legal = pmToAiIr(randomPmDoc(seedFor(seed, 17), caseIndex));
      const targetIndex = rng.int(0, legal.blocks.length - 1);
      const dirty = cloneJson(legal) as unknown as { blocks: unknown[] };
      const mutation = mutateAiBlock(dirty.blocks[targetIndex]!, rng);

      withRepro(seed, "dirty-ai-ir", { mutation, targetIndex, aiIr: dirty }, () => {
        let result: ReturnType<typeof compileAiDocumentToPm>;
        try {
          result = compileAiDocumentToPm(dirty);
        } catch (error) {
          throw new Error(`compileAiDocumentToPm 不应抛未捕获异常: ${errorMessage(error)}`);
        }

        if (result.ok) {
          expect(result.doc, "ok=true 时必须返回 doc").not.toBeNull();
          expect(safeParsePmDoc(result.doc).success, "修复成功时产物必须过 PM validator").toBe(true);
        } else {
          expect(result.doc, "失败时不得产出半合法 doc").toBeNull();
          expect(result.blockErrors.length, "失败时必须返回 blockErrors").toBeGreaterThan(0);
          expect(result.blockErrors.some((error) => error.index === targetIndex), "blockErrors 必须包含被破坏块的索引").toBe(true);
        }
      });
    }
  });

  it("固定 seed 随机 applyBlockEdits 序列:合法产物合法,未触碰块复用原对象引用", () => {
    for (let caseIndex = 0; caseIndex < 80; caseIndex += 1) {
      const seed = seedFor(BLOCK_EDIT_BASE_SEED, caseIndex);
      const rng = new Prng(seed);
      const doc = randomPmDoc(seedFor(seed, 23), caseIndex);
      const ops = randomBlockEdits(doc, rng);
      const touchedRefs = new Set(
        ops.flatMap((op) => (op.action === "replaceBlock" || op.action === "deleteBlock" ? [op.ref] : [])),
      );

      const result = applyBlockEdits(doc, ops);

      if (!result.ok) {
        expect(result.doc, "applyBlockEdits 失败时 doc 必须为 null").toBeNull();
        continue;
      }

      expect(result.doc, "applyBlockEdits 成功时必须返回 doc").not.toBeNull();
      const nextDoc = result.doc!;
      expect(safeParsePmDoc(nextDoc).success, "applyBlockEdits 成功产物必须合法").toBe(true);

      const identityFailureRef = untouchedIdentityFailure(doc, nextDoc, touchedRefs);
      if (identityFailureRef) {
        const minimal = minimalApplyIdentityRepro();
        const minimalResult = applyBlockEdits(minimal.doc, minimal.ops);
        const minimalTouchedRefs = new Set(
          minimal.ops.flatMap((op) => (op.action === "replaceBlock" || op.action === "deleteBlock" ? [op.ref] : [])),
        );
        const minimalFailureRef = minimalResult.doc
          ? untouchedIdentityFailure(minimal.doc, minimalResult.doc, minimalTouchedRefs)
          : identityFailureRef;
        throw new Error(
          [
            "apply-block-edits fuzz case failed",
            `seed=${formatSeed(seed)}`,
            `minimalRepro=${getStablePmJson(minimal)}`,
            `cause=未触碰块 ${minimalFailureRef ?? identityFailureRef} 未保持 === 引用复用; randomFailureRef=${identityFailureRef}`,
          ].join("\n"),
        );
      }
    }
  });

  it("PM validator 与 AI-IR schema 的接受度不对称清单保持显式", () => {
    const cases: Array<{
      name: string;
      pmDoc: unknown;
      aiBlock: unknown;
      pmOk: boolean;
      aiSchemaOk: boolean;
      compileOk: boolean;
      assertCompiledDoc?: (doc: PmDoc | null) => void;
    }> = [
      {
        name: "blockMath latex 空串:PM 收,AI-IR blockMath 拒",
        pmDoc: docWith([{ type: "blockMath", attrs: { blockId: "pm-empty-block-math", latex: "" } }]),
        aiBlock: { type: "blockMath", latex: "" },
        pmOk: true,
        aiSchemaOk: false,
        compileOk: false,
      },
      {
        name: "inlineMath latex 空串:PM 收,AI-IR math run 当前收但编译后被空 run 规则丢弃",
        pmDoc: docWith([
          {
            type: "paragraph",
            attrs: { blockId: "pm-empty-inline-math" },
            content: [{ type: "inlineMath", attrs: { latex: "" } }],
          },
        ]),
        aiBlock: { type: "paragraph", runs: [{ text: "", marks: [{ type: "math" }] }] },
        pmOk: true,
        aiSchemaOk: true,
        compileOk: true,
        assertCompiledDoc: (doc) => {
          expect(doc?.content[0]).toMatchObject({ type: "paragraph", content: [] });
        },
      },
      {
        name: "taskItem checked:PM 必填,AI-IR taskList item 可默认 false",
        pmDoc: docWith([
          {
            type: "taskList",
            attrs: { blockId: "pm-task-list" },
            content: [
              {
                type: "taskItem",
                attrs: { blockId: "pm-task-item" },
                content: [paragraph("pm-task-item-p", "缺 checked")],
              },
            ],
          },
        ]),
        aiBlock: { type: "taskList", items: [{ runs: [{ text: "缺 checked" }] }] },
        pmOk: false,
        aiSchemaOk: true,
        compileOk: true,
      },
      {
        name: "strikeThrough:PM mark 拒,AI-IR 兼容并编译成 strike",
        pmDoc: docWith([
          {
            type: "paragraph",
            attrs: { blockId: "pm-strike-through" },
            content: [{ type: "text", text: "删除线", marks: [{ type: "strikeThrough" }] }],
          },
        ]),
        aiBlock: { type: "paragraph", runs: [{ text: "删除线", marks: [{ type: "strikeThrough" }] }] },
        pmOk: false,
        aiSchemaOk: true,
        compileOk: true,
        assertCompiledDoc: (doc) => {
          expect(doc?.content[0]).toMatchObject({
            content: [{ type: "text", text: "删除线", marks: [{ type: "strike" }] }],
          });
        },
      },
      {
        name: "textAlign null:PM normalize 收,AI-IR enum 拒",
        pmDoc: docWith([
          {
            type: "paragraph",
            attrs: { blockId: "pm-null-align", textAlign: null },
            content: [{ type: "text", text: "align" }],
          },
        ]),
        aiBlock: { type: "paragraph", textAlign: null, runs: [{ text: "align" }] },
        pmOk: true,
        aiSchemaOk: false,
        compileOk: false,
      },
      {
        name: "link href 含空格:AI-IR schema 粗收,PM validator/compile 拒",
        pmDoc: docWith([
          {
            type: "paragraph",
            attrs: { blockId: "pm-space-link" },
            content: [
              { type: "text", text: "bad link", marks: [{ type: "link", attrs: { href: "https://example.com/a b" } }] },
            ],
          },
        ]),
        aiBlock: { type: "paragraph", runs: [{ text: "bad link", marks: [{ type: "link", href: "https://example.com/a b" }] }] },
        pmOk: false,
        aiSchemaOk: true,
        compileOk: false,
      },
    ];

    for (const item of cases) {
      const compiled = compileAiDocumentToPm({ blocks: [item.aiBlock] });

      expect(safeParsePmDoc(item.pmDoc).success, item.name).toBe(item.pmOk);
      expect(aiBlockSchema.safeParse(item.aiBlock).success, item.name).toBe(item.aiSchemaOk);
      expect(compiled.ok, item.name).toBe(item.compileOk);
      if (compiled.doc !== null) {
        expect(safeParsePmDoc(compiled.doc).success, item.name).toBe(true);
      }
      item.assertCompiledDoc?.(compiled.doc);
    }
  });
});

function randomPmDoc(seed: number, caseIndex: number): PmDoc {
  const rng = new Prng(seed);
  const ctx: GenCtx = { seed, nextId: 0 };
  const forcedType = ALL_BLOCK_TYPES[caseIndex % ALL_BLOCK_TYPES.length]!;
  const content: PmBlockNode[] = [
    forcedMarkedParagraph(ctx, rng, caseIndex % MARK_COMBINATION_COUNT),
    randomPmBlock(ctx, rng, 0, forcedType),
  ];
  const targetLength = rng.int(5, 10);
  while (content.length < targetLength) {
    content.push(randomPmBlock(ctx, rng, 0));
  }
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function randomPmBlock(
  ctx: GenCtx,
  rng: Prng,
  depth: number,
  forcedType?: PmBlockNode["type"],
): PmBlockNode {
  const allowedTypes = depth >= 2 ? SIMPLE_BLOCK_TYPES : ALL_BLOCK_TYPES;
  const type = forcedType ?? rng.pick(allowedTypes);
  switch (type) {
    case "paragraph":
      return randomParagraph(ctx, rng);
    case "heading":
      return randomHeading(ctx, rng);
    case "blockquote":
      return {
        type: "blockquote",
        attrs: { blockId: nextBlockId(ctx, "blockquote") },
        content: randomNestedBlocks(ctx, rng, depth + 1),
      };
    case "bulletList":
      return randomList(ctx, rng, depth, "bulletList");
    case "orderedList":
      return randomList(ctx, rng, depth, "orderedList");
    case "horizontalRule":
      return { type: "horizontalRule", attrs: { blockId: nextBlockId(ctx, "horizontalRule") } };
    case "codeBlock":
      return randomCodeBlock(ctx, rng);
    case "table":
      return randomTable(ctx, rng, depth);
    case "image":
      return randomImage(ctx, rng);
    case "fileAttachment":
      return randomFileAttachment(ctx, rng);
    case "penNote":
      return {
        type: "penNote",
        attrs: { blockId: nextBlockId(ctx, "penNote") },
        content: randomInlineContent(ctx, rng),
      };
    case "taskList":
      return randomTaskList(ctx, rng);
    case "callout":
      return randomCallout(ctx, rng);
    case "blockMath":
      return { type: "blockMath", attrs: { blockId: nextBlockId(ctx, "blockMath"), latex: randomLatex(rng) } };
    case "diagram":
      // diagram 暂不纳入 ALL_BLOCK_TYPES 的随机覆盖(markdown 往返腿尚未对称);此 case 仅满足穷举。
      return { type: "diagram", attrs: { blockId: nextBlockId(ctx, "diagram"), lang: "mermaid", source: "flowchart TD\n  A --> B", svg: null } };
    case "columnList":
      // 分栏不纳入随机覆盖(AI-IR 不透明、往返有损,专测在 columnSerialization);此 case 仅满足穷举。
      return {
        type: "columnList",
        attrs: { blockId: nextBlockId(ctx, "columnList") },
        content: [
          { type: "column", attrs: { blockId: nextBlockId(ctx, "column"), widthRatio: 0.5 }, content: [randomParagraph(ctx, rng)] },
          { type: "column", attrs: { blockId: nextBlockId(ctx, "column"), widthRatio: 0.5 }, content: [randomParagraph(ctx, rng)] },
        ],
      };
  }
}

function forcedMarkedParagraph(ctx: GenCtx, rng: Prng, markMask: number): PmParagraphNode {
  return {
    type: "paragraph",
    attrs: { blockId: nextBlockId(ctx, "forced-mark") },
    content: [
      textNode(`mark-mask-${markMask}`, marksForMask(markMask)),
      { type: "text", text: " " },
      { type: "inlineMath", attrs: { latex: randomLatex(rng) } },
    ],
  };
}

function randomParagraph(ctx: GenCtx, rng: Prng): PmParagraphNode {
  return {
    type: "paragraph",
    attrs: attrsWithOptionalAlign(ctx, rng, "paragraph"),
    content: randomInlineContent(ctx, rng),
  };
}

function randomHeading(ctx: GenCtx, rng: Prng): PmBlockNode {
  const attrs: PmBlockNode["attrs"] & { level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null } = {
    ...attrsWithOptionalAlign(ctx, rng, "heading"),
    level: rng.int(1, 6) as 1 | 2 | 3 | 4 | 5 | 6,
  };
  if (rng.chance(0.35)) attrs.anchor = rng.chance(0.5) ? `anchor-${rng.int(1, 99)}` : null;
  return { type: "heading", attrs, content: randomInlineContent(ctx, rng) };
}

function randomList(
  ctx: GenCtx,
  rng: Prng,
  depth: number,
  type: "bulletList" | "orderedList",
): PmBlockNode {
  const content: PmListItemNode[] = Array.from({ length: rng.int(1, 4) }, () => ({
    type: "listItem",
    attrs: { blockId: nextBlockId(ctx, "listItem") },
    content: randomNestedBlocks(ctx, rng, depth + 1),
  }));
  if (type === "bulletList") return { type, attrs: { blockId: nextBlockId(ctx, type) }, content };
  return {
    type,
    attrs: { blockId: nextBlockId(ctx, type), start: rng.chance(0.5) ? rng.int(1, 9) : null },
    content,
  };
}

function randomCodeBlock(ctx: GenCtx, rng: Prng): PmBlockNode {
  const language = rng.pick(["ts", "markdown", "latex", "plaintext", null] as const);
  const content = rng.chance(0.15) ? [] : [{ type: "text" as const, text: randomCodeText(rng) }];
  return { type: "codeBlock", attrs: { blockId: nextBlockId(ctx, "codeBlock"), language }, content };
}

function randomTable(ctx: GenCtx, rng: Prng, depth: number): PmBlockNode {
  const rowCount = rng.int(1, 3);
  const columnCount = rng.int(1, 3);
  const content: PmTableRowNode[] = Array.from({ length: rowCount }, (_, rowIndex) => ({
    type: "tableRow",
    content: Array.from({ length: columnCount }, (_, columnIndex): PmTableCellNode => ({
      type: rowIndex === 0 && rng.chance(0.45) ? "tableHeader" : "tableCell",
      attrs: rng.chance(0.25) ? { colspan: 1, rowspan: 1, colwidth: [rng.int(80, 240)] } : undefined,
      content: randomTableCellBlocks(ctx, rng, depth + 1, columnIndex % 2 === 0 ? "paragraph" : undefined),
    })),
  }));
  return { type: "table", attrs: { blockId: nextBlockId(ctx, "table") }, content };
}

function randomImage(ctx: GenCtx, rng: Prng): PmBlockNode {
  const id = nextBlockId(ctx, "image");
  return {
    type: "image",
    attrs: {
      blockId: id,
      src: `/api/v1/files/550e8400-e29b-41d4-a716-446655440000/${id}.png`,
      alt: rng.chance(0.5) ? `图 ${id}` : null,
      title: rng.chance(0.25) ? `title ${id}` : null,
      caption: rng.chance(0.5) ? `caption ${randomText(rng)}` : null,
      width: rng.chance(0.7) ? rng.int(80, 1024) : null,
      height: rng.chance(0.7) ? rng.int(80, 768) : null,
    },
  };
}

function randomFileAttachment(ctx: GenCtx, rng: Prng): PmBlockNode {
  const id = nextBlockId(ctx, "fileAttachment");
  return {
    type: "fileAttachment",
    attrs: {
      blockId: id,
      fileId: `file_${id}`,
      filename: `${id}.pdf`,
      mimeType: rng.pick(["application/pdf", "text/plain", "image/png"] as const),
      size: rng.int(0, 1_000_000),
    },
  };
}

function randomTaskList(ctx: GenCtx, rng: Prng): PmBlockNode {
  return {
    type: "taskList",
    attrs: { blockId: nextBlockId(ctx, "taskList") },
    content: Array.from({ length: rng.int(1, 4) }, () => ({
      type: "taskItem" as const,
      attrs: { blockId: nextBlockId(ctx, "taskItem"), checked: rng.chance(0.5) },
      content: Array.from({ length: rng.int(1, 2) }, () => randomParagraph(ctx, rng)),
    })),
  };
}

function randomCallout(ctx: GenCtx, rng: Prng): PmBlockNode {
  return {
    type: "callout",
    attrs: {
      blockId: nextBlockId(ctx, "callout"),
      emoji: rng.chance(0.8) ? rng.pick(MULTI_CODEPOINT_EMOJI) : null,
      tone: rng.chance(0.8) ? rng.pick(PM_CALLOUT_TONES) : null,
    },
    content: Array.from({ length: rng.int(1, 2) }, () => randomParagraph(ctx, rng)),
  };
}

function randomNestedBlocks(
  ctx: GenCtx,
  rng: Prng,
  depth: number,
  forcedFirstType?: PmBlockNode["type"],
): PmBlockNode[] {
  return Array.from({ length: rng.int(1, 3) }, (_, index) =>
    randomPmBlock(ctx, rng, depth, index === 0 ? forcedFirstType : undefined),
  );
}

function randomTableCellBlocks(
  ctx: GenCtx,
  rng: Prng,
  depth: number,
  forcedFirstType?: PmBlockNode["type"],
): PmBlockNode[] {
  return Array.from({ length: rng.int(1, 3) }, (_, index) =>
    randomPmBlock(
      ctx,
      rng,
      depth,
      index === 0 && forcedFirstType ? forcedFirstType : rng.pick(TABLE_CELL_BLOCK_TYPES),
    ),
  );
}

function randomInlineContent(ctx: GenCtx, rng: Prng): PmInlineNode[] {
  const nodes: PmInlineNode[] = [];
  for (let index = 0; index < rng.int(2, 6); index += 1) {
    const kind = rng.int(0, 9);
    if (kind <= 5) {
      nodes.push(textNode(randomText(rng), marksForMask(rng.int(0, MARK_COMBINATION_COUNT - 1))));
    } else if (kind <= 7) {
      nodes.push({ type: "inlineMath", attrs: { latex: randomLatex(rng) } });
    } else {
      nodes.push({ type: "hardBreak" });
    }
  }
  if (!nodes.some((node) => node.type === "text")) {
    nodes.push(textNode(randomText(rng), marksForMask(rng.int(0, MARK_COMBINATION_COUNT - 1))));
  }
  void ctx;
  return nodes;
}

function textNode(text: string, marks: PmMark[]): PmInlineNode {
  return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}

function marksForMask(mask: number): PmMark[] {
  const marks: PmMark[] = [];
  if (mask & (1 << 0)) marks.push({ type: "bold" });
  if (mask & (1 << 1)) marks.push({ type: "italic" });
  if (mask & (1 << 2)) marks.push({ type: "underline" });
  if (mask & (1 << 3)) marks.push({ type: "strike" });
  if (mask & (1 << 4)) marks.push({ type: "code" });
  if (mask & (1 << 5)) marks.push({ type: "link", attrs: { href: `/fuzz/link-${mask}`, title: mask % 2 === 0 ? null : `link ${mask}` } });
  if (mask & (1 << 6)) marks.push({ type: "highlight", attrs: { color: PM_HIGHLIGHT_COLORS[mask % PM_HIGHLIGHT_COLORS.length]! } });
  return marks;
}

function markMask(marks: readonly PmMark[] | undefined): number {
  let mask = 0;
  for (const mark of marks ?? []) {
    if (mark.type === "bold") mask |= 1 << 0;
    if (mark.type === "italic") mask |= 1 << 1;
    if (mark.type === "underline") mask |= 1 << 2;
    if (mark.type === "strike") mask |= 1 << 3;
    if (mark.type === "code") mask |= 1 << 4;
    if (mark.type === "link") mask |= 1 << 5;
    if (mark.type === "highlight") mask |= 1 << 6;
  }
  return mask;
}

function attrsWithOptionalAlign(ctx: GenCtx, rng: Prng, type: string): { blockId: string; textAlign?: PmTextAlign } {
  const attrs: { blockId: string; textAlign?: PmTextAlign } = { blockId: nextBlockId(ctx, type) };
  if (rng.chance(0.45)) attrs.textAlign = rng.pick(PM_TEXT_ALIGN_VALUES);
  return attrs;
}

function nextBlockId(ctx: GenCtx, type: string): string {
  ctx.nextId += 1;
  return `fuzz-${(ctx.seed >>> 0).toString(16)}-${ctx.nextId}-${type}`;
}

function randomText(rng: Prng): string {
  const parts = Array.from({ length: rng.int(1, 4) }, () => {
    const fragment = rng.pick(TEXT_FRAGMENTS);
    return fragment === "emoji " ? `${fragment}${rng.pick(MULTI_CODEPOINT_EMOJI)}` : fragment;
  });
  return parts.join(rng.chance(0.3) ? " " : "");
}

function randomCodeText(rng: Prng): string {
  return `const value_${rng.int(1, 999)} = ${JSON.stringify(randomText(rng))};\n// ${randomText(rng)}`;
}

function randomLatex(rng: Prng): string {
  const length = rng.int(1, 28);
  let latex = "";
  for (let index = 0; index < length; index += 1) {
    latex += LATEX_CHARS[rng.int(0, LATEX_CHARS.length - 1)]!;
  }
  return latex.trim().length > 0 ? latex : "x";
}

function randomBlockEdits(doc: PmDoc, rng: Prng): BlockEdit[] {
  const refs = doc.content.map((node) => node.attrs.blockId);
  return Array.from({ length: rng.int(5, 15) }, (_, opIndex): BlockEdit => {
    const kind = rng.int(0, 2);
    const ref = rng.pick(refs);
    if (kind === 0) {
      return { action: "replaceBlock", ref, block: randomAiBlock(rng, opIndex) };
    }
    if (kind === 1) {
      return { action: "deleteBlock", ref };
    }
    const position = rng.pick(["before", "after", "start", "end"] as const);
    const blocks = Array.from({ length: rng.int(1, 2) }, (_, blockIndex) => randomAiBlock(rng, opIndex * 10 + blockIndex));
    if (position === "start" || position === "end") return { action: "insertBlock", position, blocks };
    return { action: "insertBlock", position, ref, blocks };
  });
}

function randomAiBlock(rng: Prng, salt: number): AiBlock {
  const seed = seedFor(rng.nextUint32(), salt + 1);
  const doc = randomPmDoc(seed, salt);
  const ai = pmToAiIr(doc);
  return ai.blocks[rng.int(0, ai.blocks.length - 1)]!;
}

function mutateAiBlock(block: unknown, rng: Prng): string {
  if (!isRecord(block)) return "non-object-block";
  const mutation = rng.int(0, 4);
  if (mutation === 0) return deleteRequiredField(block, rng);
  if (mutation === 1) return writeWrongType(block);
  if (mutation === 2) return writeBareBooleanMark(block);
  if (mutation === 3) return mixItemsShape(block, rng);
  return scrambleNestedShape(block, rng);
}

function deleteRequiredField(block: Record<string, unknown>, rng: Prng): string {
  const type = block.type;
  const fieldsByType: Record<string, readonly string[]> = {
    paragraph: ["runs"],
    heading: ["level", "runs"],
    blockquote: ["runs"],
    codeBlock: ["text"],
    bulletList: ["items"],
    orderedList: ["items"],
    table: ["rows"],
    image: ["src"],
    fileAttachment: ["fileId", "filename", "mimeType", "size"],
    penNote: ["runs"],
    taskList: ["items"],
    callout: ["runs"],
    blockMath: ["latex"],
    horizontalRule: ["type"],
  };
  const field = typeof type === "string" ? rng.pick(fieldsByType[type] ?? ["type"]) : "type";
  delete block[field];
  return `delete-required:${field}`;
}

function writeWrongType(block: Record<string, unknown>): string {
  const type = block.type;
  if (type === "heading") block.level = "2";
  else if (type === "blockMath") block.latex = { bad: true };
  else if (type === "image") block.src = true;
  else if (type === "fileAttachment") block.size = "large";
  else if ("runs" in block) block.runs = true;
  else if ("items" in block) block.items = "not-items";
  else if ("rows" in block) block.rows = [{ cells: [] }];
  else block.type = 42;
  return "wrong-type";
}

function writeBareBooleanMark(block: Record<string, unknown>): string {
  const run = firstRunRecord(block);
  if (!run) return writeWrongType(block);
  run.marks = true;
  run.bold = true;
  run.italic = true;
  run.href = "/fuzz/repaired-link";
  return "bare-boolean-mark";
}

function mixItemsShape(block: Record<string, unknown>, rng: Prng): string {
  if (block.type === "taskList") {
    block.items = [
      [{ text: "裸 run[] 条目", bold: true }],
      { checked: rng.chance(0.5), runs: [{ text: "对象条目", href: "/mixed" }] },
      { checked: "yes", runs: true },
    ];
    return "taskList-mixed-items";
  }
  if (block.type === "bulletList" || block.type === "orderedList") {
    block.items = [[{ text: "合法项" }], { checked: false, runs: [{ text: "错位对象" }] }, true];
    return `${String(block.type)}-mixed-items`;
  }
  block.items = [[{ text: "额外 items 会被 schema 剥离" }], true];
  return "extra-items-on-non-list";
}

function scrambleNestedShape(block: Record<string, unknown>, rng: Prng): string {
  if (block.type === "table") {
    block.rows = [
      { cells: [{ runs: [{ text: "ok" }] }] },
      { cells: rng.chance(0.5) ? [] : [{ runs: true }] },
    ];
    return "table-bad-cells";
  }
  if (block.type === "callout") {
    block.emoji = "👨‍👩‍👧‍👦".repeat(4);
    return "callout-emoji-too-long";
  }
  if (block.type === "image") {
    block.src = "https://example.com/not-allowed.png";
    return "image-disallowed-src";
  }
  return deleteRequiredField(block, rng);
}

function firstRunRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstRunRecord(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record;
  for (const child of Object.values(record)) {
    const found = firstRunRecord(child);
    if (found) return found;
  }
  return null;
}

function collectCoverage(
  doc: PmDoc,
  blockTypes: Set<PmBlockNode["type"]>,
  markMasks: Set<number>,
  setSeenInlineMath: (seen: boolean) => void,
): void {
  for (const block of doc.content) collectBlockCoverage(block, blockTypes, markMasks, setSeenInlineMath);
}

function collectBlockCoverage(
  block: PmBlockNode,
  blockTypes: Set<PmBlockNode["type"]>,
  markMasks: Set<number>,
  setSeenInlineMath: (seen: boolean) => void,
): void {
  blockTypes.add(block.type);
  if (block.type === "paragraph" || block.type === "heading" || block.type === "penNote") {
    collectInlineCoverage(block.content ?? [], markMasks, setSeenInlineMath);
    return;
  }
  if (block.type === "codeBlock") {
    for (const text of block.content ?? []) markMasks.add(markMask(text.marks));
    return;
  }
  if (block.type === "blockquote") {
    block.content.forEach((child) => collectBlockCoverage(child, blockTypes, markMasks, setSeenInlineMath));
    return;
  }
  if (block.type === "bulletList" || block.type === "orderedList") {
    block.content.flatMap((item) => item.content).forEach((child) => collectBlockCoverage(child, blockTypes, markMasks, setSeenInlineMath));
    return;
  }
  if (block.type === "taskList") {
    block.content.flatMap((item) => item.content).forEach((child) => {
      if (child.type === "paragraph") {
        collectInlineCoverage(child.content ?? [], markMasks, setSeenInlineMath);
      } else {
        collectBlockCoverage(child, blockTypes, markMasks, setSeenInlineMath);
      }
    });
    return;
  }
  if (block.type === "callout") {
    block.content.forEach((paragraphNode) => collectInlineCoverage(paragraphNode.content ?? [], markMasks, setSeenInlineMath));
    return;
  }
  if (block.type === "table") {
    block.content
      .flatMap((row) => row.content)
      .flatMap((cell) => cell.content)
      .forEach((child) => collectBlockCoverage(child, blockTypes, markMasks, setSeenInlineMath));
  }
}

function collectInlineCoverage(
  content: readonly PmInlineNode[],
  markMasks: Set<number>,
  setSeenInlineMath: (seen: boolean) => void,
): void {
  for (const node of content) {
    if (node.type === "text") markMasks.add(markMask(node.marks));
    if (node.type === "inlineMath") setSeenInlineMath(true);
  }
}

function roundTripFailure(doc: PmDoc): string | null {
  const parsed = safeParsePmDoc(doc);
  if (!parsed.success) return `生成器产物未过 PM validator:${parsed.error.message}`;

  let first: PmDoc;
  try {
    first = aiIrToPm(pmToAiIr(doc));
  } catch (error) {
    return `aiIrToPm(pmToAiIr(doc)) 抛错:${errorMessage(error)}`;
  }

  const firstParsed = safeParsePmDoc(first);
  if (!firstParsed.success) return `第一轮 AI-IR 物化产物未过 PM validator:${firstParsed.error.message}`;
  // 先比 AI-IR 可表达结构，避免“首轮已经把 table cell 多块拍平，第二轮只是稳定地错下去”。
  // colwidth 不在 AI-IR 内，由 replaceBlock carry-over 另测；因此以 pmToAiIr 两侧等价为准。
  const sourceIr = getStablePmJson(pmToAiIr(doc));
  const firstIr = getStablePmJson(pmToAiIr(first));
  if (sourceIr !== firstIr) {
    return `第一轮 AI-IR 结构不等价:${firstDiff(sourceIr, firstIr)}`;
  }

  let second: PmDoc;
  try {
    second = aiIrToPm(pmToAiIr(first));
  } catch (error) {
    return `第二轮 aiIrToPm(pmToAiIr(first)) 抛错:${errorMessage(error)}`;
  }

  const left = getStablePmJson(first);
  const right = getStablePmJson(second);
  return left === right ? null : `第二轮往返与第一轮字节不一致:${firstDiff(left, right)}`;
}

function minimizePmDoc(doc: PmDoc, stillFails: (candidate: PmDoc) => boolean): PmDoc {
  let content = [...doc.content];
  let changed = true;
  while (changed && content.length > 1) {
    changed = false;
    for (let index = 0; index < content.length; index += 1) {
      const candidateContent = content.filter((_, candidateIndex) => candidateIndex !== index);
      const candidate: PmDoc = { ...doc, content: candidateContent };
      if (candidateContent.length > 0 && stillFails(candidate)) {
        content = candidateContent;
        changed = true;
        break;
      }
    }
  }

  let current: PmDoc = { ...doc, content };
  changed = true;
  while (changed) {
    changed = false;
    for (let blockIndex = 0; blockIndex < current.content.length; blockIndex += 1) {
      const block = current.content[blockIndex]!;
      for (const candidateBlock of blockShrinkCandidates(block)) {
        const candidate: PmDoc = {
          ...current,
          content: current.content.map((item, index) => (index === blockIndex ? candidateBlock : item)),
        };
        if (safeParsePmDoc(candidate).success && stillFails(candidate)) {
          current = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return current;
}

function blockShrinkCandidates(block: PmBlockNode): PmBlockNode[] {
  const candidates: PmBlockNode[] = [];
  if (block.type === "paragraph" || block.type === "heading" || block.type === "penNote") {
    for (const content of removeOne(block.content ?? [])) {
      candidates.push({ ...block, content } as PmBlockNode);
    }
    return candidates;
  }
  if (block.type === "blockquote") {
    candidates.push(...removeOne(block.content).map((content) => ({ ...block, content })));
    block.content.forEach((child, childIndex) => {
      for (const candidateChild of blockShrinkCandidates(child)) {
        candidates.push({ ...block, content: replaceAt(block.content, childIndex, candidateChild) });
      }
    });
    return candidates;
  }
  if (block.type === "bulletList" || block.type === "orderedList") {
    candidates.push(...removeOne(block.content).map((content) => ({ ...block, content } as PmBlockNode)));
    block.content.forEach((item, itemIndex) => {
      for (const itemContent of removeOne(item.content)) {
        candidates.push({
          ...block,
          content: replaceAt(block.content, itemIndex, { ...item, content: itemContent }),
        } as PmBlockNode);
      }
      item.content.forEach((child, childIndex) => {
        for (const candidateChild of blockShrinkCandidates(child)) {
          candidates.push({
            ...block,
            content: replaceAt(block.content, itemIndex, {
              ...item,
              content: replaceAt(item.content, childIndex, candidateChild),
            }),
          } as PmBlockNode);
        }
      });
    });
    return candidates;
  }
  if (block.type === "taskList") {
    candidates.push(...removeOne(block.content).map((content) => ({ ...block, content })));
    block.content.forEach((item, itemIndex) => {
      for (const paragraphs of removeOne(item.content)) {
        candidates.push({ ...block, content: replaceAt(block.content, itemIndex, { ...item, content: paragraphs }) });
      }
      item.content.forEach((paragraphNode, paragraphIndex) => {
        for (const candidateParagraph of blockShrinkCandidates(paragraphNode)) {
          if (candidateParagraph.type !== "paragraph") continue;
          candidates.push({
            ...block,
            content: replaceAt(block.content, itemIndex, {
              ...item,
              content: replaceAt(item.content, paragraphIndex, candidateParagraph),
            }),
          });
        }
      });
    });
    return candidates;
  }
  if (block.type === "callout") {
    candidates.push(...removeOne(block.content).map((content) => ({ ...block, content })));
    block.content.forEach((paragraphNode, paragraphIndex) => {
      for (const candidateParagraph of blockShrinkCandidates(paragraphNode)) {
        if (candidateParagraph.type !== "paragraph") continue;
        candidates.push({ ...block, content: replaceAt(block.content, paragraphIndex, candidateParagraph) });
      }
    });
    return candidates;
  }
  if (block.type === "table") {
    candidates.push(...removeOne(block.content).map((content) => ({ ...block, content })));
    block.content.forEach((row, rowIndex) => {
      candidates.push(...removeOne(row.content).map((cells) => ({ ...block, content: replaceAt(block.content, rowIndex, { ...row, content: cells }) })));
      row.content.forEach((cell, cellIndex) => {
        for (const cellContent of removeOne(cell.content)) {
          candidates.push(replaceTableCell(block, rowIndex, cellIndex, { ...cell, content: cellContent }));
        }
        cell.content.forEach((child, childIndex) => {
          for (const candidateChild of blockShrinkCandidates(child)) {
            candidates.push(
              replaceTableCell(block, rowIndex, cellIndex, {
                ...cell,
                content: replaceAt(cell.content, childIndex, candidateChild),
              }),
            );
          }
        });
      });
    });
  }
  return candidates;
}

function removeOne<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [];
  return items.map((_, index) => items.filter((__, candidateIndex) => candidateIndex !== index));
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, candidateIndex) => (candidateIndex === index ? value : item));
}

function replaceTableCell(
  table: Extract<PmBlockNode, { type: "table" }>,
  rowIndex: number,
  cellIndex: number,
  cell: PmTableCellNode,
): PmBlockNode {
  const row = table.content[rowIndex]!;
  return {
    ...table,
    content: replaceAt(table.content, rowIndex, {
      ...row,
      content: replaceAt(row.content, cellIndex, cell),
    }),
  };
}

function firstDiff(left: string, right: string): string {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  const start = Math.max(0, index - 80);
  const end = index + 160;
  return getStablePmJson({
    index,
    left: left.slice(start, end),
    right: right.slice(start, end),
  });
}

function untouchedIdentityFailure(doc: PmDoc, nextDoc: PmDoc, touchedRefs: ReadonlySet<string>): string | null {
  const nextByRef = new Map(nextDoc.content.map((node) => [node.attrs.blockId, node]));
  for (const original of doc.content) {
    if (touchedRefs.has(original.attrs.blockId)) continue;
    if (nextByRef.get(original.attrs.blockId) !== original) return original.attrs.blockId;
  }
  return null;
}

function minimalApplyIdentityRepro(): { doc: PmDoc; ops: BlockEdit[] } {
  const doc: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "identity-a" },
        content: [{ type: "text", text: "A" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "identity-b" },
        content: [{ type: "text", text: "B" }],
      },
    ],
  };
  return {
    doc,
    ops: [
      {
        action: "insertBlock",
        position: "after",
        ref: "identity-a",
        blocks: [{ type: "paragraph", runs: [{ text: "inserted" }] }],
      },
    ],
  };
}

function docWith(content: unknown[]): unknown {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function paragraph(blockId: string, text: string): unknown {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function seedFor(base: number, offset: number): number {
  return (base + Math.imul(offset + 1, 0x9e3779b9)) >>> 0;
}

function withRepro(seed: number, label: string, payload: unknown, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    throw new Error(
      [
        `${label} fuzz case failed`,
        `seed=${formatSeed(seed)}`,
        `repro=${getStablePmJson(payload)}`,
        `cause=${errorMessage(error)}`,
      ].join("\n"),
    );
  }
}

function formatSeed(seed: number): string {
  return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

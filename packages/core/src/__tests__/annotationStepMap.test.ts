import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationGroup, PmStep } from "@qingagent/contract-ts";
import {
  buildAnnotationMappingSteps,
  mapAnnotationGroupsThroughSteps,
} from "../doc-engine/annotationMapping.js";
import { collectTopLevelTextBlocks } from "../utils/pmTextBlocks.js";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import { getDocumentsClient, insertAnnotationGroups, persistMappedAnnotationGroups } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";

const anchor = (blockId: string, pmFrom: number, pmTo: number, quote: string) => ({
  blockId, pmFrom, pmTo, quote, textHash: `hash-${quote}`,
});

const paragraph = (blockId: string, value: string): PmBlockNode => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text: value }],
});

const codeBlock = (blockId: string, value: string): PmBlockNode => ({
  type: "codeBlock",
  attrs: { blockId, language: "text" },
  content: [{ type: "text", text: value }],
} as PmBlockNode);

const doc = (content: PmBlockNode[]): PmDoc => ({
  type: "doc",
  attrs: { schemaVersion: 1 },
  content,
});

describe("annotation StepMap", () => {
  let db: TempDocumentsDb;
  beforeEach(() => { db = prepareTempDocumentsDb("qa-annotation-map-"); });
  afterEach(() => db.cleanup());

  it("agent replace 只平移未受影响组，位置和引句保持正确", async () => {
    const groups: AnnotationGroup[] = [
      { id: "g1", summary: "问题一", note: "说明一", origin: "source-check", status: "reviewing", anchors: [anchor("p", 1, 3, "甲组")] },
      { id: "g2", summary: "问题二", note: "说明二", origin: "consistency", status: "reviewing", anchors: [anchor("p", 5, 7, "乙组")] },
    ];
    await insertAnnotationGroups("doc-map", 1, groups);
    const insertStep: PmStep = {
      stepType: "replace",
      from: 3,
      to: 3,
      slice: { content: [{ type: "text", text: "新增" }], openStart: 0, openEnd: 0 },
    };
    const finalDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{ type: "paragraph" as const, attrs: { blockId: "p" }, content: [{ type: "text" as const, text: "甲组新增中间乙组" }] }],
    };
    const mapped = mapAnnotationGroupsThroughSteps(groups, [insertStep], finalDoc);
    expect(mapped.groups).toHaveLength(2);
    expect(mapped.groups[0]?.anchors[0]).toMatchObject({ quote: "甲组", pmFrom: 1, pmTo: 3 });
    expect(mapped.groups[1]?.anchors[0]).toMatchObject({ quote: "乙组", pmFrom: 7, pmTo: 9 });

    await persistMappedAnnotationGroups("doc-map", mapped.groups, mapped.survivingAnchorIndexes);
    const rows = await getDocumentsClient().execute(
      "SELECT group_id,status,COUNT(*) AS n FROM document_suggestions WHERE doc_id='doc-map' GROUP BY group_id,status ORDER BY group_id,status",
    );
    expect(rows.rows).toMatchObject([
      { group_id: "g1", status: "reviewing", n: 1 },
      { group_id: "g2", status: "reviewing", n: 1 },
    ]);
  });

  it("多锚组漂移一字时只标记失效锚点并保留存活锚点", async () => {
    const groups: AnnotationGroup[] = [{
      id: "g-multi",
      summary: "多处同类问题",
      note: "说明",
      origin: "source-check",
      status: "accepted",
      anchors: [anchor("p", 1, 3, "甲组"), anchor("p", 5, 7, "乙组")],
    }];
    const step: PmStep = {
      stepType: "replace",
      from: 2,
      to: 2,
      slice: { content: [{ type: "text", text: "新" }], openStart: 0, openEnd: 0 },
    };
    const finalDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{ type: "paragraph" as const, attrs: { blockId: "p" }, content: [{ type: "text" as const, text: "甲新组中间乙组" }] }],
    };

    const mapped = mapAnnotationGroupsThroughSteps(groups, [step], finalDoc);
    expect(mapped.groups).toEqual([expect.objectContaining({
      id: "g-multi",
      anchors: [expect.objectContaining({ quote: "乙组", pmFrom: 6, pmTo: 8 })],
    })]);
    expect(mapped.survivingAnchorIndexes.get("g-multi")).toEqual([1]);
    expect(mapped.invalidatedAnchorIndexes.get("g-multi")).toEqual([0]);
    expect(mapped.invalidatedAnchorCount).toBe(1);
    expect(mapped.unlocatedGroupCount).toBe(0);

    await insertAnnotationGroups("doc-map-partial", 1, groups);
    await persistMappedAnnotationGroups(
      "doc-map-partial",
      mapped.groups,
      mapped.survivingAnchorIndexes,
    );
    const rows = await getDocumentsClient().execute(
      "SELECT id,status FROM document_suggestions WHERE doc_id='doc-map-partial' ORDER BY id",
    );
    expect(rows.rows).toMatchObject([
      { id: "g-multi:1", status: "ignored" },
      { id: "g-multi:2", status: "accepted" },
    ]);
  });

  it("整块重写压扁三处同引文坐标时按 blockId 与归一化引文逐一重定位，只淘汰真实消失组", () => {
    const oldQuote = "三连 “方面”";
    const newQuote = "三连 「方面」";
    const baseText = `${oldQuote}；${oldQuote}；${oldQuote}；已经删除。`;
    const finalText = `改写后：${newQuote}；${newQuote}；${newQuote}。`;
    const finalDoc = doc([paragraph("rewrite-block", finalText)]);
    const quoteOffsets: number[] = [];
    for (let from = baseText.indexOf(oldQuote); from >= 0;) {
      quoteOffsets.push(from);
      from = baseText.indexOf(oldQuote, from + oldQuote.length);
    }
    const deletedOffset = baseText.indexOf("已经删除");
    const groups: AnnotationGroup[] = [
      {
        id: "g-three-anchors",
        summary: "三连方面",
        note: "同一短语有三处命中",
        origin: "deai",
        status: "reviewing",
        anchors: quoteOffsets.map((offset) =>
          anchor("rewrite-block", offset + 1, offset + 1 + oldQuote.length, oldQuote)
        ),
      },
      {
        id: "g-really-gone",
        summary: "真实消失",
        note: "终稿中已不存在",
        origin: "deai",
        status: "reviewing",
        anchors: [anchor(
          "rewrite-block",
          deletedOffset + 1,
          deletedOffset + 1 + "已经删除".length,
          "已经删除",
        )],
      },
    ];
    const wholeBlockReplace: PmStep = {
      stepType: "replace",
      from: 0,
      to: baseText.length + 2,
      slice: { content: [finalDoc.content[0]!], openStart: 0, openEnd: 0 },
    };

    const mapped = mapAnnotationGroupsThroughSteps(
      groups,
      [wholeBlockReplace],
      finalDoc,
    );
    const finalOffsets: number[] = [];
    for (let from = finalText.indexOf(newQuote); from >= 0;) {
      finalOffsets.push(from);
      from = finalText.indexOf(newQuote, from + newQuote.length);
    }

    expect(mapped.groups).toEqual([
      expect.objectContaining({
        id: "g-three-anchors",
        anchors: finalOffsets.map((offset) =>
          expect.objectContaining({
            blockId: "rewrite-block",
            pmFrom: offset + 1,
            pmTo: offset + 1 + newQuote.length,
            quote: newQuote,
          })
        ),
      }),
    ]);
    expect(mapped.survivingAnchorIndexes.get("g-three-anchors")).toEqual([0, 1, 2]);
    expect(mapped.invalidatedAnchorIndexes.has("g-three-anchors")).toBe(false);
    expect(mapped.invalidatedAnchorIndexes.get("g-really-gone")).toEqual([0]);
    expect(mapped.unlocatedGroupCount).toBe(1);
  });

  it("单锚组全丢时给出诚实的未定位计数", () => {
    const groups: AnnotationGroup[] = [{
      id: "g-only",
      summary: "唯一锚点",
      note: "说明",
      origin: "consistency",
      status: "reviewing",
      anchors: [anchor("p", 1, 3, "甲组")],
    }];
    const step: PmStep = {
      stepType: "replace",
      from: 2,
      to: 2,
      slice: { content: [{ type: "text", text: "新" }], openStart: 0, openEnd: 0 },
    };
    const finalDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{ type: "paragraph" as const, attrs: { blockId: "p" }, content: [{ type: "text" as const, text: "甲新组" }] }],
    };

    const mapped = mapAnnotationGroupsThroughSteps(groups, [step], finalDoc);
    expect(mapped.groups).toEqual([]);
    expect(mapped.invalidatedAnchorIndexes.get("g-only")).toEqual([0]);
    expect(mapped.invalidatedAnchorCount).toBe(1);
    expect(mapped.unlocatedGroupCount).toBe(1);
  });

  it("块级尾部插入不伪造位置 0 step，前文批注坐标零平移且引句命中", () => {
    const baseDoc = doc([
      paragraph("annotated", "未改批注区"),
      paragraph("tail", "保留尾段"),
    ]);
    const finalDoc = doc([
      paragraph("annotated", "未改批注区"),
      paragraph("tail", "保留尾段"),
      paragraph("inserted", "新增块"),
    ]);
    const groups: AnnotationGroup[] = [{
      id: "g-block-insert",
      summary: "未改区批注",
      note: "坐标不应移动",
      origin: "role-review",
      status: "reviewing",
      anchors: [anchor("annotated", 1, 6, "未改批注区")],
    }];

    const steps = buildAnnotationMappingSteps(baseDoc, finalDoc);
    expect(steps).toEqual([
      expect.objectContaining({ stepType: "replace", from: 13, to: 13 }),
    ]);
    expect(mapAnnotationGroupsThroughSteps(groups, steps, finalDoc).groups).toEqual(groups);
  });

  it("等长整块替换使用顶层块区间，后文批注坐标零平移且引句命中", () => {
    const baseDoc = doc([
      codeBlock("code", "旧块"),
      paragraph("annotated", "未改批注区"),
    ]);
    const finalDoc = doc([
      codeBlock("code", "新块"),
      paragraph("annotated", "未改批注区"),
    ]);
    const groups: AnnotationGroup[] = [{
      id: "g-block-replace",
      summary: "未改区批注",
      note: "块包装大小不能造成漂移",
      origin: "role-review",
      status: "reviewing",
      anchors: [anchor("annotated", 5, 10, "未改批注区")],
    }];

    const steps = buildAnnotationMappingSteps(baseDoc, finalDoc);
    expect(steps).toEqual([
      expect.objectContaining({ stepType: "replace", from: 0, to: 4 }),
    ]);
    expect(mapAnnotationGroupsThroughSteps(groups, steps, finalDoc).groups).toEqual(groups);
  });

  it("仅 blockId 变化仍生成迁移 step，并把批注锚点迁到新块身份", () => {
    const baseDoc = doc([{
      type: "callout",
      attrs: { blockId: "block-old", emoji: "!", tone: "info" },
      content: [paragraph("block-old-p", "唯一批注原句") as Extract<PmBlockNode, { type: "paragraph" }>],
    }]);
    const finalDoc = doc([{
      type: "callout",
      attrs: { blockId: "block-new", emoji: "!", tone: "info" },
      content: [paragraph("block-new-p", "唯一批注原句") as Extract<PmBlockNode, { type: "paragraph" }>],
    }]);
    const groups: AnnotationGroup[] = [{
      id: "g-identity-migration",
      summary: "块身份迁移",
      note: "正文不变也要更新锚点块身份",
      origin: "role-review",
      status: "reviewing",
      anchors: [anchor("block-old-p", 2, 8, "唯一批注原句")],
    }];

    const steps = buildAnnotationMappingSteps(baseDoc, finalDoc);
    const mapped = mapAnnotationGroupsThroughSteps(groups, steps, finalDoc);

    expect(steps).toHaveLength(1);
    expect(mapped.groups[0]?.anchors[0]).toMatchObject({
      blockId: "block-new-p",
      quote: "唯一批注原句",
    });
  });

  it("脏 step 兜底校验保留含 hardBreak 与 inlineMath 的未改批注", () => {
    const finalDoc = doc([{
      type: "paragraph",
      attrs: { blockId: "rich-inline" },
      content: [
        { type: "text", text: "甲" },
        { type: "hardBreak" },
        { type: "inlineMath", attrs: { latex: "x^2" } },
        { type: "text", text: "乙" },
      ],
    }]);
    const block = collectTopLevelTextBlocks(finalDoc)[0]!;
    expect(block.text).toBe("甲\n￼乙");
    const groups: AnnotationGroup[] = [{
      id: "g-rich-inline",
      summary: "富文本批注",
      note: "原文未改",
      origin: "role-review",
      status: "reviewing",
      anchors: [anchor(
        "rich-inline",
        block.textStart,
        block.textEnd,
        block.text,
      )],
    }];
    const dirtyStep: PmStep = { stepType: "annotationMappingUnknown" };

    const mapped = mapAnnotationGroupsThroughSteps(
      groups,
      [dirtyStep],
      finalDoc,
    );

    expect(mapped.groups).toEqual(groups);
    expect(mapped.invalidatedAnchorIndexes.size).toBe(0);
    expect(mapped.unlocatedGroupCount).toBe(0);
  });

  it("打码锚点只靠结构 span 定位，未触碰时存活、触碰后失效", () => {
    const raw = "13912345678";
    const group: AnnotationGroup = {
      id: "privacy-masked-anchor",
      summary: "手机号未脱敏",
      note: "需要打码",
      origin: "privacy",
      suggestion: "改为 139****5678",
      status: "reviewing",
      anchors: [{
        blockId: "contact",
        pmFrom: 3,
        pmTo: 14,
        quote: "139****5678",
        textHash: "span:contact:3:14",
      }],
    };

    const unchanged = mapAnnotationGroupsThroughSteps(
      [group],
      [{ stepType: "annotationMappingUnknown" }],
      doc([paragraph("contact", `前缀${raw}后缀`)]),
    );
    expect(unchanged.groups).toEqual([group]);

    const changed = mapAnnotationGroupsThroughSteps(
      [group],
      [{
        stepType: "replace",
        from: 6,
        to: 10,
        slice: { content: [{ type: "text", text: "0000" }], openStart: 0, openEnd: 0 },
      }],
      doc([paragraph("contact", "前缀13900005678后缀")]),
    );
    expect(changed.groups).toEqual([]);
    expect(changed.unlocatedGroupCount).toBe(1);
  });
});

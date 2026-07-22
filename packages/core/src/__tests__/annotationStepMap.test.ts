import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationGroup, PmStep } from "@qingagent/contract-ts";
import {
  buildAnnotationMappingNotice,
  mapAnnotationGroupsThroughSteps,
} from "../doc-engine/annotationMapping.js";
import { getDocumentsClient, insertAnnotationGroups, persistMappedAnnotationGroups } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";

const anchor = (blockId: string, pmFrom: number, pmTo: number, quote: string) => ({
  blockId, pmFrom, pmTo, quote, textHash: `hash-${quote}`,
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

  it("单锚组全丢时给出诚实计数与显式未定位提示", () => {
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
    expect(mapped.unlocatedGroupCount).toBe(1);
    expect(buildAnnotationMappingNotice(mapped.groups.length, mapped.unlocatedGroupCount))
      .toBe("批注落地结果：0处已定位；1处因文档已改动未能定位。");
  });
});

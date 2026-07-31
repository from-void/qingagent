import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationGroup } from "@qingagent/contract-ts";
import { getDocumentsClient } from "../documentsClient.js";
import {
  ignoreAnnotationGroups,
  insertAnnotationGroups,
  persistMappedAnnotationGroups,
  replaceAnnotationGroupsByOrigin,
} from "../documentSuggestionsRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

describe("annotation cleanup op", () => {
  let db: TempDocumentsDb;
  beforeEach(() => { db = prepareTempDocumentsDb("qa-annotation-cleanup-"); });
  afterEach(() => db.cleanup());

  for (const reason of ["tab_changed", "message_sent", "doc_committed"] as const) {
    it(`${reason} 幂等清理后 DB 无 open 组`, async () => {
      const group: AnnotationGroup = { id: `g-${reason}`, summary: "问题", note: "说明", origin: "test", status: "reviewing", anchors: [
        { blockId: "p", pmFrom: 1, pmTo: 2, quote: "字", textHash: "hash" },
      ] };
      await insertAnnotationGroups(`doc-${reason}`, 1, [group]);
      await ignoreAnnotationGroups(`doc-${reason}`);
      await ignoreAnnotationGroups(`doc-${reason}`);
      const result = await getDocumentsClient().execute({
        sql: "SELECT COUNT(*) AS n FROM document_suggestions WHERE doc_id=? AND kind='annotation' AND status='reviewing'",
        args: [`doc-${reason}`],
      });
      expect(Number(result.rows[0]?.n)).toBe(0);
    });
  }

  it("按 origin 换代只关闭同来源旧组", async () => {
    const makeGroup = (id: string, origin: string): AnnotationGroup => ({
      id,
      origin,
      summary: id,
      note: "说明",
      severity: id.includes("consistency") ? "error" : undefined,
      status: "reviewing",
      anchors: [{ blockId: "p", pmFrom: 1, pmTo: 2, quote: "字", textHash: `${id}-hash` }],
    });
    await insertAnnotationGroups("doc-origins", 1, [
      makeGroup("source-old", "source-check"),
      makeGroup("consistency-old", "consistency"),
    ]);
    await replaceAnnotationGroupsByOrigin("doc-origins", 2, [makeGroup("source-new", "source-check")]);

    const result = await getDocumentsClient().execute(
      "SELECT group_id,status,severity FROM document_suggestions WHERE doc_id='doc-origins' ORDER BY group_id",
    );
    expect(result.rows).toMatchObject([
      { group_id: "consistency-old", status: "reviewing", severity: "error" },
      { group_id: "source-new", status: "reviewing", severity: null },
      { group_id: "source-old", status: "ignored", severity: null },
    ]);
  });

  it("隐私批注在入库边界打码全部展示字段和锚点副本，后续映射不会写回原值", async () => {
    const group: AnnotationGroup = {
      id: "privacy-group",
      origin: "privacy",
      summary: "手机号 13912345678 未脱敏",
      note: "「13912345678」是手机号，邮箱 zhangwei@example.com 也会泄露。",
      suggestion: "改为 139****5678，并将 zhangwei@example.com 局部打码。",
      status: "reviewing",
      anchors: [{
        blockId: "p-contact",
        pmFrom: 8,
        pmTo: 19,
        quote: "13912345678",
        textHash: "ba6c167e885ea4be8252fb01",
      }],
    };

    await insertAnnotationGroups("doc-privacy", 1, [group]);
    await persistMappedAnnotationGroups(
      "doc-privacy",
      [group],
      new Map([[group.id, [0]]]),
    );

    const row = (await getDocumentsClient().execute({
      sql: `SELECT summary,note,anchor_json,group_meta_json
        FROM document_suggestions WHERE doc_id=? AND group_id=?`,
      args: ["doc-privacy", group.id],
    })).rows[0]!;
    expect(row.summary).toBe("手机号 139****5678 未脱敏");
    expect(row.note).toBe("「139****5678」是手机号，邮箱 zha***@example.com 也会泄露。");
    expect(JSON.parse(String(row.anchor_json))).toMatchObject({
      quote: "139****5678",
      pmFrom: 8,
      pmTo: 19,
      textHash: "span:p-contact:8:19",
    });
    expect(JSON.parse(String(row.group_meta_json))).toMatchObject({
      summary: "手机号 139****5678 未脱敏",
      suggestion: "改为 139****5678，并将 zha***@example.com 局部打码。",
    });
    expect(JSON.stringify(row)).not.toContain("13912345678");
    expect(JSON.stringify(row)).not.toContain("zhangwei@example.com");
  });
});

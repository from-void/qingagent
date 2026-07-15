import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { insertReviewDismissalSignal } from "../reviewDismissalSignalRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-review-dismissal-"); });
afterEach(() => db.cleanup());

describe("reviewDismissalSignalRepo", () => {
  it("只落库 docId、origin、summary、引句和时间，不参与消费", async () => {
    await runMigrations();
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO documents(
      id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
    ) VALUES('doc-signal','thread-signal','qingagent-user','信号','editing','now','now','main')`);

    const saved = await insertReviewDismissalSignal({
      docId: "doc-signal",
      origin: "自定义审查:老板视角挑刺",
      summary: "行动建议空泛",
      quote: "尽快推动项目落地",
    }, undefined, "2026-07-14T12:00:00.000Z");
    const row = (await client.execute("SELECT doc_id,origin,summary,quote,ts FROM review_dismissal_signals")).rows[0];
    expect(row).toMatchObject({
      doc_id: saved.docId,
      origin: saved.origin,
      summary: saved.summary,
      quote: saved.quote,
      ts: saved.ts,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDerivativeDoc, deleteDerivativeDoc, getDerivativeDocument, getDerivativeMeta, listDerivativesByThread, stampGenerated, updateParams } from "../documentDerivativesRepo.js";
import { getDocumentsClient } from "../documentsClient.js";
import { documentRepo } from "../documentRepo.js";
import { prepareTempDocumentsDb, documentInput, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-derivative-repo-"); });
afterEach(() => db.cleanup());

describe("documentDerivativesRepo", () => {
  it("删除校验会话归属，并级联清理关联行和版本", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "" });
    const client = getDocumentsClient();
    const doc = await getDerivativeDocument(meta.docId);
    await client.execute({
      sql: `INSERT INTO document_versions (version_id, doc_id, doc_version, content_hash, schema_version, actor_type, summary, snapshot_pm, parent_version, created_at)
        VALUES ('deriv-v1', ?, 1, 'hash', 1, 'agent', '生成', ?, NULL, ?)`,
      args: [meta.docId, doc!.docPm, new Date().toISOString()],
    });
    expect(await deleteDerivativeDoc("other-thread", meta.docId)).toBe(false);
    expect(await getDerivativeMeta(meta.docId)).not.toBeNull();
    expect(await deleteDerivativeDoc("thread", meta.docId)).toBe(true);
    expect(await getDerivativeMeta(meta.docId)).toBeNull();
    const counts = await Promise.all(["documents", "document_derivatives", "document_versions"].map(async (table) => {
      const result = await client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "documents" ? "id" : "doc_id"} = ?`, args: [meta.docId] });
      return Number(result.rows[0]?.n ?? 0);
    }));
    expect(counts).toEqual([0, 0, 0]);
  });

  it("创建、每类复用、盖章及源版本上涨后 stale", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const first = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "克制" });
    const second = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-tutorial", privatePrompt: "" });
    expect(second.docId).toBe(first.docId);
    await stampGenerated(first.docId, 1);
    expect((await listDerivativesByThread("thread"))[0]?.stale).toBe(false);
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 2 }));
    expect((await listDerivativesByThread("thread"))[0]?.stale).toBe(true);
  });

  it("封面选择按稿件持久化，重新生成参数更新不重置", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "xhs", templateId: "xhs-recommend", privatePrompt: "" });
    expect(meta.coverTemplate).toBe("poster");
    await updateParams(meta.docId, meta.writingStyleId, meta.privatePrompt, meta.layoutStyleId, "wenkai");
    expect((await getDerivativeMeta(meta.docId))?.coverTemplate).toBe("wenkai");
    await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "xhs", templateId: "xhs-checklist", privatePrompt: "重生成" });
    expect((await getDerivativeMeta(meta.docId))?.coverTemplate).toBe("wenkai");
  });

  it("翻译按目标语言一行，重选同语言复用且可独立删除", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const english = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "translate", templateId: "translate-faithful", targetLang: "英语", privatePrompt: "" });
    const japanese = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "translate", templateId: "translate-native", targetLang: "日语", privatePrompt: "保留产品名" });
    const englishAgain = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "translate", templateId: "translate-business", targetLang: "英语", privatePrompt: "商务" });
    expect(englishAgain.docId).toBe(english.docId);
    expect(japanese.docId).not.toBe(english.docId);
    expect((await listDerivativesByThread("thread")).map((item) => item.targetLang)).toEqual(["英语", "日语"]);
    expect(await deleteDerivativeDoc("thread", english.docId)).toBe(true);
    expect((await listDerivativesByThread("thread")).map((item) => item.targetLang)).toEqual(["日语"]);
  });

  it("get-or-create 对已存在实例刷新模板与私有指令(调整模板后重生成读到新参数)", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const first = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "克制" });
    const second = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-tutorial", privatePrompt: "更短" });
    expect(second.docId).toBe(first.docId);
    expect(second.templateId).toBe("gzh-tutorial");
    expect(second.privatePrompt).toBe("更短");
    const persisted = await getDerivativeMeta(first.docId);
    expect(persisted?.templateId).toBe("gzh-tutorial");
    expect(persisted?.privatePrompt).toBe("更短");
  });

});

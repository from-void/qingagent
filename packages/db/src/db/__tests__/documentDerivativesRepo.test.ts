import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDerivativeDoc, deleteDerivativeDoc, getDerivativeDocument, getDerivativeMeta, listDerivativesByThread, stampGenerated, updateParams } from "../documentDerivativesRepo.js";
import { getDocumentsClient } from "../documentsClient.js";
import { documentRepo } from "../documentRepo.js";
import { beginSessionDeletion } from "../sessionDeletionRepo.js";
import { DocumentWriteBlockedError } from "../documentWriteGuard.js";
import { prepareTempDocumentsDb, documentInput, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-derivative-repo-"); });
afterEach(() => db.cleanup());

describe("documentDerivativesRepo", () => {
  it("持久化墓碑阻止绕过 documentRepo 的 derivative documents INSERT", async () => {
    await documentRepo.save(documentInput("main-fenced", {
      threadId: "thread-fenced",
      docVersion: 1,
    }));
    await beginSessionDeletion("thread-fenced");

    await expect(createDerivativeDoc({
      threadId: "thread-fenced",
      sourceDocId: "main-fenced",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "",
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    expect(await listDerivativesByThread("thread-fenced")).toEqual([]);
  });

  it("F4: 衍生稿读取向下游返回宽容归一化后的历史表格 PM", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "" });
    const legacyBrokenTable = {
      type: "doc", attrs: { schemaVersion: 1 }, content: [{
        type: "table", attrs: { blockId: "legacy-table" }, content: [
          { type: "tableRow", content: [
            { type: "tableCell", attrs: { rowspan: 3, backgroundColor: null }, content: [{ type: "paragraph", attrs: { blockId: "a" }, content: [{ type: "text", text: "旧表格" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "b" } }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "c" } }] },
          ] },
        ],
      }],
    };
    await getDocumentsClient().execute({
      sql: "UPDATE documents SET doc_pm = ?, doc_version = 1 WHERE id = ?",
      args: [JSON.stringify(legacyBrokenTable), meta.docId],
    });

    const loaded = await getDerivativeDocument(meta.docId);
    expect(JSON.stringify(loaded?.pmDoc)).not.toContain("backgroundColor");
    expect(JSON.parse(loaded!.docPm)).toEqual(loaded!.pmDoc);
  });

  it("删除校验会话归属，并级联清理关联行和版本", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "" });
    const client = getDocumentsClient();
    const doc = await getDerivativeDocument(meta.docId);
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO document_drafts (
        doc_id, thread_id, base_version, base_hash, draft_pm, status, created_at, updated_at
      ) VALUES (?, 'thread', 0, 'hash', ?, 'pending_review', ?, ?)`,
      args: [meta.docId, doc!.docPm, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_suggestions (
        id, doc_id, base_version, status, anchor_json, steps_json,
        preview_json, summary, created_at, updated_at
      ) VALUES ('deriv-suggestion', ?, 0, 'reviewing', '{}', '[]', '{}', '修改', ?, ?)`,
      args: [meta.docId, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_ops (
        op_id, doc_id, op_kind, steps, from_version, to_version, actor_type, created_at
      ) VALUES ('deriv-op', ?, 'replace_doc', '[]', 0, 1, 'agent', ?)`,
      args: [meta.docId, now],
    });
    await client.execute({
      sql: `INSERT INTO document_versions (version_id, doc_id, doc_version, content_hash, schema_version, actor_type, summary, snapshot_pm, parent_version, created_at)
        VALUES ('deriv-v1', ?, 1, 'hash', 1, 'agent', '生成', ?, NULL, ?)`,
      args: [meta.docId, doc!.docPm, now],
    });
    expect(await deleteDerivativeDoc("other-thread", meta.docId)).toBe(false);
    expect(await getDerivativeMeta(meta.docId)).not.toBeNull();
    expect(await deleteDerivativeDoc("thread", meta.docId)).toBe(true);
    expect(await getDerivativeMeta(meta.docId)).toBeNull();
    const counts = await Promise.all(["documents", "document_derivatives", "document_drafts", "document_suggestions", "document_ops", "document_versions"].map(async (table) => {
      const result = await client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "documents" ? "id" : "doc_id"} = ?`, args: [meta.docId] });
      return Number(result.rows[0]?.n ?? 0);
    }));
    expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("创建、每类复用、盖章及源版本上涨后 stale", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const first = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-opinion", privatePrompt: "克制" });
    const second = await createDerivativeDoc({ threadId: "thread", sourceDocId: "main", dtype: "gzh", templateId: "gzh-tutorial", privatePrompt: "" });
    expect(second.docId).toBe(first.docId);
    await stampGenerated(first.docId, 1);
    expect((await listDerivativesByThread("thread"))[0]).toMatchObject({ stale: false, currentSourceVersion: 1 });
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 2 }));
    expect((await listDerivativesByThread("thread"))[0]).toMatchObject({ stale: true, currentSourceVersion: 2 });
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

  it("参数更新拒绝与衍生稿 dtype 不一致的写作和排版模板", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "translate",
      templateId: "translate-faithful",
      targetLang: "英语",
      privatePrompt: "",
    });

    await expect(updateParams(
      meta.docId,
      "gzh-opinion",
      "不应写入",
      null,
    )).rejects.toThrow("未知的写作风格模板");
    await expect(updateParams(
      meta.docId,
      meta.writingStyleId,
      "不应写入",
      "gzh-layout-classic",
    )).rejects.toThrow("未知的排版风格模板");

    expect(await getDerivativeMeta(meta.docId)).toMatchObject({
      dtype: "translate",
      writingStyleId: meta.writingStyleId,
      layoutStyleId: meta.layoutStyleId,
      privatePrompt: "",
    });
  });

  it("参数更新拒绝不存在的排版模板且保留原参数", async () => {
    await documentRepo.save(documentInput("main", { threadId: "thread", docVersion: 1 }));
    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "原指令",
    });

    await expect(updateParams(
      meta.docId,
      "gzh-tutorial",
      "不应写入",
      "missing-layout",
    )).rejects.toThrow("未知的排版风格模板");

    expect(await getDerivativeMeta(meta.docId)).toMatchObject({
      writingStyleId: meta.writingStyleId,
      layoutStyleId: meta.layoutStyleId,
      privatePrompt: "原指令",
    });
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

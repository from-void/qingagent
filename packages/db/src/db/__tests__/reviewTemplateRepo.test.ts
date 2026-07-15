import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import {
  deleteReviewTemplate,
  getReviewDocSupplement,
  getSelectedReviewTemplate,
  listReviewTemplates,
  saveReviewTemplate,
  selectReviewTemplate,
  upsertReviewDocSupplement,
} from "../reviewTemplateRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-review-template-repo-"); });
afterEach(() => db.cleanup());

describe("reviewTemplateRepo", () => {
  it("内置模板可删、每类保底一个，删除选中项后回退到剩余首项", async () => {
    const builtins = await listReviewTemplates("source");
    expect(builtins).toHaveLength(1);
    await expect(deleteReviewTemplate(builtins[0]!.id)).rejects.toThrow("每类至少保留一个模板");
    const downgraded = await saveReviewTemplate({ ...builtins[0]!, prompt: "覆盖" });
    expect(downgraded).toMatchObject({ id: builtins[0]!.id, prompt: "覆盖", builtin: false });

    const created = await saveReviewTemplate({ type: "source", name: "我的来源核查", prompt: "核对所有金额" });
    await selectReviewTemplate("source", builtins[0]!.id);
    expect(await deleteReviewTemplate(builtins[0]!.id)).toBe(true);
    expect((await getSelectedReviewTemplate("source"))?.id).toBe(created.id);
    await expect(deleteReviewTemplate(created.id)).rejects.toThrow("每类至少保留一个模板");

    const backup = await saveReviewTemplate({ type: "source", name: "备用来源核查", prompt: "核对所有日期" });
    await selectReviewTemplate("source", created.id);
    const changed = await saveReviewTemplate({ ...created, name: "严格来源核查", prompt: "金额逐字核对" });
    expect(changed.name).toBe("严格来源核查");
    expect(await deleteReviewTemplate(created.id)).toBe(true);
    expect((await getSelectedReviewTemplate("source"))?.id).toBe(backup.id);
  });

  it("按 docId 与审查类型隔离补充提示词并可清空", async () => {
    await listReviewTemplates("sensitive");
    const client = getDocumentsClient();
    const now = "2026-07-14T00:00:00.000Z";
    await client.execute({
      sql: `INSERT INTO documents(id,thread_id,resource_id,title,doc_state,created_at,updated_at,role)
        VALUES('doc-a','thread-a','qingagent-user','A','editing',?,?,'main'),
          ('doc-b','thread-b','qingagent-user','B','editing',?,?,'main')`,
      args: [now, now, now, now],
    });
    await upsertReviewDocSupplement("doc-a", "sensitive", "引用只标记");
    await upsertReviewDocSupplement("doc-a", "source", "重点核对金额");
    expect(await getReviewDocSupplement("doc-a", "sensitive")).toBe("引用只标记");
    expect(await getReviewDocSupplement("doc-a", "source")).toBe("重点核对金额");
    expect(await getReviewDocSupplement("doc-b", "sensitive")).toBe("");
    await upsertReviewDocSupplement("doc-a", "sensitive", "");
    expect(await getReviewDocSupplement("doc-a", "sensitive")).toBe("");
  });

  it("并发删除同类最后两个模板时仍原子保底一个", async () => {
    const builtin = (await listReviewTemplates("source"))[0]!;
    const user = await saveReviewTemplate({ type: "source", name: "并发备用", prompt: "备用规则" });
    const results = await Promise.allSettled([
      deleteReviewTemplate(builtin.id),
      deleteReviewTemplate(user.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listReviewTemplates("source")).toHaveLength(1);
  });
});

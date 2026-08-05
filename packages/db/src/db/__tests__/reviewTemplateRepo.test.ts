import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import {
  deleteReviewTemplate,
  getReviewDocSupplement,
  getReviewTemplate,
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
  it("内置模板只读，自定义模板可改删且删除选中项后回退内置项", async () => {
    const builtins = await listReviewTemplates("source");
    expect(builtins).toHaveLength(1);
    await expect(deleteReviewTemplate(builtins[0]!.id)).rejects.toThrow("内置审查模板不能删除");
    await expect(
      saveReviewTemplate({ ...builtins[0]!, prompt: "覆盖" }),
    ).rejects.toThrow("内置审查模板不能修改");

    const created = await saveReviewTemplate({ type: "source", name: "我的来源核查", prompt: "核对所有金额" });
    await selectReviewTemplate("source", created.id);
    const changed = await saveReviewTemplate({ ...created, name: "严格来源核查", prompt: "金额逐字核对" });
    expect(changed.name).toBe("严格来源核查");
    expect(await deleteReviewTemplate(created.id)).toBe(true);
    expect((await getSelectedReviewTemplate("source"))?.id).toBe(builtins[0]!.id);
  });

  it("expectedUpdatedAt 在仓储层执行原子乐观锁", async () => {
    const created = await saveReviewTemplate({
      type: "custom",
      name: "乐观锁模板",
      prompt: "第一版",
    });
    const changed = await saveReviewTemplate({
      ...created,
      prompt: "第二版",
      expectedUpdatedAt: created.updatedAt,
    });
    expect(changed.prompt).toBe("第二版");
    await expect(saveReviewTemplate({
      ...created,
      prompt: "过期写入",
      expectedUpdatedAt: created.updatedAt,
    })).rejects.toThrow("审查模板已被修改");
    expect((await getReviewTemplate(created.id))?.prompt).toBe("第二版");
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

  it("同文档同类型按自定义模板隔离补充要求，且老记录可作为兼容基线读取", async () => {
    await listReviewTemplates("custom");
    const client = getDocumentsClient();
    const now = "2026-08-06T00:00:00.000Z";
    await client.execute({
      sql: `INSERT INTO documents(id,thread_id,resource_id,title,doc_state,created_at,updated_at,role)
        VALUES('doc-custom-scopes','thread-custom-scopes','qingagent-user','模板隔离','editing',?,?,'main')`,
      args: [now, now],
    });
    await upsertReviewDocSupplement("doc-custom-scopes", "custom", "老 custom 补充");
    expect(await getReviewDocSupplement("doc-custom-scopes", "custom", "review-custom-x"))
      .toBe("老 custom 补充");
    expect(await getReviewDocSupplement("doc-custom-scopes", "custom", "review-custom-y"))
      .toBe("老 custom 补充");

    await upsertReviewDocSupplement("doc-custom-scopes", "custom", "只属于模板 X", "review-custom-x");
    await upsertReviewDocSupplement("doc-custom-scopes", "custom", "只属于模板 Y", "review-custom-y");
    expect(await getReviewDocSupplement("doc-custom-scopes", "custom", "review-custom-x"))
      .toBe("只属于模板 X");
    expect(await getReviewDocSupplement("doc-custom-scopes", "custom", "review-custom-y"))
      .toBe("只属于模板 Y");
    expect(await getReviewDocSupplement("doc-custom-scopes", "custom"))
      .toBe("老 custom 补充");

    const legacyLine = "- 已确认无需处理，不再标记：「老决定」(2026-08-01)";
    await upsertReviewDocSupplement(
      "doc-custom-scopes",
      "custom",
      `老 custom 补充\n\n## 已确认忽略\n${legacyLine}`,
    );
    const scopedWithLegacyDecision = await getReviewDocSupplement(
      "doc-custom-scopes",
      "custom",
      "review-custom-x",
    );
    expect(scopedWithLegacyDecision).toContain("只属于模板 X");
    expect(scopedWithLegacyDecision).toContain(legacyLine);
    expect(scopedWithLegacyDecision).not.toContain("老 custom 补充");
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

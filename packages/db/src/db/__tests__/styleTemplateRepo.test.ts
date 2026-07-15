import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteStyleTemplate, getStyleTemplate, listStyleTemplates, saveStyleTemplate } from "../styleTemplateRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-style-repo-"); });
afterEach(() => db.cleanup());

describe("styleTemplateRepo CRUD", () => {
  it("内置模板可删，同 dtype+slot 每类保底一个", async () => {
    expect(await listStyleTemplates({ dtype: "gzh", slot: "layout" })).toHaveLength(2);
    expect(await deleteStyleTemplate("gzh-layout-classic")).toBe(true);
    await expect(deleteStyleTemplate("gzh-layout-minimal")).rejects.toThrow("每类至少保留一个模板");

    const made = await saveStyleTemplate({ dtype: "gzh", slot: "layout", name: "我的排版", prompt: "规则" });
    expect((await getStyleTemplate(made.id))?.builtin).toBe(false);
    expect(made.detail).toBe("");
    const changed = await saveStyleTemplate({ ...made, name: "改名", prompt: "新规则" });
    expect(changed.name).toBe("改名");
    expect(await deleteStyleTemplate(made.id)).toBe(true);
  });

  it("编辑 builtin 后转用户版语义", async () => {
    const old = await getStyleTemplate("gzh-tutorial");
    const changed = await saveStyleTemplate({
      id: old!.id,
      dtype: old!.dtype,
      slot: old!.slot,
      name: old!.name,
      prompt: "自定义",
    });
    expect(changed.builtin).toBe(false);
    expect(changed.detail).toBe(old!.detail);
    expect(await deleteStyleTemplate(changed.id)).toBe(true);
  });

  it("并发删除同组最后两个模板时仍原子保底一个", async () => {
    const results = await Promise.allSettled([
      deleteStyleTemplate("gzh-layout-classic"),
      deleteStyleTemplate("gzh-layout-minimal"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listStyleTemplates({ dtype: "gzh", slot: "layout" })).toHaveLength(1);
  });
});

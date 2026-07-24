import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteStyleTemplate, getStyleTemplate, listStyleTemplates, saveStyleTemplate } from "../styleTemplateRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-style-repo-"); });
afterEach(() => db.cleanup());

describe("styleTemplateRepo CRUD", () => {
  it("内置模板拒删，用户模板可正常删除", async () => {
    expect(await listStyleTemplates({ dtype: "gzh", slot: "layout" })).toHaveLength(2);
    await expect(deleteStyleTemplate("gzh-layout-classic")).rejects.toThrow("内置模板不可删除");
    expect(await getStyleTemplate("gzh-layout-classic")).not.toBeNull();

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
    const first = await saveStyleTemplate({ dtype: "xhs", slot: "layout", name: "排版一", prompt: "规则一" });
    const second = await saveStyleTemplate({ dtype: "xhs", slot: "layout", name: "排版二", prompt: "规则二" });
    const results = await Promise.allSettled([
      deleteStyleTemplate(first.id),
      deleteStyleTemplate(second.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listStyleTemplates({ dtype: "xhs", slot: "layout" })).toHaveLength(1);
  });

  it("dtype 只接受现有枚举，all 与省略 dtype 都返回全量", async () => {
    const all = await listStyleTemplates();
    expect(await listStyleTemplates({ dtype: "all" })).toEqual(all);
    expect(new Set(all.map((item) => item.dtype))).toEqual(new Set(["deai", "gzh", "translate", "xhs"]));
    await expect(listStyleTemplates({ dtype: "writing" })).rejects.toThrow("未知的风格模板 dtype");
    await expect(saveStyleTemplate({ dtype: "三段式", slot: "writing", name: "孤儿", prompt: "规则" })).rejects.toThrow("未知的风格模板 dtype");
  });
});

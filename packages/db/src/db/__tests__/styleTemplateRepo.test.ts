import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDerivativeDoc,
  deleteDerivativeDoc,
  listDerivativesByThread,
} from "../documentDerivativesRepo.js";
import { documentRepo } from "../documentRepo.js";
import { deleteStyleTemplate, getStyleTemplate, listStyleTemplates, saveStyleTemplate } from "../styleTemplateRepo.js";
import { documentInput, prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

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

  it("拒绝删除衍生稿仍在使用的写作或排版模板，并报告引用稿件数", async () => {
    const writing = await saveStyleTemplate({
      dtype: "gzh",
      slot: "writing",
      name: "在用写法",
      prompt: "写作规则",
    });
    const layout = await saveStyleTemplate({
      dtype: "gzh",
      slot: "layout",
      name: "在用排版",
      prompt: "排版规则",
    });
    await documentRepo.save(documentInput("main", {
      threadId: "thread",
      docVersion: 1,
    }));
    const derivative = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      writingStyleId: writing.id,
      layoutStyleId: layout.id,
      privatePrompt: "",
    });

    await expect(deleteStyleTemplate(writing.id)).rejects.toThrow(
      "仍有 1 篇稿件使用该模板，无法删除",
    );
    await expect(deleteStyleTemplate(layout.id)).rejects.toThrow(
      "仍有 1 篇稿件使用该模板，无法删除",
    );
    expect(await getStyleTemplate(writing.id)).not.toBeNull();
    expect(await getStyleTemplate(layout.id)).not.toBeNull();

    await deleteDerivativeDoc("thread", derivative.docId);
    await expect(deleteStyleTemplate(writing.id)).resolves.toBe(true);
    await expect(deleteStyleTemplate(layout.id)).resolves.toBe(true);
  });

  it("并发创建衍生稿与删除模板不会留下悬空引用", async () => {
    const writing = await saveStyleTemplate({
      dtype: "xhs",
      slot: "writing",
      name: "竞态写法",
      prompt: "写作规则",
    });
    await documentRepo.save(documentInput("race-main", {
      threadId: "race-thread",
      docVersion: 1,
    }));

    const [creation, deletion] = await Promise.allSettled([
      createDerivativeDoc({
        threadId: "race-thread",
        sourceDocId: "race-main",
        dtype: "xhs",
        writingStyleId: writing.id,
        privatePrompt: "",
      }),
      deleteStyleTemplate(writing.id),
    ]);

    const persistedTemplate = await getStyleTemplate(writing.id);
    const derivatives = await listDerivativesByThread("race-thread");
    if (creation.status === "fulfilled") {
      expect(deletion.status).toBe("rejected");
      expect(persistedTemplate).not.toBeNull();
      expect(derivatives).toHaveLength(1);
    } else {
      expect(deletion).toEqual({ status: "fulfilled", value: true });
      expect(persistedTemplate).toBeNull();
      expect(derivatives).toEqual([]);
    }
  });

  it("dtype 只接受现有枚举，all 与省略 dtype 都返回全量", async () => {
    const all = await listStyleTemplates();
    expect(await listStyleTemplates({ dtype: "all" })).toEqual(all);
    expect(new Set(all.map((item) => item.dtype))).toEqual(new Set(["deai", "gzh", "translate", "xhs"]));
    await expect(listStyleTemplates({ dtype: "writing" })).rejects.toThrow("未知的风格模板 dtype");
    await expect(saveStyleTemplate({ dtype: "三段式", slot: "writing", name: "孤儿", prompt: "规则" })).rejects.toThrow("未知的风格模板 dtype");
  });
});

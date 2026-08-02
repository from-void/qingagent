import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
  getTxnClient,
  rollbackTransaction,
  withTransaction,
} from "../documentsClient.js";
import { ensureMigrated } from "../migrations.js";
import { addLexiconEntries, createLexicon, deleteLexiconResource, listLexiconEntries, listLexicons, removeLexiconEntries, setEnabledLexicons, updateLexiconEntries } from "../lexiconRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-lexicon-"); });
afterEach(() => {
  vi.restoreAllMocks();
  db.cleanup();
});

describe("lexiconRepo", () => {
  it("迁移后存在四份正式词库、来源说明与 30—80 个种子词条", async () => {
    await ensureMigrated();
    const lexicons = await listLexicons(getDocumentsClient());
    expect(lexicons).toHaveLength(4);
    expect(lexicons.map((item) => item.id)).toEqual([
      "lexicon-advertising-superlatives", "lexicon-medical-health-claims",
      "lexicon-official-writing", "lexicon-social-media-marketing",
    ]);
    expect(lexicons.every((item) => item.entryCount >= 30 && item.entryCount <= 80 && item.description.length > 0)).toBe(true);
    expect(lexicons.every((item) => item.enabled)).toBe(true);
  });

  it("持久化启用词库并由列表同源读回，同时保留资源说明", async () => {
    const enabledId = "lexicon-advertising-superlatives";

    await setEnabledLexicons([enabledId]);
    __resetDocumentsClientForTest();

    const lexicons = await listLexicons();
    expect(lexicons.map(({ id, enabled }) => [id, enabled])).toEqual([
      [enabledId, true],
      ["lexicon-medical-health-claims", false],
      ["lexicon-official-writing", false],
      ["lexicon-social-media-marketing", false],
    ]);
    expect(lexicons.every((item) => item.description.length > 0)).toBe(true);
  });

  it("脏资源元数据安全回退为启用，仅明确的 boolean false 关闭", async () => {
    await ensureMigrated();
    const client = getDocumentsClient();
    const cases = [
      ["lexicon-advertising-superlatives", "{not-json", true],
      ["lexicon-medical-health-claims", "[]", true],
      ["lexicon-official-writing", JSON.stringify({ enabled: "false" }), true],
      ["lexicon-social-media-marketing", JSON.stringify({ enabled: false }), false],
    ] as const;
    for (const [id, metaJson] of cases) {
      await client.execute({
        sql: "UPDATE skill_resources SET meta_json = ? WHERE id = ?",
        args: [metaJson, id],
      });
    }

    expect((await listLexicons(client)).map((item) => item.enabled)).toEqual(
      cases.map(([, , enabled]) => enabled),
    );
  });

  it("支持创建、添加、删除并更新 entryCount", async () => {
    const resource = await createLexicon("自定义", getDocumentsClient());
    expect(await addLexiconEntries(resource.id, [
      { word: "测试词", replacement: "规范词" }, { word: "只标记", note: "复核" },
    ], getDocumentsClient())).toBe(2);
    expect((await listLexicons(getDocumentsClient())).find((item) => item.id === resource.id)?.entryCount).toBe(2);
    expect(await listLexiconEntries([resource.id], getDocumentsClient())).toHaveLength(2);
    expect(await removeLexiconEntries(resource.id, ["测试词"], getDocumentsClient())).toBe(1);
    expect((await listLexicons(getDocumentsClient())).find((item) => item.id === resource.id)?.entryCount).toBe(1);
  });

  it("批量导入中途遇到忙锁时整体重试且不产生重复", async () => {
    const resource = await createLexicon("事务重试");
    const transactionClient = getTxnClient();
    const originalExecute = transactionClient.execute.bind(transactionClient);
    let insertAttempts = 0;
    let failedOnce = false;
    vi.spyOn(transactionClient, "execute").mockImplementation(async (statement) => {
      const sql = typeof statement === "string"
        ? statement
        : (statement as unknown as { sql: string }).sql;
      if (/INSERT INTO lexicon_entries/i.test(sql)) {
        insertAttempts += 1;
        if (!failedOnce && insertAttempts === 2) {
          failedOnce = true;
          const error = new Error("SQLITE_BUSY: forced retry");
          Object.assign(error, { code: "SQLITE_BUSY" });
          throw error;
        }
      }
      return originalExecute(statement);
    });

    await expect(addLexiconEntries(resource.id, [
      { word: "第一条" },
      { word: "第二条" },
      { word: "第三条" },
    ])).resolves.toBe(3);

    expect(failedOnce).toBe(true);
    expect(insertAttempts).toBe(5);
    const entries = await listLexiconEntries([resource.id]);
    expect(entries.map((entry) => entry.word).sort()).toEqual(["第一条", "第三条", "第二条"].sort());
  });

  it("重复导入同词时幂等更新现有词条", async () => {
    const resource = await createLexicon("幂等导入");
    await addLexiconEntries(resource.id, [
      { word: "重复词", replacement: "旧替换", note: "旧注释" },
    ]);
    await addLexiconEntries(resource.id, [
      { word: "重复词", replacement: "新替换", note: "新注释" },
    ]);

    expect(await listLexiconEntries([resource.id])).toEqual([
      expect.objectContaining({
        word: "重复词",
        replacement: "新替换",
        note: "新注释",
      }),
    ]);
    expect((await listLexicons()).find((item) => item.id === resource.id)?.entryCount).toBe(1);
  });

  it("调用方传入事务 client 时复用现有事务边界", async () => {
    const resource = await createLexicon("外层事务");
    await withTransaction(async (transactionClient) => {
      await addLexiconEntries(resource.id, [{ word: "随外层回滚" }], transactionClient);
      return rollbackTransaction(undefined);
    });

    expect(await listLexiconEntries([resource.id])).toEqual([]);
  });

  it("支持更新词条、删除用户词库并保护种子库",async()=>{const r=await createLexicon("临时");await addLexiconEntries(r.id,[{word:"旧词",replacement:"旧替换"}]);expect(await updateLexiconEntries(r.id,[{word:"旧词",replacement:"新替换",note:"新注释"}])).toBe(1);expect((await listLexiconEntries([r.id]))[0]).toMatchObject({replacement:"新替换",note:"新注释"});await expect(deleteLexiconResource("lexicon-advertising-superlatives")).rejects.toThrow("内置词库不可删除");expect(await deleteLexiconResource(r.id)).toBe(true)});
});

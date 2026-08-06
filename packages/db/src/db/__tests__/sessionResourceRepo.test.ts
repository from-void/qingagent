import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backfillDeletingSessionResources,
  extractSessionResourceIds,
  listSessionResources,
} from "../sessionResourceRepo.js";
import { beginSessionDeletion } from "../sessionDeletionRepo.js";
import { getDocumentsClient } from "../documentsClient.js";
import { ensureMigrated, __resetMigrationsForTest } from "../migrations.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

const FILE_A = "11111111-1111-4111-8111-111111111111";
const FILE_B = "22222222-2222-4222-8222-222222222222";
const UNRELATED_UUID = "33333333-3333-4333-8333-333333333333";

describe("extractSessionResourceIds 脏输入", () => {
  it("提取嵌套 fileId/imageId 与文件路由，并忽略普通正文 UUID", () => {
    expect(extractSessionResourceIds({
      fileId: FILE_A.toUpperCase(),
      nested: [{ imageId: FILE_B }],
      prose: `工单号 ${UNRELATED_UUID}`,
      href: `/api/v1/files/${FILE_A}/原件.pdf?download=1`,
    })).toEqual([FILE_A, FILE_B]);
  });

  it("兼容 JSON 字符串、Uint8Array、转义引号与尾随散文", () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      parts: [{ fileId: FILE_A, label: `他说\"保留\"` }],
    }));
    const trailing = `前导话 {\"imageId\":\"${FILE_B}\"} 收尾 /api/v1/files/${FILE_B}/x.png`;

    expect(extractSessionResourceIds([encoded, trailing])).toEqual([FILE_A, FILE_B]);
  });

  it("截断 JSON、循环对象和孤立 UUID 均保守处理且不抛错", () => {
    const cyclic: Record<string, unknown> = { fileId: FILE_A };
    cyclic.self = cyclic;
    expect(extractSessionResourceIds([
      cyclic,
      `{\"fileId\":\"${FILE_B}\"`,
      UNRELATED_UUID,
    ])).toEqual([FILE_A]);
  });
});

describe("存量会话资源回填", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-session-resource-");
  });

  afterEach(() => {
    __resetMigrationsForTest();
    db.cleanup();
  });

  it("旧删除已只剩 om-sidecar 消息时，仍能在删线程前恢复资源清单", async () => {
    const sessionId = "legacy-deleted-session";
    await ensureMigrated();
    await getDocumentsClient().execute(`CREATE TABLE mastra_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL
    )`);
    await getDocumentsClient().execute({
      sql: "INSERT INTO mastra_messages (id, thread_id, content) VALUES (?, ?, ?)",
      args: [
        "legacy-sidecar-message",
        `om-sidecar:${sessionId}`,
        JSON.stringify({ parts: [{ type: "file", fileId: FILE_A }] }),
      ],
    });
    await beginSessionDeletion(sessionId);

    await expect(backfillDeletingSessionResources(sessionId)).resolves.toBe(1);
    await expect(listSessionResources(sessionId)).resolves.toEqual([
      expect.objectContaining({
        sessionId,
        resourceId: FILE_A,
        kind: "discovered",
      }),
    ]);
  });
});

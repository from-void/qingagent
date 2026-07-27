import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimClientMessageIdempotency,
  CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS,
} from "../clientMessageIdempotencyRepo.js";
import {
  __resetDocumentsClientForTest,
} from "../documentsClient.js";
import {
  __resetMigrationsForTest,
} from "../migrations.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

describe("clientMessageId 首提持久幂等", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-client-message-idempotency-");
  });

  afterEach(() => {
    db.cleanup();
  });

  it("模拟服务重启后克隆首提仍返回原会话与原消息", async () => {
    await expect(claimClientMessageIdempotency({
      id: "client-message-restart",
      sessionId: "session-original",
      messageId: "client-message-restart",
      now: 1_000,
    })).resolves.toMatchObject({
      claimed: true,
      record: {
        sessionId: "session-original",
        messageId: "client-message-restart",
      },
    });

    // 重建数据库连接与迁移单例，等价于新服务进程读取同一 SQLite 文件。
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();

    await expect(claimClientMessageIdempotency({
      id: "client-message-restart",
      sessionId: "session-cloned-after-restart",
      messageId: "client-message-restart",
      now: 2_000,
    })).resolves.toMatchObject({
      claimed: false,
      record: {
        sessionId: "session-original",
        messageId: "client-message-restart",
      },
    });
  });

  it("24 小时后清理旧键并允许新首提", async () => {
    await claimClientMessageIdempotency({
      id: "client-message-expired",
      sessionId: "session-old",
      messageId: "client-message-expired",
      now: 1_000,
    });

    await expect(claimClientMessageIdempotency({
      id: "client-message-expired",
      sessionId: "session-new",
      messageId: "client-message-expired",
      now: 1_000 + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS + 1,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-new" },
    });
  });
});

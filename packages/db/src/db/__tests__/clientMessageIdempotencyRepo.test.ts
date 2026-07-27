import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimClientMessageIdempotency,
  completeClientMessageIdempotency,
  touchClientMessageIdempotency,
  CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS,
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

  it("完成记录超过 24 小时后清理并允许新首提", async () => {
    await claimClientMessageIdempotency({
      id: "client-message-expired",
      sessionId: "session-old",
      messageId: "client-message-expired",
      now: 1_000,
    });
    await expect(completeClientMessageIdempotency({
      id: "client-message-expired",
      sessionId: "session-old",
      messageId: "client-message-expired",
      createdAt: 1_000,
      now: 2_000,
    })).resolves.toBe(true);

    await expect(claimClientMessageIdempotency({
      id: "client-message-expired",
      sessionId: "session-new",
      messageId: "client-message-expired",
      now: 2_000 + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS + 1,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-new" },
    });
  });

  it("created_at 已过 TTL 但持续 touch 的活跃在途记录不会被清理", async () => {
    const createdAt = 1_000;
    const cleanupAt = createdAt + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS + 1;
    await claimClientMessageIdempotency({
      id: "client-message-active",
      sessionId: "session-active",
      messageId: "client-message-active",
      now: createdAt,
    });
    await expect(touchClientMessageIdempotency({
      id: "client-message-active",
      sessionId: "session-active",
      messageId: "client-message-active",
      createdAt,
      now: cleanupAt - 30_000,
    })).resolves.toBe(true);

    // 另一条 claim 触发 TTL 清理，活跃在途行仍必须保留。
    await claimClientMessageIdempotency({
      id: "client-message-cleanup-trigger",
      sessionId: "session-trigger",
      messageId: "client-message-cleanup-trigger",
      now: cleanupAt,
    });
    await expect(claimClientMessageIdempotency({
      id: "client-message-active",
      sessionId: "session-duplicate",
      messageId: "client-message-active",
      now: cleanupAt,
    })).resolves.toMatchObject({
      claimed: false,
      record: {
        sessionId: "session-active",
        completedAt: null,
        lastTouched: cleanupAt - 30_000,
      },
    });
  });

  it("超过卡死阈值且未 touch 的在途记录会被回收", async () => {
    await claimClientMessageIdempotency({
      id: "client-message-stuck",
      sessionId: "session-stuck",
      messageId: "client-message-stuck",
      now: 1_000,
    });

    await expect(claimClientMessageIdempotency({
      id: "client-message-stuck",
      sessionId: "session-recovered",
      messageId: "client-message-stuck",
      now:
        1_000 +
        CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS +
        1,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-recovered" },
    });
  });
});

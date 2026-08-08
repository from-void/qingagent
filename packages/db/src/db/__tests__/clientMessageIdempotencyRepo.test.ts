import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimClientMessageIdempotency,
  completeClientMessageIdempotency,
  releaseClientMessageIdempotency,
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

  it("唯一键冲突后记录消失时立即暴露不变量失败", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claimClientMessageIdempotency({
      id: "missing-after-conflict",
      sessionId: "session-missing-after-conflict",
      messageId: "message-missing-after-conflict",
      now: 1_000,
      client: { execute } as unknown as Client,
    })).rejects.toThrow("client message idempotency claim invariant violated");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("模拟服务重启后不同会话的同一 clientMessageId 仍分别取得 claim", async () => {
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
      messageId: "message-after-restart",
      now: 2_000,
    })).resolves.toMatchObject({
      claimed: true,
      record: {
        sessionId: "session-cloned-after-restart",
        messageId: "message-after-restart",
      },
    });
  });

  it("同一会话重复同一 clientMessageId 时返回原 messageId", async () => {
    await expect(claimClientMessageIdempotency({
      id: "client-message-duplicate",
      sessionId: "session-duplicate",
      messageId: "message-original",
      now: 1_000,
    })).resolves.toMatchObject({ claimed: true });

    await expect(claimClientMessageIdempotency({
      id: "client-message-duplicate",
      sessionId: "session-duplicate",
      messageId: "message-replacement",
      now: 2_000,
    })).resolves.toEqual({
      claimed: false,
      record: {
        id: "client-message-duplicate",
        sessionId: "session-duplicate",
        messageId: "message-original",
        createdAt: 1_000,
        lastTouched: 1_000,
        completedAt: null,
      },
    });
  });

  it("touch、complete、release 只操作复合键所属会话", async () => {
    await claimClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-a",
      messageId: "message-a",
      now: 1_000,
    });
    await claimClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-b",
      messageId: "message-b",
      now: 1_100,
    });

    await expect(touchClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-a",
      messageId: "message-a",
      createdAt: 1_000,
      now: 2_000,
    })).resolves.toBe(true);
    await expect(completeClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-a",
      messageId: "message-a",
      createdAt: 1_000,
      now: 3_000,
    })).resolves.toBe(true);
    await expect(releaseClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-b",
      messageId: "message-b",
      createdAt: 1_100,
    })).resolves.toBe(true);

    await expect(claimClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-b",
      messageId: "message-b-retry",
      now: 4_000,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-b", messageId: "message-b-retry" },
    });
    await expect(claimClientMessageIdempotency({
      id: "client-message-owned",
      sessionId: "session-a",
      messageId: "message-a-retry",
      now: 4_000,
    })).resolves.toMatchObject({
      claimed: false,
      record: { sessionId: "session-a", messageId: "message-a" },
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
      sessionId: "session-old",
      messageId: "client-message-expired",
      now: 2_000 + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS + 1,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-old" },
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
      sessionId: "session-active",
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
      sessionId: "session-stuck",
      messageId: "client-message-stuck",
      now:
        1_000 +
        CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS +
        1,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-stuck" },
    });
  });

  it("恰好达到一小时卡死阈值的在途记录会被回收", async () => {
    const createdAt = 1_000;
    await claimClientMessageIdempotency({
      id: "client-message-stuck-boundary",
      sessionId: "session-stuck-boundary",
      messageId: "client-message-stuck-boundary",
      now: createdAt,
    });

    await expect(claimClientMessageIdempotency({
      id: "client-message-stuck-boundary",
      sessionId: "session-stuck-boundary",
      messageId: "client-message-stuck-boundary",
      now:
        createdAt +
        CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS,
    })).resolves.toMatchObject({
      claimed: true,
      record: { sessionId: "session-stuck-boundary" },
    });
  });
});

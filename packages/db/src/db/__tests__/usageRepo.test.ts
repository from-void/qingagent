import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { __resetMigrationsForTest } from "../migrations.js";
import { getDocumentsClient } from "../documentsClient.js";
import {
  aggregateUsageByDay,
  aggregateUsageBySession,
  aggregateUsageTotal,
  recordUsageEvent,
} from "../usageRepo.js";

let tempDb: TempDocumentsDb | null = null;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-usage-");
  __resetMigrationsForTest();
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
  __resetMigrationsForTest();
});

describe("usageRepo", () => {
  it("在临时 file db 上写入 usage 并按天/会话/总量聚合", async () => {
    await recordUsageEvent({
      sessionId: "session-a",
      runId: "run-a",
      callSite: "agent",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 100.2,
      outputTokens: 50.4,
      cacheHitTokens: 30,
      cacheMissTokens: 70,
    });
    await recordUsageEvent({
      sessionId: "session-a",
      callSite: "askUser",
      modelId: "deepseek-v4-flash",
      keyOrigin: "global-db",
      inputTokens: 10,
      outputTokens: 5,
    });
    await recordUsageEvent({
      sessionId: "session-a",
      callSite: "agent",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      usageState: "missing",
      reason: "provider_request_aborted",
    });
    await getDocumentsClient().execute({
      sql: `INSERT INTO documents
        (id, thread_id, resource_id, title, doc_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "doc-a",
        "session-a",
        "qingagent-user",
        "文档甲",
        "editing",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    });

    const today = new Date().toISOString().slice(0, 10);
    const rows = (bucket: string) => [
      {
        bucket,
        callSite: "agent",
        modelId: "deepseek-v4-flash",
        inputTokens: 100,
        outputTokens: 50,
        cacheHitTokens: 30,
        cacheMissTokens: 70,
        cacheCreationTokens: 0,
        cacheHitRate: 0.3,
        calls: 2,
        recordedCalls: 1,
        missingCalls: 1,
        coverageRate: 0.5,
      },
      {
        bucket,
        callSite: "askUser",
        modelId: "deepseek-v4-flash",
        inputTokens: 10,
        outputTokens: 5,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        cacheCreationTokens: 0,
        cacheHitRate: null,
        calls: 1,
        recordedCalls: 1,
        missingCalls: 0,
        coverageRate: 1,
      },
    ];
    expect(await aggregateUsageByDay(1)).toEqual(
      rows(today).map((row) => ({
        ...row,
        sessionId: "session-a",
        documentId: "doc-a",
        documentTitle: "文档甲",
      })),
    );
    expect(await aggregateUsageBySession()).toEqual(rows("session-a"));
    expect(await aggregateUsageTotal()).toEqual(rows("total"));
  });

  it("按天聚合以真实 session→documents 关联拆分文档，不合并相同调用点", async () => {
    for (const sessionId of ["session-a", "session-b"]) {
      await recordUsageEvent({
        sessionId,
        callSite: "agent",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        inputTokens: 100,
        outputTokens: 20,
      });
    }
    const now = new Date().toISOString();
    for (const [id, threadId, title] of [
      ["doc-a", "session-a", "文档甲"],
      ["doc-b", "session-b", "文档乙"],
    ] as const) {
      await getDocumentsClient().execute({
        sql: `INSERT INTO documents
          (id, thread_id, resource_id, title, doc_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, threadId, "qingagent-user", title, "editing", now, now],
      });
    }

    expect(await aggregateUsageByDay(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-a",
          documentId: "doc-a",
          documentTitle: "文档甲",
          callSite: "agent",
        }),
        expect.objectContaining({
          sessionId: "session-b",
          documentId: "doc-b",
          documentTitle: "文档乙",
          callSite: "agent",
        }),
      ]),
    );
  });

  it("Anthropic 只有 cache read/creation、miss 未知时命中率保持 null", async () => {
    await recordUsageEvent({
      sessionId: "session-glm",
      callSite: "askUser",
      modelId: "glm-4.6",
      keyOrigin: "visitor",
      inputTokens: 100,
      outputTokens: 8,
      cacheHitTokens: 80,
      cacheCreationTokens: 20,
    });
    expect(await aggregateUsageTotal()).toEqual([
      expect.objectContaining({
        modelId: "glm-4.6",
        cacheHitTokens: 80,
        cacheMissTokens: 0,
        cacheCreationTokens: 20,
        cacheHitRate: null,
      }),
    ]);
  });
});

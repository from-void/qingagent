import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useRealTimers();
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

  it("按 IANA 日界聚合跨 UTC 午夜用量，并保留窗口首日早晨", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T20:00:00-07:00"));
    for (const sessionId of ["local-evening", "window-first-morning", "outside-window"]) {
      await recordUsageEvent({
        sessionId,
        callSite: "agent",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    for (const [sessionId, createdAt] of [
      ["local-evening", "2026-07-29T03:00:00.000Z"],
      ["window-first-morning", "2026-07-22T07:30:00.000Z"],
      ["outside-window", "2026-07-22T06:59:00.000Z"],
    ] as const) {
      await getDocumentsClient().execute({
        sql: "UPDATE llm_usage_events SET created_at = ? WHERE session_id = ?",
        args: [createdAt, sessionId],
      });
    }

    const rows = await aggregateUsageByDay(7, "America/Los_Angeles");

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: "2026-07-28", sessionId: "local-evening" }),
      expect.objectContaining({ bucket: "2026-07-22", sessionId: "window-first-morning" }),
    ]));
    expect(rows.some((row) => row.sessionId === "outside-window")).toBe(false);
  });

  it("洛杉矶 DST 结束日按事件实际偏移分桶并保留窗口首日凌晨", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T20:00:00-08:00"));
    for (const sessionId of ["dst-first-midnight", "post-dst-midnight", "outside-window"]) {
      await recordUsageEvent({
        sessionId,
        callSite: "agent",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    for (const [sessionId, createdAt] of [
      ["dst-first-midnight", "2026-11-01T07:30:00.000Z"],
      ["post-dst-midnight", "2026-11-03T08:30:00.000Z"],
      ["outside-window", "2026-11-01T06:59:00.000Z"],
    ] as const) {
      await getDocumentsClient().execute({
        sql: "UPDATE llm_usage_events SET created_at = ? WHERE session_id = ?",
        args: [createdAt, sessionId],
      });
    }

    const rows = await aggregateUsageByDay(3, "America/Los_Angeles");

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: "2026-11-01", sessionId: "dst-first-midnight" }),
      expect.objectContaining({ bucket: "2026-11-03", sessionId: "post-dst-midnight" }),
    ]));
    expect(rows.some((row) => row.sessionId === "outside-window")).toBe(false);
  });

  it("最近会话限制按 session 选取并完整返回其中所有调用点和模型", async () => {
    for (const event of [
      { sessionId: "session-old", callSite: "agent", modelId: "model-a" },
      { sessionId: "session-middle", callSite: "agent", modelId: "model-a" },
      { sessionId: "session-latest", callSite: "agent", modelId: "model-a" },
      { sessionId: "session-latest", callSite: "askUser", modelId: "model-b" },
    ]) {
      await recordUsageEvent({
        ...event,
        keyOrigin: "visitor",
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    const client = getDocumentsClient();
    for (const [sessionId, createdAt] of [
      ["session-old", "2026-07-28T01:00:00.000Z"],
      ["session-middle", "2026-07-28T02:00:00.000Z"],
      ["session-latest", "2026-07-28T03:00:00.000Z"],
    ] as const) {
      await client.execute({
        sql: "UPDATE llm_usage_events SET created_at = ? WHERE session_id = ?",
        args: [createdAt, sessionId],
      });
    }

    const rows = await aggregateUsageBySession(2);
    expect([...new Set(rows.map((row) => row.bucket))].sort()).toEqual([
      "session-latest",
      "session-middle",
    ]);
    expect(rows.filter((row) => row.bucket === "session-latest")).toEqual([
      expect.objectContaining({ callSite: "agent", modelId: "model-a" }),
      expect.objectContaining({ callSite: "askUser", modelId: "model-b" }),
    ]);
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

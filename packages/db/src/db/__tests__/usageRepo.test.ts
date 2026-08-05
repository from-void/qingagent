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
  it("金额快照与高峰档位随事件落库并分别聚合 recorded/estimated", async () => {
    await recordUsageEvent({
      sessionId: "session-priced",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 100,
      outputTokens: 20,
      usageState: "recorded",
      costCny: 0.0123,
      pricingTier: "peak",
      pricingMultiplier: 2,
      occurredAt: "2026-08-06T01:30:00.000Z",
    });
    await recordUsageEvent({
      sessionId: "session-priced",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 70,
      outputTokens: 10,
      usageState: "estimated",
      costCny: 0.0045,
      pricingTier: "peak",
      pricingMultiplier: 2,
      occurredAt: "2026-08-06T01:31:00.000Z",
    });
    await getDocumentsClient().execute(
      `INSERT INTO llm_usage_events
       (id, session_id, call_site, model_id, key_origin, input_tokens, output_tokens,
        cache_hit_tokens, cache_miss_tokens, cache_accounting_state, usage_state, created_at)
       VALUES ('legacy-priced', 'session-priced', 'agentChat', 'deepseek-v4-flash',
        'visitor', 30, 3, 20, 10, 'known', 'recorded', '2026-08-06T01:29:00.000Z')`,
    );

    expect(await aggregateUsageTotal()).toEqual([
      expect.objectContaining({
        costCny: 0.0123,
        estimatedCostCny: 0.0045,
        peakPricedCalls: 2,
        peakPricingMultiplierMin: 2,
        peakPricingMultiplierMax: 2,
        pricingSnapshotCalls: 2,
        legacyPricingCalls: 1,
        legacyInputTokens: 30,
        legacyOutputTokens: 3,
        legacyCacheHitTokens: 20,
        legacyCacheMissTokens: 10,
      }),
    ]);
    const stored = await getDocumentsClient().execute(
      "SELECT created_at, cost_cny, pricing_tier, pricing_multiplier FROM llm_usage_events WHERE pricing_tier IS NOT NULL ORDER BY created_at",
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({
        created_at: "2026-08-06T01:30:00.000Z",
        cost_cny: 0.0123,
        pricing_tier: "peak",
        pricing_multiplier: 2,
      }),
      expect.objectContaining({
        created_at: "2026-08-06T01:31:00.000Z",
        cost_cny: 0.0045,
        pricing_tier: "peak",
        pricing_multiplier: 2,
      }),
    ]);
  });

  it("estimated 单列聚合，不混入 recorded token 与精确覆盖率", async () => {
    await recordUsageEvent({
      sessionId: "session-estimated",
      callSite: "writeDraft",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
    });
    await recordUsageEvent({
      sessionId: "session-estimated",
      callSite: "writeDraft",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      usageState: "estimated" as never,
      reason: "provider_request_aborted",
      inputTokens: 70,
      outputTokens: 10,
      cacheHitTokens: 60,
      cacheMissTokens: 10,
    });
    await recordUsageEvent({
      sessionId: "session-estimated",
      callSite: "writeDraft",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      usageState: "missing",
      reason: "provider_usage_missing",
    });

    expect(await aggregateUsageTotal()).toEqual([
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 20,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        estimatedInputTokens: 70,
        estimatedOutputTokens: 10,
        estimatedCacheHitTokens: 60,
        estimatedCacheMissTokens: 10,
        calls: 3,
        recordedCalls: 1,
        estimatedCalls: 1,
        missingCalls: 1,
        coverageRate: 1 / 3,
      }),
    ]);
  });

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
        coldStartMissTokens: 70,
        cacheCreationTokens: 0,
        cacheHitRate: 0.3,
        calls: 2,
        recordedCalls: 1,
        missingCalls: 1,
        coverageRate: 0.5,
        pricingSnapshotCalls: 2,
      },
      {
        bucket,
        callSite: "askUser",
        modelId: "deepseek-v4-flash",
        inputTokens: 10,
        outputTokens: 5,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        coldStartMissTokens: 0,
        cacheCreationTokens: 0,
        cacheHitRate: null,
        calls: 1,
        recordedCalls: 1,
        missingCalls: 0,
        coverageRate: 1,
        pricingSnapshotCalls: 1,
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

  it("按会话调用点最早请求统计冷启动，多轮 attempt=1 不重复且并发 lane 各自计入", async () => {
    const recordAt = async (
      input: Parameters<typeof recordUsageEvent>[0],
      createdAt: string,
    ) => {
      await recordUsageEvent(input);
      await getDocumentsClient().execute({
        sql: "UPDATE llm_usage_events SET created_at = ? WHERE run_id = ?",
        args: [createdAt, input.runId ?? null],
      });
    };

    // 验收样例：三轮都因 RequestContext 重建而从 attempt=1 开始，只有最早一轮是冷启动。
    for (const event of [
      { runId: "s1-agent-turn-1", inputTokens: 25_000, cacheHitTokens: 0, cacheMissTokens: 25_000, createdAt: "2026-07-31T00:00:00.000Z" },
      { runId: "s1-agent-turn-2", inputTokens: 42_000, cacheHitTokens: 40_000, cacheMissTokens: 2_000, createdAt: "2026-07-31T00:01:00.000Z" },
      { runId: "s1-agent-turn-3", inputTokens: 44_000, cacheHitTokens: 42_000, cacheMissTokens: 2_000, createdAt: "2026-07-31T00:02:00.000Z" },
    ]) {
      await recordAt({
        sessionId: "S1",
        runId: event.runId,
        callSite: "agentChat",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        inputTokens: event.inputTokens,
        outputTokens: 1,
        cacheHitTokens: event.cacheHitTokens,
        cacheMissTokens: event.cacheMissTokens,
        attempt: 1,
      }, event.createdAt);
    }
    // 同会话的另一调用点有自己的冷启动；单轮会话的全部 miss 都是冷启动。
    await recordAt({
      sessionId: "S1",
      runId: "s1-write-draft",
      callSite: "writeDraft",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 5_000,
      outputTokens: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 5_000,
      attempt: 1,
    }, "2026-07-31T00:03:00.000Z");
    await recordAt({
      sessionId: "S2",
      runId: "s2-agent-single",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      inputTokens: 3_000,
      outputTokens: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 3_000,
      attempt: 1,
    }, "2026-07-31T00:04:00.000Z");

    // 赛马 lane 各自建立前缀缓存；同一 lane 后续请求不重复计建缓存。
    for (const event of [
      { runId: "lane-0-first", lane: 0, miss: 7_000, createdAt: "2026-07-31T00:05:00.000Z" },
      { runId: "lane-1-first", lane: 1, miss: 8_000, createdAt: "2026-07-31T00:05:00.100Z" },
      { runId: "lane-0-next", lane: 0, miss: 500, createdAt: "2026-07-31T00:06:00.000Z" },
    ]) {
      await recordAt({
        sessionId: "S3",
        runId: event.runId,
        callSite: "writeDraft",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        lane: event.lane,
        inputTokens: event.miss,
        outputTokens: 1,
        cacheHitTokens: 0,
        cacheMissTokens: event.miss,
        attempt: 1,
      }, event.createdAt);
    }

    const sessionRows = await aggregateUsageBySession();
    const acceptance = sessionRows.find((row) => row.bucket === "S1" && row.callSite === "agentChat");
    expect(acceptance).toMatchObject({
      inputTokens: 111_000,
      cacheHitTokens: 82_000,
      cacheMissTokens: 29_000,
      coldStartMissTokens: 25_000,
      cacheHitRate: 82_000 / 111_000,
    });
    expect(sessionRows.find((row) => row.bucket === "S1" && row.callSite === "writeDraft"))
      .toMatchObject({ coldStartMissTokens: 5_000 });
    expect(sessionRows.find((row) => row.bucket === "S2" && row.callSite === "agentChat"))
      .toMatchObject({ coldStartMissTokens: 3_000 });
    expect(sessionRows.find((row) => row.bucket === "S3" && row.callSite === "writeDraft"))
      .toMatchObject({ cacheMissTokens: 15_500, coldStartMissTokens: 15_000 });
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
        coldStartMissTokens: 0,
        cacheCreationTokens: 20,
        cacheHitRate: null,
      }),
    ]);
  });
});

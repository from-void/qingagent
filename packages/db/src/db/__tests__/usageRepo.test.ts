import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { getDocumentsClient } from "../documentsClient.js";
import { ensureMigrated } from "../migrations.js";
import {
  aggregateUsageBySession,
  aggregateUsageTotal,
  buildPricingSliceCase,
  queryUsageByDay,
  recordUsageEvent,
  type PricingSliceSpec,
} from "../usageRepo.js";

let tempDb: TempDocumentsDb | null = null;

const baseSpec: PricingSliceSpec = {
  epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z" }],
};

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-usage-");
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
  vi.useRealTimers();
});

async function recordAt(overrides: Partial<Parameters<typeof recordUsageEvent>[0]> = {}) {
  await recordUsageEvent({
    sessionId: "session-a",
    runId: `run-${Math.random()}`,
    callSite: "agent",
    modelId: "model-a",
    keyOrigin: "visitor",
    inputTokens: 10,
    outputTokens: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 10,
    occurredAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  });
}

function statementSql(statement: unknown): string {
  if (typeof statement === "string") return statement;
  return String((statement as { sql?: unknown } | null)?.sql ?? "");
}

describe("usage 事实账本", () => {
  it("写端只落原始事实，0043 后表中不存在三列金额快照", async () => {
    await recordAt();
    const client = getDocumentsClient();
    const columns = await client.execute("PRAGMA table_info(llm_usage_events)");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).not.toContain("cost_cny");
    expect(names).not.toContain("pricing_tier");
    expect(names).not.toContain("pricing_multiplier");
    expect((await client.execute(
      "SELECT input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, created_at FROM llm_usage_events",
    )).rows).toEqual([expect.objectContaining({
      input_tokens: 10,
      output_tokens: 1,
      cache_hit_tokens: 0,
      cache_miss_tokens: 10,
      created_at: "2026-08-08T00:00:00.000Z",
    })]);
  });

  it("四状态只影响各自计数，missing/billing_unknown 不伪造 token", async () => {
    await recordAt({ usageState: "recorded", runId: "recorded" });
    await recordAt({ usageState: "estimated", runId: "estimated", inputTokens: 20 });
    await recordAt({ usageState: "missing", runId: "missing", inputTokens: undefined, outputTokens: undefined });
    await recordAt({ usageState: "billing_unknown", runId: "unknown", inputTokens: undefined, outputTokens: undefined });
    const [slice] = await aggregateUsageTotal(baseSpec);
    expect(slice).toMatchObject({
      inputTokens: 10,
      estimatedInputTokens: 20,
      calls: 4,
      recordedCalls: 1,
      estimatedCalls: 1,
      missingCalls: 1,
      billingUnknownCalls: 1,
    });
  });
});

describe("pricing slice CASE", () => {
  it.each([
    {
      epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z' OR 1=1 --" }],
    },
    {
      epochs: [{
        effectiveFrom: "1970-01-01T00:00:00.000Z",
        peak: { windows: [{ start: "00:00", end: "01:00" }], models: ["x' OR 1=1 --"] },
      }],
    },
  ] as PricingSliceSpec[])("拒绝带引号/SQL 片段的 spec", (spec) => {
    expect(() => buildPricingSliceCase(spec)).toThrow();
  });

  it("多 epoch、多窗口、重叠与跨午夜只生成绑定参数", () => {
    const built = buildPricingSliceCase({
      epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z" }, {
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        peak: {
          models: ["model-a", "vendor/model:b"],
          windows: [
            { start: "09:00", end: "12:00" },
            { start: "10:00", end: "11:00" },
            { start: "23:00", end: "02:00" },
          ],
        },
      }],
    });
    expect(built.sql).toContain("strftime('%H:%M'");
    expect(built.sql).toContain(" OR ");
    expect(built.sql).not.toContain("2026-01-01");
    expect(built.sql).not.toContain("vendor/model:b");
    expect(built.args).toContain("2026-01-01T00:00:00.000Z");
    expect(built.args).toContain("vendor/model:b");
  });

  it("参数上限与窗口数量上限机器拒绝", () => {
    expect(() => buildPricingSliceCase({
      epochs: [{
        effectiveFrom: "1970-01-01T00:00:00.000Z",
        peak: {
          models: ["model-a"],
          windows: Array.from({ length: 33 }, (_, index) => ({
            start: `${String(index % 23).padStart(2, "0")}:00`,
            end: `${String((index + 1) % 23).padStart(2, "0")}:00`,
          })),
        },
      }],
    })).toThrow(/windows/);
    const crowded: PricingSliceSpec = {
      epochs: Array.from({ length: 5 }, (_, epochIndex) => ({
        effectiveFrom: epochIndex === 0
          ? "1970-01-01T00:00:00.000Z"
          : `202${epochIndex}-01-01T00:00:00.000Z`,
        peak: {
          models: Array.from({ length: 128 }, (_, modelIndex) =>
            `model-${epochIndex}-${modelIndex}`),
          windows: Array.from({ length: 32 }, (_, windowIndex) => ({
            start: `${String(windowIndex % 24).padStart(2, "0")}:00`,
            end: `${String((windowIndex + 1) % 24).padStart(2, "0")}:00`,
          })),
        },
      })),
    };
    expect(() => buildPricingSliceCase(crowded)).toThrow(/参数/);
  });

  it("epoch/峰窗毫秒边界、重叠窗口与非法时间归属精确", async () => {
    const spec: PricingSliceSpec = {
      epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z" }, {
        effectiveFrom: "2026-08-08T00:00:00.000Z",
        peak: {
          models: ["model-a"],
          windows: [
            { start: "08:00", end: "10:00" },
            { start: "09:00", end: "11:00" },
          ],
        },
      }],
    };
    for (const [runId, occurredAt] of [
      ["before", "2026-08-07T23:59:59.999Z"],
      ["at", "2026-08-08T00:00:00.000Z"], // 北京 08:00
      ["inside-overlap", "2026-08-08T01:30:00.000Z"],
      ["end", "2026-08-08T03:00:00.000Z"], // 北京 11:00
    ] as const) await recordAt({ runId, occurredAt });
    const rows = await aggregateUsageTotal(spec);
    expect(rows.map((row) => [row.pricingSlice, row.calls])).toEqual([
      [0, 1],
      [2, 1],
      [3, 2],
    ]);
  });
});

describe("聚合语义保持", () => {
  it("billable miss 逐行 MAX 后 SUM，known 命中率分子分母独立携带", async () => {
    await recordAt({
      runId: "counter-1",
      inputTokens: 10,
      cacheHitTokens: 10,
      cacheMissTokens: 20,
      cacheAccountingState: "known",
    });
    await recordAt({
      runId: "counter-2",
      inputTokens: 10,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      cacheAccountingState: "unknown",
    });
    expect(await aggregateUsageTotal(baseSpec)).toEqual([
      expect.objectContaining({
        inputTokens: 20,
        billableMissTokens: 30,
        knownCacheHitTokens: 10,
        knownCacheTotalTokens: 30,
      }),
    ]);
  });

  it("窗口前首发不误标、同最早时间戳并列全标、lane 各自首发", async () => {
    for (const [runId, lane, occurredAt, miss] of [
      ["before-window", 0, "2026-07-01T00:00:00.000Z", 100],
      ["inside", 0, "2026-08-08T00:00:00.000Z", 10],
      ["tie-a", 1, "2026-08-08T00:00:00.000Z", 20],
      ["tie-b", 1, "2026-08-08T00:00:00.000Z", 30],
    ] as const) {
      await recordAt({
        runId,
        lane,
        occurredAt,
        inputTokens: miss,
        cacheHitTokens: 0,
        cacheMissTokens: miss,
        cacheAccountingState: "known",
      });
    }
    const session = await aggregateUsageBySession(baseSpec);
    expect(session.reduce((sum, row) => sum + row.coldStartMissTokens, 0)).toBe(150);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const day = await queryUsageByDay(30, "UTC");
    expect(day.find((row) => row.occurredAt === "2026-08-08T00:00:00.000Z" && row.isColdStart && row.inputTokens === 10))
      .toBeUndefined();
    expect(day.filter((row) => row.isColdStart && (row.inputTokens === 20 || row.inputTokens === 30)))
      .toHaveLength(2);
  });

  it("最近 200 选择器先选 session，再完整保留入选会话调用点", async () => {
    for (const [sessionId, occurredAt] of [
      ["old", "2026-08-08T00:00:00.000Z"],
      ["middle", "2026-08-08T01:00:00.000Z"],
      ["latest", "2026-08-08T02:00:00.000Z"],
    ] as const) await recordAt({ sessionId, occurredAt });
    await recordAt({ sessionId: "latest", callSite: "askUser", modelId: "model-b", occurredAt: "2026-08-08T02:00:01.000Z" });
    const rows = await aggregateUsageBySession(baseSpec, 2);
    expect(new Set(rows.map((row) => row.bucket))).toEqual(new Set(["latest", "middle"]));
    expect(rows.filter((row) => row.bucket === "latest").map((row) => row.callSite).sort())
      .toEqual(["agent", "askUser"]);
  });

  it("day 保留 IANA/DST 日界、无 documents 回退 session_id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T20:00:00-08:00"));
    await recordAt({ sessionId: "dst", occurredAt: "2026-11-01T07:30:00.000Z" });
    await recordAt({ sessionId: "post", occurredAt: "2026-11-03T08:30:00.000Z" });
    const rows = await queryUsageByDay(3, "America/Los_Angeles");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: "2026-11-01", sessionId: "dst", documentId: "dst" }),
      expect.objectContaining({ bucket: "2026-11-03", sessionId: "post", documentId: "post" }),
    ]));
  });

  it("同一 UTC 时刻的 UTC 与北京时间日桶彼此独立", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    await recordAt({
      sessionId: "timezone-boundary",
      occurredAt: "2026-08-08T16:30:00.000Z",
    });
    expect((await queryUsageByDay(2, "UTC"))[0]?.bucket).toBe("2026-08-08");
    expect((await queryUsageByDay(2, "Asia/Shanghai"))[0]?.bucket).toBe("2026-08-09");
  });

  it("每个视图只向 llm_usage_events 发出一条查询语句", async () => {
    await recordAt();
    await ensureMigrated();
    const client = getDocumentsClient();
    const execute = vi.spyOn(client, "execute");
    await aggregateUsageBySession(baseSpec);
    expect(execute.mock.calls.filter(([statement]) =>
      statementSql(statement).includes("llm_usage_events")))
      .toHaveLength(1);
    execute.mockClear();
    await aggregateUsageTotal(baseSpec);
    expect(execute.mock.calls.filter(([statement]) =>
      statementSql(statement).includes("llm_usage_events")))
      .toHaveLength(1);
    execute.mockClear();
    await queryUsageByDay(30, "UTC");
    expect(execute.mock.calls.filter(([statement]) =>
      statementSql(statement).includes("llm_usage_events")))
      .toHaveLength(1);
  });
});

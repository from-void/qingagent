import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { __resetMigrationsForTest } from "../migrations.js";
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

    const today = new Date().toISOString().slice(0, 10);
    expect(await aggregateUsageByDay(1)).toEqual([
      {
        bucket: today,
        modelId: "deepseek-v4-flash",
        inputTokens: 110,
        outputTokens: 55,
        cacheHitTokens: 30,
        cacheMissTokens: 70,
        calls: 2,
      },
    ]);
    expect(await aggregateUsageBySession()).toEqual([
      {
        bucket: "session-a",
        modelId: "deepseek-v4-flash",
        inputTokens: 110,
        outputTokens: 55,
        cacheHitTokens: 30,
        cacheMissTokens: 70,
        calls: 2,
      },
    ]);
    expect(await aggregateUsageTotal()).toEqual([
      {
        bucket: "total",
        modelId: "deepseek-v4-flash",
        inputTokens: 110,
        outputTokens: 55,
        cacheHitTokens: 30,
        cacheMissTokens: 70,
        calls: 2,
      },
    ]);
  });
});

#!/usr/bin/env -S pnpm tsx
// 真实网络 + 真实账本探针（不使用假 usage）：
//   pnpm --filter @qingagent/core usage:verify-inner -- openai
//   GLM_API_KEY=... QINGAGENT_MODEL_BASE_URL=... QINGAGENT_MODEL_FLASH=glm-4.6 \
//     pnpm --filter @qingagent/core usage:verify-inner -- anthropic
// 默认使用 /tmp 临时 DB；只输出 usage 摘要，不输出 key、prompt 或模型正文。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { getDocumentsClient, __resetDocumentsClientForTest } from "../src/db/documentsClient.js";
import { __resetMigrationsForTest } from "../src/db/migrations.js";
import { streamInnerModel } from "../src/llm/innerModelStream.js";
import { MODEL_OVERRIDES_CONTEXT_KEY } from "../src/llm/modelConfig.js";
import {
  observeModelUsageConsistency,
  type ModelUsageConsistencyObservation,
} from "../src/llm/usageMiddleware.js";

const protocol = process.argv[2] === "anthropic" ? "anthropic" : "openai";
const apiKey = protocol === "anthropic"
  ? process.env.GLM_API_KEY || process.env.DEEPSEEK_API_KEY || ""
  : process.env.DEEPSEEK_API_KEY || "";
if (!apiKey) throw new Error(protocol === "anthropic" ? "缺少 GLM_API_KEY/DEEPSEEK_API_KEY" : "缺少 DEEPSEEK_API_KEY");
const baseUrl = process.env.QINGAGENT_MODEL_BASE_URL || process.env.QINGAGENT_DEEPSEEK_BASE_URL ||
  (protocol === "anthropic" ? "" : "https://api.deepseek.com/v1");
if (!baseUrl) throw new Error("anthropic 探针必须设置 QINGAGENT_MODEL_BASE_URL");
const model = process.env.QINGAGENT_MODEL_FLASH ||
  (protocol === "anthropic" ? "glm-4.6" : "deepseek-v4-flash");
const tempDir = await mkdtemp(join(tmpdir(), "qingagent-usage-probe-"));
const ownsDb = !process.env.DATABASE_URL;
if (ownsDb) process.env.DATABASE_URL = `file:${join(tempDir, "usage.db")}`;
__resetDocumentsClientForTest();
__resetMigrationsForTest();

const sessionId = `usage-probe-${protocol}-${Date.now()}`;
const requestContext = new RequestContext([
  [MODEL_OVERRIDES_CONTEXT_KEY, {
    visitorApiKey: apiKey,
    baseUrl,
    protocol,
    modelIds: { flash: model },
  }],
  ["sessionId", sessionId],
  ["runId", `${sessionId}-run`],
] as never);
let consistency: ModelUsageConsistencyObservation | null = null;
const stopObservingConsistency = observeModelUsageConsistency((observation) => {
  if (observation.sessionId === sessionId) consistency = observation;
});

try {
  await streamInnerModel({
    requestContext,
    callSite: protocol === "anthropic" ? "glmUsageProbe" : "openaiUsageProbe",
    lane: 0,
    prompt: "只回答 ok",
    thinking: false,
    temperature: 0,
    maxRetries: 0,
    maxTokens: 16,
  });

  let row: Record<string, unknown> | undefined;
  for (let i = 0; i < 40 && !row; i += 1) {
    const result = await getDocumentsClient().execute({
      sql: `SELECT call_site, model_id, input_tokens, output_tokens,
          cache_hit_tokens, cache_miss_tokens, cache_creation_tokens,
          cache_accounting_state, usage_state, reason, lane, attempt
        FROM llm_usage_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [sessionId],
    }).catch(() => null);
    row = result?.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  if (!row) throw new Error("模型请求完成，但账本 2s 内未出现事件");
  console.log(JSON.stringify({
    protocol,
    ledger: row,
    consistency: consistency && {
      sdk: consistency.sdk,
      wire: consistency.wire,
      consistent: consistency.consistent,
    },
  }, null, 2));
  if (row.usage_state !== "recorded" || !consistency?.consistent) process.exitCode = 1;
} finally {
  stopObservingConsistency();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  if (ownsDb) delete process.env.DATABASE_URL;
  await rm(tempDir, { recursive: true, force: true });
}

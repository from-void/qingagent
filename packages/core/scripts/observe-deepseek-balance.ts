#!/usr/bin/env -S pnpm tsx
// 手动余额差额观测：仅官方 DeepSeek env/global key；不纳入 visitor/custom/GLM。
// 首次建立基线：pnpm --filter @qingagent/core usage:balance -- --refresh
// 再次对账：    pnpm --filter @qingagent/core usage:balance
// 基线默认写 /tmp，可用 --baseline /安全路径/baseline.json 指定；文件不含 key。

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAppSetting, SETTING_DEEPSEEK_GLOBAL_KEY } from "../src/db/appSettingsRepo.js";
import { getDocumentsClient } from "../src/db/documentsClient.js";
import { ensureMigrated } from "../src/db/migrations.js";
import { estimateCostCny } from "../src/llm/modelPricing.js";

interface Baseline {
  capturedAt: string;
  currency: string;
  totalBalance: number;
  keySource: "global-db" | "env";
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("用法: pnpm --filter @qingagent/core usage:balance -- [--baseline <path>] [--refresh]");
  process.exit(0);
}
const baselineArg = args.indexOf("--baseline");
const baselinePath = resolve(
  baselineArg >= 0 && args[baselineArg + 1]
    ? args[baselineArg + 1]!
    : "/tmp/qingagent-deepseek-balance-baseline.json",
);
const refresh = args.includes("--refresh");
const globalKey = await getAppSetting(SETTING_DEEPSEEK_GLOBAL_KEY);
const apiKey = globalKey || process.env.DEEPSEEK_API_KEY || "";
const keySource: Baseline["keySource"] = globalKey ? "global-db" : "env";
if (!apiKey) throw new Error("缺少官方 DeepSeek global/env key，无法查询余额");

const response = await fetch("https://api.deepseek.com/user/balance", {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`);
const body = await response.json() as {
  balance_infos?: Array<{ currency?: string; total_balance?: string }>;
};
const balanceInfo = body.balance_infos?.find((item) => item.currency === "CNY") ?? body.balance_infos?.[0];
const currentBalance = Number(balanceInfo?.total_balance);
const currency = balanceInfo?.currency ?? "";
if (!Number.isFinite(currentBalance)) throw new Error("DeepSeek 余额响应缺少有效 total_balance");
if (currency !== "CNY") throw new Error(`余额币种为 ${currency || "unknown"}，不能与 CNY 估算成本直接对账`);

const now = new Date().toISOString();
if (refresh) {
  const baseline: Baseline = { capturedAt: now, currency, totalBalance: currentBalance, keySource };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: "BASELINE_CREATED", baselinePath, ...baseline }, null, 2));
  process.exit(0);
}

let baseline: Baseline;
try {
  baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
} catch {
  throw new Error(`缺少基线 ${baselinePath}；先加 --refresh 建立基线`);
}
if (baseline.currency !== "CNY") throw new Error(`基线币种 ${baseline.currency} 不是 CNY`);
if (baseline.keySource !== keySource) {
  throw new Error(`key 来源从 ${baseline.keySource} 变为 ${keySource}；请确认同一账户后 --refresh 重建基线`);
}

await ensureMigrated();
const rows = await getDocumentsClient().execute({
  sql: `SELECT model_id,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_hit_tokens) AS cache_hit_tokens,
      SUM(cache_miss_tokens) AS cache_miss_tokens,
      SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls,
      COUNT(*) AS calls
    FROM llm_usage_events
    WHERE created_at >= ?
      AND key_origin IN ('env', 'global-db')
      AND model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
    GROUP BY model_id`,
  args: [baseline.capturedAt],
});
let ledgerCostCny = 0;
let calls = 0;
let missingCalls = 0;
for (const raw of rows.rows) {
  const row = raw as unknown as Record<string, unknown>;
  ledgerCostCny += estimateCostCny(String(row.model_id), {
    input: Number(row.input_tokens ?? 0),
    output: Number(row.output_tokens ?? 0),
    cacheHit: Number(row.cache_hit_tokens ?? 0),
    cacheMiss: Number(row.cache_miss_tokens ?? 0),
  });
  calls += Number(row.calls ?? 0);
  missingCalls += Number(row.missing_calls ?? 0);
}
const observedSpendCny = baseline.totalBalance - currentBalance;
const differenceCny = observedSpendCny - ledgerCostCny;
const alertThresholdCny = Number(process.env.QINGAGENT_USAGE_BALANCE_ALERT_CNY ?? "0.1");
const alert = Math.abs(differenceCny) > alertThresholdCny;
console.log(JSON.stringify({
  status: alert ? "ALERT" : "OK",
  note: "手动对账假设基线与当前为同一官方 DeepSeek 账户；账本尚无账户指纹，期间充值/赠款变化会形成差额。",
  baselinePath,
  baselineAt: baseline.capturedAt,
  observedAt: now,
  keySource,
  currency,
  baselineBalance: baseline.totalBalance,
  currentBalance,
  observedSpendCny,
  ledgerCostCny,
  differenceCny,
  alertThresholdCny,
  calls,
  missingCalls,
  coverageRate: calls > 0 ? (calls - missingCalls) / calls : null,
}, null, 2));
if (alert) process.exitCode = 2;

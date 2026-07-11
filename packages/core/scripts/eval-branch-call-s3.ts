import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RequestContext } from "@mastra/core/request-context";

const outputDir = resolve(
  process.env.BRANCH_CALL_EVAL_DIR ??
    "/home/jimmy/proj/qingagent-ops/evals/260712-branchcall",
);
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));
const usageDbPath = resolve(outputDir, "s3-usage.db");
for (const suffix of ["", "-wal", "-shm"]) await rm(`${usageDbPath}${suffix}`, { force: true });
process.env.DATABASE_URL = `file:${usageDbPath}`;

const {
  beginSessionSnapshotTurn,
  branchCall,
  createSnapshottingQingagentModel,
  getSessionSnapshot,
} = await import("../src/llm/modelConfig.js");
const { buildSystemPrompt } = await import("../src/prompts/system.js");
const { getDocumentsClient } = await import("../src/db/documentsClient.js");

const tools = Array.from({ length: 37 }, (_, index) => ({
  type: "function" as const,
  name: index === 0 ? "writeDraft" : `capability_${index}`,
  description: `产品能力 ${index}。`.repeat(10),
  inputSchema: { type: "object", properties: { input: { type: "string" } } },
}));
const longHistory = Array.from({ length: 24 }, (_, index) => ({
  role: index % 2 === 0 ? "user" as const : "assistant" as const,
  content: [{ type: "text" as const, text: `历史块 ${index}：${"稳定会话事实与写作素材。".repeat(90)}` }],
}));

function context(sessionId: string): RequestContext {
  return new RequestContext([
    ["sessionId", sessionId],
    ["streamId", `stream-${sessionId}`],
    ["runId", `run-${sessionId}`],
  ] as never) as RequestContext;
}

async function mainCall(sessionId: string, omEnabled: boolean) {
  const requestContext = context(sessionId);
  beginSessionSnapshotTurn(requestContext);
  const prompt = [
    { role: "system" as const, content: buildSystemPrompt() },
    ...(omEnabled
      ? [{ role: "system" as const, content: "[长期观察·epoch 1]\n- 用户要求保持严谨、短句。" }]
      : []),
    ...longHistory,
    { role: "user" as const, content: [{ type: "text" as const, text: "继续，直接回复已收到，不调用工具。" }] },
  ];
  const model = createSnapshottingQingagentModel(requestContext);
  const result = await model.doStream({ prompt, tools, toolChoice: { type: "auto" } } as never);
  let usage: Record<string, number> = {};
  for await (const part of result.stream) {
    if ((part as { type?: string }).type === "finish") {
      usage = ((part as { usage?: Record<string, number> }).usage ?? {});
    }
  }
  return { requestContext, usage };
}

function cacheRate(runs: Array<{ usage: Record<string, number> }>): number {
  const input = runs.reduce((sum, run) => sum + Number(run.usage.inputTokens ?? 0), 0);
  const hit = runs.reduce((sum, run) => sum + Number(run.usage.cachedInputTokens ?? 0), 0);
  return input > 0 ? hit / input : 0;
}

const mainOff = [];
const mainOn = [];
for (let index = 0; index < 6; index += 1) {
  mainOff.push(await mainCall(`s3-main-off-${index}`, false));
  mainOn.push(await mainCall(`s3-main-on-${index}`, true));
}

const anchor = await mainCall("s3-om-anchor", true);
const snapshot = getSessionSnapshot(anchor.requestContext);
if (!snapshot) throw new Error("OM anchor snapshot missing");
const omResults: Array<Record<string, unknown>> = [];
for (let index = 0; index < 8; index += 1) {
  const callSite = index < 6 ? "omObserve" : "omReflect";
  const result = await branchCall({
    sessionSnapshot: snapshot,
    callSite,
    requestContext: anchor.requestContext,
    steeringTail: `不要调用任何工具。${callSite === "omObserve" ? "提炼" : "反思"}长期观察；只输出一条短句。批次 ${index}`,
    thinking: false,
    maxTokens: 128,
  });
  omResults.push({ index, callSite, ok: result.ok, reason: result.ok ? null : result.reason });
}

await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
const usageRows = await getDocumentsClient().execute({
  sql: `SELECT call_site,
      SUM(cache_hit_tokens) AS hit,
      SUM(cache_miss_tokens) AS miss,
      COUNT(*) AS calls,
      SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing
    FROM llm_usage_events
    WHERE session_id = 's3-om-anchor'
    GROUP BY call_site ORDER BY call_site`,
  args: [],
});
const omHit = usageRows.rows.reduce((sum, row) => sum + Number(row.hit ?? 0), 0);
const omMiss = usageRows.rows.reduce((sum, row) => sum + Number(row.miss ?? 0), 0);
const offRate = cacheRate(mainOff);
const onRate = cacheRate(mainOn);
const artifact = {
  generatedAt: new Date().toISOString(),
  main: {
    offRate,
    onRate,
    relative: offRate > 0 ? onRate / offRate : 0,
    offUsage: mainOff.map((run) => run.usage),
    onUsage: mainOn.map((run) => run.usage),
  },
  om: {
    results: omResults,
    rows: usageRows.rows,
    cacheHitRate: omHit + omMiss > 0 ? omHit / (omHit + omMiss) : 0,
  },
};
await writeFile(resolve(outputDir, "s3-results.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

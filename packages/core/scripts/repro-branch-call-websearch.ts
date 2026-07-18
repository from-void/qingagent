import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { resolveEvalOutputDir } from "./evalOutputDir.js";

const outputDir = resolveEvalOutputDir({ envName: "QINGAGENT_EVAL_OUT_DIR", scriptName: "repro-branch-call-websearch" });
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));
const usageDbPath = resolve(outputDir, "websearch-repro-usage.db");
for (const suffix of ["", "-wal", "-shm"]) await rm(`${usageDbPath}${suffix}`, { force: true });
process.env.DATABASE_URL = `file:${usageDbPath}`;

const {
  beginSessionSnapshotTurn,
  branchCall,
  createSnapshottingQingagentModel,
  getSessionSnapshot,
} = await import("../src/llm/modelConfig.js");
const { getDocumentsClient } = await import("../src/db/documentsClient.js");
const { generateQuestions } = await import("../src/services/genService.js");

const sessionId = `repro-websearch-${Date.now()}`;
const requestContext = new RequestContext([
  ["sessionId", sessionId],
  ["streamId", `stream-${sessionId}`],
  ["runId", `run-${sessionId}`],
] as never) as RequestContext;
beginSessionSnapshotTurn(requestContext);

const model = createSnapshottingQingagentModel(requestContext);
const stableSystem = `你是测试助手。以下是稳定的产品规则前缀：${"写作前应先理解用户已有材料、目标读者、表达重点与发布场景。".repeat(160)}`;
const anchor = await model.doStream({
  prompt: [
    { role: "system", content: stableSystem },
    { role: "user", content: [{ type: "text", text: "搜索今天的科技新闻后准备写文章。" }] },
  ],
} as never);
for await (const _part of anchor.stream) {
  // 先让相同稳定前缀进入 provider cache，再复现含 tool 消息的捕获体。
}
let primeError: string | null = null;
try {
const result = await model.doStream({
  prompt: [
    { role: "system", content: stableSystem },
    { role: "user", content: [{ type: "text", text: "搜索今天的科技新闻后准备写文章。" }] },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call_websearch_repro_1",
        toolName: "webSearch",
        args: { query: "今天 科技 新闻" },
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_websearch_repro_1",
        toolName: "webSearch",
        output: {
          type: "json",
          value: { results: [{ title: "测试新闻", url: "https://example.com/news", snippet: "测试摘要" }] },
        },
      }],
    },
  ],
  tools: [{
    type: "function",
    name: "webSearch",
    description: "联网搜索",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }],
  toolChoice: { type: "auto" },
} as never);
for await (const _part of result.stream) {
  // 消费主链流，确保快照对应完整 tool-call/tool-result 前缀。
}
} catch (error) {
  const apiError = error as { statusCode?: number; responseBody?: string; message?: string };
  primeError = `HTTP ${apiError.statusCode ?? "unknown"}: ${apiError.responseBody ?? apiError.message ?? String(error)}`;
}

const snapshot = getSessionSnapshot(requestContext);
if (!snapshot) throw new Error("snapshot missing");
const startedAt = performance.now();
const deltas: Array<{ atMs: number; delta: string }> = [];
const replay = await branchCall({
  sessionSnapshot: snapshot,
  steeringTail: "不要调用任何工具。请输出一个含 2 个写作方向问题的 JSON 数组。",
  callSite: "reproBranch",
  requestContext,
  streamTextDeltas: true,
  onTextDelta: (delta) => {
    deltas.push({ atMs: Math.round(performance.now() - startedAt), delta });
  },
});
const progressStartedAt = performance.now();
const progressFrames: Array<{ atMs: number; questionCount: number }> = [];
const generated = await generateQuestions({
  mode: "initial",
  rationale: "确认科技新闻文章的方向",
  topic: "基于刚才 webSearch 的科技新闻结果写文章",
  requestContext,
  onProgress: (questions) => {
    progressFrames.push({
      atMs: Math.round(performance.now() - progressStartedAt),
      questionCount: questions.length,
    });
  },
});
await new Promise((resolveWait) => setTimeout(resolveWait, 300));
const usageRows = await getDocumentsClient().execute({
  sql: `SELECT input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, usage_state, reason
    FROM llm_usage_events WHERE session_id = ? AND call_site = 'reproBranch' ORDER BY created_at DESC LIMIT 1`,
  args: [sessionId],
});
const sourceBody = JSON.parse(snapshot.bodyText) as Record<string, unknown>;
const artifact = {
  generatedAt: new Date().toISOString(),
  primeError,
  elapsedMs: Math.round(performance.now() - startedAt),
  sourceMessages: sourceBody.messages,
  replay,
  deltas,
  usage: usageRows.rows[0] ?? null,
  genService: {
    transport: generated.transport,
    questionCount: generated.questions.length,
    elapsedMs: Math.round(performance.now() - progressStartedAt),
    progressFrames,
  },
};
await writeFile(resolve(outputDir, "websearch-repro.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ elapsedMs: artifact.elapsedMs, replay, deltas }, null, 2));

import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { resolveEvalOutputDir } from "./evalOutputDir.js";

const outputDir = resolveEvalOutputDir({ envName: "QINGAGENT_EVAL_OUT_DIR", scriptName: "eval-branch-call-s1" });
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));
const usageDbPath = resolve(outputDir, "s1-usage.db");
for (const suffix of ["", "-wal", "-shm"]) await rm(`${usageDbPath}${suffix}`, { force: true });
process.env.DATABASE_URL = `file:${usageDbPath}`;

const {
  beginSessionSnapshotTurn,
  branchCall,
  createSnapshottingQingagentModel,
  getSessionSnapshot,
} = await import("../src/llm/modelConfig.js");
const { buildSystemPrompt } = await import("../src/prompts/system.js");
const { generateQuestions } = await import("../src/services/genService.js");
const { getDocumentsClient } = await import("../src/db/documentsClient.js");

const topics = [
  "智能手表市场的深度分析，读者是消费电子从业者",
  "面向家长的青少年睡眠科普文章",
  "介绍城市更新项目的公众号推文",
  "给技术团队写一份 AI 编程规范说明",
];

function requestContext(sessionId: string): RequestContext {
  return new RequestContext([
    ["sessionId", sessionId],
    ["streamId", `stream-${sessionId}`],
    ["runId", `run-${sessionId}`],
  ] as never) as RequestContext;
}

function representativeTools() {
  return Array.from({ length: 37 }, (_, index) => ({
    type: "function" as const,
    name: index === 0 ? "planDraft" : `capability_${index}`,
    description: index === 0
      ? "为写作任务生成方向问卷并等待用户回答"
      : `产品能力工具 ${index}，仅在用户明确需要该能力时调用。`.repeat(4),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "用户请求" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  }));
}

async function primeSnapshot(sessionId: string, topic: string) {
  const context = requestContext(sessionId);
  beginSessionSnapshotTurn(context);
  let completed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4 && !completed; attempt += 1) {
    try {
      const model = createSnapshottingQingagentModel(context);
      const result = await model.doStream({
        prompt: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: [{
              type: "text",
              text: `这是主链缓存锚点。写作主题：${topic}。不要调用工具，只回复“已了解”。`,
            }],
          },
        ],
        tools: representativeTools(),
        toolChoice: { type: "auto" },
      } as never);
      const reader = result.stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      completed = true;
    } catch (error) {
      lastError = error;
      console.warn(`prime ${sessionId} 第 ${attempt}/4 次失败：${error instanceof Error ? error.message : String(error)}`);
      if (attempt < 4) await new Promise((resolveWait) => setTimeout(resolveWait, 1500 * attempt));
    }
  }
  if (!completed) throw lastError;
  const snapshot = getSessionSnapshot(context);
  if (!snapshot) throw new Error(`snapshot missing: ${sessionId}`);
  return { context, snapshot };
}

function validQuestions(
  questions: Awaited<ReturnType<typeof generateQuestions>>["questions"],
  mode: "initial" | "additional",
): boolean {
  const min = mode === "initial" ? 2 : 1;
  const max = mode === "initial" ? 4 : 3;
  if (questions.length < min || questions.length > max) return false;
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.id || ids.has(question.id) || !question.label.trim()) return false;
    ids.add(question.id);
    if (!["single", "multi", "text", "slider"].includes(question.kind)) return false;
    if ((question.kind === "single" || question.kind === "multi") && question.options.length === 0) return false;
    if ((question.kind === "text" || question.kind === "slider") && question.options.length !== 0) return false;
  }
  if (mode === "initial" && !questions.some((question) => question.kind === "text")) return false;
  return true;
}

const behaviorPrime = await primeSnapshot("s1-behavior", topics[0]!);
const behaviorRuns: Array<Record<string, unknown>> = [];
for (let index = 0; index < 10; index += 1) {
  const result = await branchCall({
    sessionSnapshot: behaviorPrime.snapshot,
    steeringTail:
      `不要调用任何工具。直接输出一个 JSON 数组，为“${topics[index % topics.length]}”生成 2 个写作方向问题；` +
      `每项包含 id、label、kind、options，至少一个 text 题。`,
    callSite: "planDraft",
    requestContext: behaviorPrime.context,
  });
  behaviorRuns.push({
    index,
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    attempts: result.attempts,
    toolCallRetries: result.toolCallRetries,
    text: result.ok ? result.text : null,
  });
}

const qualityRuns: Array<Record<string, unknown>> = [];
for (let index = 0; index < topics.length; index += 1) {
  const topic = topics[index]!;
  const sessionId = `s1-quality-new-${index}`;
  const prime = await primeSnapshot(sessionId, topic);
  const initial = await generateQuestions({
    mode: "initial",
    requestContext: prime.context,
    rationale: "在落稿前确认受众、侧重点、篇幅与补充要求",
    topic,
  });
  const additional = await generateQuestions({
    mode: "additional",
    requestContext: prime.context,
    conversationSummary: `用户要写：${topic}`,
    currentQuestions: initial.questions.map((question) => ({
      id: question.id,
      label: question.label,
      kind: { kind: question.kind },
      options: question.options,
    })),
    currentAnswers: {},
  });
  qualityRuns.push({
    mode: "new",
    topic,
    initial,
    additional,
    initialValid: validQuestions(initial.questions, "initial"),
    additionalValid: validQuestions(additional.questions, "additional"),
  });

  const old = await generateQuestions({
    mode: "initial",
    requestContext: requestContext(`s1-quality-old-${index}`),
    rationale: "在落稿前确认受众、侧重点、篇幅与补充要求",
    topic,
  });
  qualityRuns.push({ mode: "old", topic, result: old, valid: validQuestions(old.questions, "initial") });
}

await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
const client = getDocumentsClient();
const usage = await client.execute({
  sql: `SELECT session_id, call_site,
      SUM(cache_hit_tokens) AS hit,
      SUM(cache_miss_tokens) AS miss,
      COUNT(*) AS calls,
      SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing
    FROM llm_usage_events
    WHERE session_id LIKE 's1-behavior%' OR session_id LIKE 's1-quality-new-%'
    GROUP BY session_id, call_site ORDER BY session_id, call_site`,
  args: [],
});

const behaviorToolCallRuns = behaviorRuns.filter((run) => run.reason === "tool_call").length;
const behaviorRetryRuns = behaviorRuns.filter((run) => Number(run.toolCallRetries) > 0).length;
const newQuality = qualityRuns.filter((run) => run.mode === "new");
const oldQuality = qualityRuns.filter((run) => run.mode === "old");
const artifact = {
  generatedAt: new Date().toISOString(),
  behavior: {
    total: behaviorRuns.length,
    suppressedWithoutFinalToolCall: behaviorRuns.length - behaviorToolCallRuns,
    suppressionRate: (behaviorRuns.length - behaviorToolCallRuns) / behaviorRuns.length,
    retryTriggered: behaviorRetryRuns,
    retryTriggerRate: behaviorRetryRuns / behaviorRuns.length,
    finalFallbackRequired: behaviorToolCallRuns,
    runs: behaviorRuns,
  },
  quality: {
    newValid: newQuality.filter((run) => run.initialValid === true && run.additionalValid === true).length,
    newTotal: newQuality.length,
    oldValid: oldQuality.filter((run) => run.valid === true).length,
    oldTotal: oldQuality.length,
    runs: qualityRuns,
  },
  usage: usage.rows,
};
await writeFile(resolve(outputDir, "s1-results.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

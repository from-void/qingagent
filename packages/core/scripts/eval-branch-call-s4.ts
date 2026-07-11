import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { legacySectionsToPm } from "@qingagent/pm-schema";

const outputDir = resolve(
  process.env.BRANCH_CALL_EVAL_DIR ??
    "/home/jimmy/proj/qingagent-ops/evals/260712-branchcall",
);
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));
const usageDbPath = resolve(outputDir, "s4-usage.db");
for (const suffix of ["", "-wal", "-shm"]) await rm(`${usageDbPath}${suffix}`, { force: true });
process.env.DATABASE_URL = `file:${usageDbPath}`;

const {
  beginSessionSnapshotTurn,
  createSnapshottingQingagentModel,
} = await import("../src/llm/modelConfig.js");
const { buildSystemPrompt } = await import("../src/prompts/system.js");
const { createSession } = await import("../src/bridge/sessionState.js");
const { generateTitleAfterFirstDraft } = await import("../src/bridge/titleGeneration.js");
const { getDocumentsClient } = await import("../src/db/documentsClient.js");

function context(sessionId: string): RequestContext {
  return new RequestContext([
    ["sessionId", sessionId],
    ["streamId", `stream-${sessionId}`],
    ["runId", `run-${sessionId}`],
  ] as never) as RequestContext;
}

const sessionId = "s4-first-draft";
const requestContext = context(sessionId);
beginSessionSnapshotTurn(requestContext);
let primed = false;
let primeError: unknown;
for (let attempt = 1; attempt <= 4 && !primed; attempt += 1) {
  try {
    const model = createSnapshottingQingagentModel(requestContext);
    const result = await model.doStream({
      prompt: [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: [{
            type: "text",
            text: "请写一篇面向城市规划从业者的文章，讨论城市更新中的公共空间与社区共治。",
          }],
        },
      ],
      tools: [{
        type: "function",
        name: "writeDraft",
        description: "生成完整文稿",
        inputSchema: { type: "object", properties: {} },
      }],
      toolChoice: { type: "auto" },
    } as never);
    await result.stream.pipeTo(new WritableStream());
    primed = true;
  } catch (error) {
    primeError = error;
    if (attempt < 4) await new Promise((resolveWait) => setTimeout(resolveWait, 1500 * attempt));
  }
}
if (!primed) throw primeError;

const state = createSession(sessionId);
state.legacySections = [
  { id: "h1", kind: "h1", data: { text: "城市更新观察" } },
  { id: "p1", kind: "p", data: { text: "城市更新不只是空间改造，更是公共空间治理与社区协商机制的重建。" } },
  { id: "p2", kind: "p", data: { text: "规划从业者需要把居民参与纳入项目全周期，并建立可持续的共治框架。" } },
] as never;
state.doc = legacySectionsToPm(state.legacySections as never);
const title = await generateTitleAfterFirstDraft(state, requestContext);

await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
const rows = await getDocumentsClient().execute({
  sql: `SELECT session_id, call_site, usage_state, cache_hit_tokens, cache_miss_tokens
    FROM llm_usage_events WHERE call_site = 'generateTitle' ORDER BY created_at`,
  args: [],
});
const pureChatRows = rows.rows.filter((row) => row.session_id === "s4-pure-chat");
const artifact = {
  generatedAt: new Date().toISOString(),
  firstDraft: {
    title,
    reasonable: typeof title === "string" && title.length >= 4 && title.length <= 48,
    ledgerRows: rows.rows.filter((row) => row.session_id === sessionId),
  },
  pureChat: {
    title: "无题",
    generateTitleCalls: pureChatRows.length,
  },
};
await writeFile(resolve(outputDir, "s4-results.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

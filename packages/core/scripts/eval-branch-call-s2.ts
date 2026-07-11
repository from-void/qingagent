import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { RequestContext } from "@mastra/core/request-context";
import { pmToPlainText, type PmDoc } from "@qingagent/pm-schema";

const execFileAsync = promisify(execFile);
const outputDir = resolve(
  process.env.BRANCH_CALL_EVAL_DIR ??
    "/home/jimmy/proj/qingagent-ops/evals/260712-branchcall",
);
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));
const usageDbPath = resolve(outputDir, "s2-usage.db");
for (const suffix of ["", "-wal", "-shm"]) await rm(`${usageDbPath}${suffix}`, { force: true });
process.env.DATABASE_URL = `file:${usageDbPath}`;

const {
  beginSessionSnapshotTurn,
  createSnapshottingQingagentModel,
  getSessionSnapshot,
} = await import("../src/llm/modelConfig.js");
const { buildSystemPrompt } = await import("../src/prompts/system.js");
const { createWriteDraftTool } = await import("../src/tools/writeDraft.js");
const {
  compileAiDocumentWithBlockRetry,
  parseAiDocumentFromQingml,
} = await import("../src/tools/generateDoc.js");
const { streamInnerModel } = await import("../src/llm/innerModelStream.js");
const { createSession } = await import("../src/bridge/index.js");
const { getDocumentsClient } = await import("../src/db/documentsClient.js");

const sampleCount = 6;
const topic = "给技术团队写一份 AI 编程规范说明，面向全体研发，强调安全、审查流程和可执行检查清单";
const title = "团队 AI 编程规范";
const outline = [
  "说明适用范围与基本原则",
  "列出安全与隐私红线",
  "规定 AI 生成代码的人工审查、测试与合并流程",
  "以任务清单总结提交前检查项",
].join("；");
const targetLength = 800;
const acceptableMin = 720;
const acceptableMax = 880;

function context(sessionId: string): RequestContext {
  return new RequestContext([
    ["sessionId", sessionId],
    ["streamId", `stream-${sessionId}`],
    ["runId", `run-${sessionId}`],
    ["messages", [
      { role: "user", content: `请写：${topic}` },
      { role: "assistant", content: "方向已确认，准备生成草稿。" },
    ]],
  ] as never) as RequestContext;
}

function representativeTools() {
  return Array.from({ length: 37 }, (_, index) => ({
    type: "function" as const,
    name: index === 0 ? "writeDraft" : `capability_${index}`,
    description: index === 0
      ? "生成或重写完整草稿"
      : `产品能力工具 ${index}，仅在用户明确需要该能力时调用。`.repeat(4),
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  }));
}

async function primeSnapshot(requestContext: RequestContext): Promise<void> {
  beginSessionSnapshotTurn(requestContext);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await createSnapshottingQingagentModel(requestContext).doStream({
        prompt: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: [{ type: "text", text: `这是长会话写稿锚点。主题：${topic}。只回复“已了解”。` }] },
        ],
        tools: representativeTools(),
        toolChoice: { type: "auto" },
      } as never);
      const reader = result.stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      if (!getSessionSnapshot(requestContext)) throw new Error("snapshot missing");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 1500));
    }
  }
  throw lastError;
}

async function loadCommittedBaselinePrompt(materialContext = ""): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "show",
    "611b3e4:packages/core/src/tools/generateDoc.ts",
  ], { cwd: resolve("../.."), maxBuffer: 2 * 1024 * 1024 });
  const match = stdout.match(
    /export function buildQingmlPrompt\(materialContext: string\): string \{([\s\S]*?)\n\}\n\nexport function buildQingmlRetryUserPrompt/,
  );
  if (!match?.[1]) throw new Error("无法从 S1 提交提取旧 buildQingmlPrompt");
  const factory = new Function("materialContext", match[1]) as (value: string) => string;
  return factory(materialContext);
}

function finalInstruction(): string {
  return [
    `标题: ${title}`,
    `方向: ${outline}`,
    `长度规格: 正文约 ${targetLength} 字，允许区间 ${acceptableMin}-${acceptableMax} 字`,
    "写作时先按节分配字数预算再写。",
    "现在进入文档生成模式:只输出完整闭合的 QingML 标记。首字符必须是 <。不要输出解释或 markdown fence。",
  ].join("\n");
}

function validDoc(doc: PmDoc | null | undefined): boolean {
  if (!doc || doc.type !== "doc" || doc.content.length < 3) return false;
  const text = pmToPlainText(doc, { skipMedia: true }).trim();
  return text.includes("AI") && text.length > 0;
}

const newContext = context("s2-write-new-long");
await primeSnapshot(newContext);
const state = createSession("s2-write-new-long");
const tool = createWriteDraftTool({
  state,
  replaceDraftCandidateDoc: (sessionState, doc, legacySections) => {
    sessionState.docDraftCandidateDoc = doc;
    return legacySections ?? [];
  },
});
const newRuns: Array<Record<string, unknown>> = [];
for (let index = 0; index < sampleCount; index += 1) {
  const output = await (tool as { execute: (input: never, context: never) => Promise<Record<string, unknown>> }).execute({
    title,
    outline,
    lengthTarget: targetLength,
    lengthBound: "approx",
    intent: "express",
    styleHint: "正式、清晰、可执行，避免空泛口号",
  } as never, { requestContext: newContext } as never);
  const doc = state.docDraftCandidateDoc;
  const count = typeof output.visibleCharCount === "number" ? output.visibleCharCount : null;
  newRuns.push({
    index,
    ok: output.ok === true,
    valid: output.ok === true && validDoc(doc),
    count,
    lengthAccepted: typeof count === "number" && count >= acceptableMin && count <= acceptableMax,
    lengthStatus: output.lengthStatus ?? null,
    blockCount: Array.isArray(doc?.content) ? doc.content.length : 0,
  });
}

const baselinePrompt = await loadCommittedBaselinePrompt();
const oldRuns: Array<Record<string, unknown>> = [];
for (let index = 0; index < sampleCount; index += 1) {
  const oldContext = context(`s2-write-old-${index}`);
  const candidates = await Promise.all(Array.from({ length: 4 }, async (_, lane) => {
    try {
      const result = await streamInnerModel({
        requestContext: oldContext,
        callSite: "writeDraftBaseline",
        lane,
        system: baselinePrompt,
        prompt: finalInstruction(),
        thinking: false,
        temperature: 0.4,
        maxRetries: 2,
      });
      const parsed = parseAiDocumentFromQingml(result.raw, title);
      const compiled = await compileAiDocumentWithBlockRetry(parsed.document, undefined, 0);
      const doc = compiled.success ? compiled.doc : null;
      const count = doc ? pmToPlainText(doc, { skipMedia: true }).replace(/\s/g, "").length : null;
      return {
        lane,
        ok: compiled.success,
        valid: compiled.success && validDoc(doc),
        count,
        blockCount: doc?.content.length ?? 0,
        error: compiled.success ? null : compiled.error,
      };
    } catch (error) {
      return {
        lane,
        ok: false,
        valid: false,
        count: null,
        blockCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const legal = candidates.filter((candidate) => candidate.valid && typeof candidate.count === "number");
  const winner = legal.sort((left, right) => {
    const distance = (count: number) => count < acceptableMin
      ? acceptableMin - count
      : count > acceptableMax
        ? count - acceptableMax
        : 0;
    return distance(left.count as number) - distance(right.count as number);
  })[0];
  oldRuns.push({
    index,
    ok: !!winner,
    valid: !!winner,
    count: winner?.count ?? null,
    lengthAccepted: typeof winner?.count === "number" && winner.count >= acceptableMin && winner.count <= acceptableMax,
    blockCount: winner?.blockCount ?? 0,
    candidateValid: legal.length,
    candidateTotal: candidates.length,
    errors: candidates.filter((candidate) => candidate.error).map((candidate) => candidate.error),
  });
}

await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
const usage = await getDocumentsClient().execute({
  sql: `SELECT call_site,
      SUM(cache_hit_tokens) AS hit,
      SUM(cache_miss_tokens) AS miss,
      COUNT(*) AS calls,
      SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing
    FROM llm_usage_events
    WHERE session_id = 's2-write-new-long'
    GROUP BY call_site ORDER BY call_site`,
  args: [],
});
const writeUsage = usage.rows.find((row) => row.call_site === "writeDraft");
const hit = Number(writeUsage?.hit ?? 0);
const miss = Number(writeUsage?.miss ?? 0);
const artifact = {
  generatedAt: new Date().toISOString(),
  topic,
  sampleCount,
  quality: {
    new: {
      valid: newRuns.filter((run) => run.valid).length,
      lengthAccepted: newRuns.filter((run) => run.lengthAccepted).length,
      runs: newRuns,
    },
    old: {
      valid: oldRuns.filter((run) => run.valid).length,
      lengthAccepted: oldRuns.filter((run) => run.lengthAccepted).length,
      runs: oldRuns,
    },
  },
  usage: {
    rows: usage.rows,
    writeDraftCacheHitRate: hit + miss > 0 ? hit / (hit + miss) : 0,
  },
};
await writeFile(resolve(outputDir, "s2-results.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

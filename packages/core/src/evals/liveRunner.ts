import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTool } from "@mastra/core/tools";
import { runEvals } from "@mastra/core/evals";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import {
  askUserLiveNoReaskScorer,
  askUserLiveWriteDraftFollowthroughScorer,
  buildAskUserResumeMessages,
  extractAgentOutput,
  type AskUserActionOutput,
} from "./askUserScorers.js";
import { askUserTriggerFixtures, type AskUserTriggerFixture } from "./askUserTriggerFixtures.js";
import { askUserTriggerScorer, evaluateAskUserTriggerDecision } from "./askUserTriggerScorers.js";
import { isPlanDraftTool } from "../bridge/questionnaireTools.js";
import { askUserAnswerWordingFixtures } from "./fixtures.js";

export type LiveScorerArtifact = {
  timestamp: string;
  mode: "live-runevals";
  verdict: "ENV_SKIP" | "passed" | "scored" | "failed";
  error?: string;
  note?: string;
  summary?: { totalItems: number };
  scores?: Record<string, unknown>;
  thresholdResults?: unknown;
};

export interface AskUserTriggerEvalOptions {
  label?: string;
  outputRoot?: string;
  rawDir?: string;
  fixtureIds?: string[];
  repeat?: number;
  concurrency?: number;
  maxSteps?: number;
}

export interface AskUserTriggerCaseResult {
  key: string;
  id: string;
  repetition: number;
  category: string;
  message: string;
  expectedDecision: "ask" | "noAsk";
  requireWriteDraft: boolean;
  score: 0 | 1;
  actualToolNames: string[];
  asked: boolean;
  wroteDraft: boolean;
  askUserWasAlone: boolean;
  reason: string;
  textExcerpt: string;
}

export interface AskUserTriggerMetricBucket {
  category: string;
  total: number;
  passed: number;
  accuracy: number;
  expectedAskTotal: number;
  askRecall: number | null;
  expectedNoAskTotal: number;
  falsePositiveRate: number | null;
  directWriteTotal: number;
  directWriteAccuracy: number | null;
}

export interface AskUserTriggerMetrics {
  total: number;
  passed: number;
  accuracy: number;
  expectedAskTotal: number;
  askRecall: number | null;
  expectedNoAskTotal: number;
  falsePositiveRate: number | null;
  directWriteTotal: number;
  directWriteAccuracy: number | null;
  byCategory: AskUserTriggerMetricBucket[];
}

export type AskUserTriggerEvalArtifact =
  | {
      timestamp: string;
      mode: "live-askuser-trigger";
      label: string;
      verdict: "ENV_SKIP";
      error: string;
      note: string;
    }
  | {
      timestamp: string;
      mode: "live-askuser-trigger";
      label: string;
      verdict: "passed" | "scored" | "failed";
      rawDir: string;
      summary?: { totalItems: number };
      scores?: Record<string, unknown>;
      thresholdResults?: unknown;
      metrics: AskUserTriggerMetrics;
      cases: AskUserTriggerCaseResult[];
    };

function loadServerEnv(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), "packages/server/.env"), "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // .env 不存在时走 ENV_SKIP。
  }
}

function createWriteDraftEvalTool() {
  return createTool({
    id: "writeDraft",
    description: "生成或重写完整草稿,写入待审候选文档。live scorer 中这是无副作用测试桩。",
    inputSchema: z.object({
      title: z.string().optional(),
      outline: z.string().optional(),
      targetLength: z.number().optional(),
      styleHint: z.string().optional(),
    }).passthrough(),
    execute: async (input) => ({
      ok: true,
      kind: "evalWriteDraftAccepted",
      title: typeof input.title === "string" ? input.title : "",
    }),
  });
}

function liveEvalRequestContext(caseId: string): RequestContext {
  return new RequestContext([
    ["sessionId", `live-eval:${caseId}`],
    ["runId", `live-eval:${caseId}:${Date.now()}`],
    // runEvals 直接执行 agent.generate，不经过 bridge 的 step usage 记账。
    ["usageCallSite", "liveEval"],
  ] as never);
}

export async function runLiveScorers(): Promise<LiveScorerArtifact> {
  loadServerEnv();

  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      timestamp: new Date().toISOString(),
      mode: "live-runevals",
      verdict: "ENV_SKIP",
      error: "missing DEEPSEEK_API_KEY",
      note: "沿用 pm-model-smoke.ts 的 ENV_SKIP 语义:无 key 不失败,配置 key 后本脚本才硬验。",
    };
  }

  const writeDraftEvalTool = createWriteDraftEvalTool();

  const data = askUserAnswerWordingFixtures.slice(0, 2).map((fixture) => {
    if (!fixture.input) throw new Error(`missing askUser fixture input: ${fixture.id}`);
    return {
      input: buildAskUserResumeMessages(fixture.input),
      groundTruth: fixture.input,
      requestContext: liveEvalRequestContext(`answer-${fixture.id}`),
    };
  });

  const { mastra } = await import("../mastra.js");
  mastra.addScorer(askUserLiveNoReaskScorer);
  mastra.addScorer(askUserLiveWriteDraftFollowthroughScorer);
  const qingagentAgent = mastra.getAgent("qingagent");

  const result = await runEvals({
    target: qingagentAgent,
    data,
    scorers: [
      { scorer: askUserLiveNoReaskScorer, threshold: 1 },
      { scorer: askUserLiveWriteDraftFollowthroughScorer, threshold: 1 },
    ],
    targetOptions: {
      maxSteps: 8,
      modelSettings: { temperature: 0 },
      toolChoice: "auto",
      toolsets: {
        eval: {
          writeDraft: writeDraftEvalTool,
        },
      },
    },
    concurrency: 1,
  });

  return {
    timestamp: new Date().toISOString(),
    mode: "live-runevals",
    verdict: result.verdict ?? "scored",
    summary: result.summary,
    scores: result.scores,
    thresholdResults: result.thresholdResults,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walkUnknown(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walkUnknown(child, visit);
}

function extractToolCallSummaries(output: unknown): Array<{
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}> {
  const calls: Array<{ toolName: string; toolCallId?: string; args?: unknown }> = [];
  const seen = new Set<string>();
  walkUnknown(output, (record) => {
    if (record.type !== "tool-call" || !isRecord(record.payload)) return;
    const payload = record.payload;
    if (typeof payload.toolName !== "string") return;
    const summary = {
      toolName: payload.toolName,
      ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
      ...("args" in payload ? { args: payload.args } : {}),
    };
    const key = `${summary.toolName}:${summary.toolCallId ?? ""}:${JSON.stringify(summary.args ?? null)}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(summary);
  });
  return calls;
}

function extractStepToolNames(output: unknown): string[][] {
  if (!isRecord(output) || !Array.isArray(output.steps)) return [];
  return output.steps.map((step) => {
    if (!isRecord(step) || !Array.isArray(step.toolCalls)) return [];
    return step.toolCalls
      .map((call) => isRecord(call) && isRecord(call.payload) ? call.payload.toolName : undefined)
      .filter((name): name is string => typeof name === "string");
  });
}

function selectTargetOutputPayload(targetResult: unknown): unknown {
  if (isRecord(targetResult) && "output" in targetResult) return targetResult.output;
  return targetResult;
}

function addToolNameFromInvocation(value: unknown, toolNames: Set<string>): void {
  if (!isRecord(value)) return;
  if (typeof value.toolName === "string") {
    toolNames.add(value.toolName);
    return;
  }
  if (isRecord(value.toolInvocation) && typeof value.toolInvocation.toolName === "string") {
    toolNames.add(value.toolInvocation.toolName);
  }
}

function extractAssistantActionOutput(targetResult: unknown): AskUserActionOutput {
  const payload = selectTargetOutputPayload(targetResult);
  const texts: string[] = [];
  const toolNames = new Set<string>();

  const visitMessage = (message: unknown): void => {
    if (!isRecord(message)) return;
    if (typeof message.role === "string" && message.role !== "assistant") return;

    const content = message.content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (isRecord(content)) {
      if (Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (!isRecord(part)) continue;
          if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
          if (part.type === "tool-invocation") addToolNameFromInvocation(part, toolNames);
        }
      } else if (typeof content.content === "string") {
        texts.push(content.content);
      }
      if (Array.isArray(content.toolInvocations)) {
        for (const invocation of content.toolInvocations) addToolNameFromInvocation(invocation, toolNames);
      }
    }

    if (Array.isArray(message.toolInvocations)) {
      for (const invocation of message.toolInvocations) addToolNameFromInvocation(invocation, toolNames);
    }
  };

  if (Array.isArray(payload)) {
    for (const message of payload) visitMessage(message);
    return { toolNames: [...toolNames], text: texts.join("\n") };
  }

  if (isRecord(payload) && Array.isArray(payload.messages)) {
    for (const message of payload.messages) visitMessage(message);
    return { toolNames: [...toolNames], text: texts.join("\n") };
  }

  return extractAgentOutput(payload);
}

function selectAskUserTriggerFixtures(fixtureIds?: string[]): AskUserTriggerFixture[] {
  if (!fixtureIds || fixtureIds.length === 0) return askUserTriggerFixtures;
  const byId = new Map(askUserTriggerFixtures.map((fixture) => [fixture.id, fixture]));
  return fixtureIds.map((id) => {
    const fixture = byId.get(id);
    if (!fixture) throw new Error(`unknown askUser trigger fixture id: ${id}`);
    return fixture;
  });
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function computeAskUserTriggerMetrics(cases: AskUserTriggerCaseResult[]): AskUserTriggerMetrics {
  const total = cases.length;
  const passed = cases.filter((item) => item.score === 1).length;
  const askCases = cases.filter((item) => item.expectedDecision === "ask");
  const noAskCases = cases.filter((item) => item.expectedDecision === "noAsk");
  const directCases = noAskCases.filter((item) => item.requireWriteDraft);
  const categories = [...new Set(cases.map((item) => item.category))];

  return {
    total,
    passed,
    accuracy: rate(passed, total) ?? 0,
    expectedAskTotal: askCases.length,
    askRecall: rate(askCases.filter((item) => item.score === 1).length, askCases.length),
    expectedNoAskTotal: noAskCases.length,
    falsePositiveRate: rate(noAskCases.filter((item) => item.asked).length, noAskCases.length),
    directWriteTotal: directCases.length,
    directWriteAccuracy: rate(directCases.filter((item) => item.score === 1).length, directCases.length),
    byCategory: categories.map((category) => {
      const bucket = cases.filter((item) => item.category === category);
      const bucketAsk = bucket.filter((item) => item.expectedDecision === "ask");
      const bucketNoAsk = bucket.filter((item) => item.expectedDecision === "noAsk");
      const bucketDirect = bucketNoAsk.filter((item) => item.requireWriteDraft);
      const bucketPassed = bucket.filter((item) => item.score === 1).length;
      return {
        category,
        total: bucket.length,
        passed: bucketPassed,
        accuracy: rate(bucketPassed, bucket.length) ?? 0,
        expectedAskTotal: bucketAsk.length,
        askRecall: rate(bucketAsk.filter((item) => item.score === 1).length, bucketAsk.length),
        expectedNoAskTotal: bucketNoAsk.length,
        falsePositiveRate: rate(bucketNoAsk.filter((item) => item.asked).length, bucketNoAsk.length),
        directWriteTotal: bucketDirect.length,
        directWriteAccuracy: rate(bucketDirect.filter((item) => item.score === 1).length, bucketDirect.length),
      };
    }),
  };
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    typeof item === "bigint" ? item.toString() : item
  ), 2);
}

type AskUserTriggerGroundTruth = AskUserTriggerFixture & {
  repetition: number;
  caseKey: string;
};

export async function runAskUserTriggerEvals(
  options: AskUserTriggerEvalOptions = {},
): Promise<AskUserTriggerEvalArtifact> {
  loadServerEnv();

  const label = safePathSegment(options.label ?? "manual");
  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      timestamp: new Date().toISOString(),
      mode: "live-askuser-trigger",
      label,
      verdict: "ENV_SKIP",
      error: "missing DEEPSEEK_API_KEY",
      note: "沿用 live scorer 的 ENV_SKIP 语义:无 key 不失败,配置 key 后本脚本才硬验。",
    };
  }

  const selectedFixtures = selectAskUserTriggerFixtures(options.fixtureIds);
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const outputRoot = resolve(process.cwd(), options.outputRoot ?? "askuser-trigger-eval");
  const rawDir = options.rawDir
    ? resolve(process.cwd(), options.rawDir)
    : join(outputRoot, "raw", label);
  await mkdir(rawDir, { recursive: true });

  const data = selectedFixtures.flatMap((fixture) =>
    Array.from({ length: repeat }, (_, index) => {
      const repetition = index + 1;
      const caseKey = repeat === 1 ? fixture.id : `${fixture.id}__r${repetition}`;
      const groundTruth: AskUserTriggerGroundTruth = { ...fixture, repetition, caseKey };
      return {
        input: fixture.message,
        groundTruth,
        requestContext: liveEvalRequestContext(caseKey),
      };
    }),
  );

  const { mastra } = await import("../mastra.js");
  mastra.addScorer(askUserTriggerScorer);
  const qingagentAgent = mastra.getAgent("qingagent");
  const caseResults: AskUserTriggerCaseResult[] = [];

  const result = await runEvals({
    target: qingagentAgent,
    data,
    scorers: [{ scorer: askUserTriggerScorer, threshold: 1 }],
    targetOptions: {
      maxSteps: options.maxSteps ?? 1,
      modelSettings: { temperature: 0 },
      toolChoice: "auto",
      toolsets: {
        eval: {
          writeDraft: createWriteDraftEvalTool(),
        },
      },
      hooks: {
        beforeToolCall: ({ toolName, input }: { toolName: string; input: unknown }) => {
          if (isPlanDraftTool(toolName)) {
            return {
              proceed: false,
              output: {
                ok: true,
                kind: "evalAskUserAccepted",
                input,
              },
            };
          }
          if (toolName === "writeDraft") {
            return {
              proceed: false,
              output: {
                ok: true,
                kind: "evalWriteDraftAccepted",
                input,
              },
            };
          }
        },
      },
    },
    concurrency: options.concurrency ?? 1,
    onItemComplete: async (event: {
      item: { groundTruth?: unknown };
      targetResult: unknown;
      scorerResults?: unknown;
    }) => {
      const fixture = event.item.groundTruth as AskUserTriggerGroundTruth | undefined;
      if (!fixture) return;
      const assistantPayload = selectTargetOutputPayload(event.targetResult);
      const output = extractAssistantActionOutput(event.targetResult);
      const evaluation = evaluateAskUserTriggerDecision(fixture, output);
      const caseResult: AskUserTriggerCaseResult = {
        key: fixture.caseKey,
        id: fixture.id,
        repetition: fixture.repetition,
        category: fixture.category,
        message: fixture.message,
        expectedDecision: fixture.expectedDecision,
        requireWriteDraft: fixture.requireWriteDraft === true,
        score: evaluation.score,
        actualToolNames: evaluation.actualToolNames,
        asked: evaluation.asked,
        wroteDraft: evaluation.wroteDraft,
        askUserWasAlone: evaluation.askUserWasAlone,
        reason: evaluation.reason,
        textExcerpt: evaluation.textExcerpt,
      };
      caseResults.push(caseResult);
      await writeFile(
        join(rawDir, `${fixture.caseKey}.json`),
        jsonStringify({
          timestamp: new Date().toISOString(),
          fixture,
          score: evaluation.score,
          reason: evaluation.reason,
          output,
          stepToolNames: extractStepToolNames(event.targetResult),
          toolCalls: extractToolCallSummaries(assistantPayload),
        }),
        "utf8",
      );
    },
  });

  caseResults.sort((a, b) => a.key.localeCompare(b.key));
  return {
    timestamp: new Date().toISOString(),
    mode: "live-askuser-trigger",
    label,
    verdict: result.verdict ?? (caseResults.every((item) => item.score === 1) ? "passed" : "scored"),
    rawDir,
    summary: result.summary,
    scores: result.scores,
    thresholdResults: result.thresholdResults,
    metrics: computeAskUserTriggerMetrics(caseResults),
    cases: caseResults,
  };
}

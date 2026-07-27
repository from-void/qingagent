import { createTool } from "@mastra/core/tools";
import {
  detectNestedListIntent,
  pmDocHasNestedList,
  pmToPlainText,
  type PmDoc,
} from "@qingagent/pm-schema";
import { z } from "zod";
import type { LegacySection } from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";
import {
  assertTurnWriteAllowed,
  captureTurnWriteGuard,
  type TurnWriteGuard,
} from "../session/turnOwnership.js";
import {
  DRAFT_MUTATION_CONFLICT_ERROR,
  DraftMutationConflictError,
  currentDraftMutationRevision,
} from "../doc-engine/draftScratch.js";
import type { Material } from "../types/material.js";
import { startInnerLlmSpan } from "../observability/innerLlmSpan.js";
import {
  buildQingmlSteeringTail,
  compileAiDocumentWithBlockRetry,
  isLengthTruncatedFinishReason,
  materialContextFrom,
  parseAiDocumentFromQingml,
} from "./generateDoc.js";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";
import {
  countByUnit,
  countVisibleChars,
  describeLengthSpec,
  getLengthStatus,
  makeLengthSpec,
  withinSpec,
  type LengthSpec,
} from "../utils/lengthSpec.js";
import { aiIrStreamPreviewFromMarkup, tailExcerpt, headExcerpt } from "../utils/aiIrStreamPreview.js";
import {
  resolveModelId,
  resolveModelTier,
  type DeepseekTier,
} from "../llm/modelConfig.js";
import { streamInnerModel } from "../llm/innerModelStream.js";
import { writeDraftInputSchema } from "../llm/draftToolSchemas.js";
import { startToolHeartbeat, writeToolStreamChunk } from "./toolHeartbeat.js";
import {
  autoActivateDiagramVizSkillForWrite,
} from "../skills/diagramViz.js";
import { buildActivatedSkillWriteInject } from "../skills/writeInject.js";

export { writeDraftInputSchema };

// 按复杂整稿/大图的最大合理需求取约 2 倍余量；同时作为复读跑飞保险丝。
// deepseek-v4-flash 实测上限为 393216，无需把单路预算直接吃满。
const WRITE_DRAFT_MAX_TOKENS = 65_536;

export const writeDraftOutputSchema = z.object({
  ok: z.boolean(),
  blockCount: z.number().optional(),
  /** 最终正文可见字符数(兼容旧字段名)。 */
  wordCount: z.number().optional(),
  visibleCharCount: z.number().optional(),
  targetLength: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  /** 首轮生成的字数(修订前)。 */
  firstVisibleCharCount: z.number().optional(),
  /** 工具内自动修订轮数。 */
  revisionCount: z.number().optional(),
  /** 完成卡的正文开头预览(直播/历史重开都展示,不依赖客户端临时态)。 */
  previewExcerpt: z.string().optional(),
  lengthStatus: z
    .enum([
      "not_requested",
      "accepted_first_pass",
      "accepted_after_revision",
      "accepted_with_soft_warning",
      "below_min",
      "above_hard_max",
      "near_after_revision",
      "failed_after_revision",
    ])
    .optional(),
  warning: z.string().optional(),
  nestedListReachedDepth: z.boolean().optional(),
  structuralFailures: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type WriteDraftOutput = z.infer<typeof writeDraftOutputSchema>;

function pickMaterials(
  materials: Map<string, Material> | undefined,
  ids: readonly string[] | undefined,
): Map<string, Material> | undefined {
  if (!materials || !ids || ids.length === 0) return materials;
  const selected = new Map<string, Material>();
  for (const id of ids) {
    const material = materials.get(id);
    if (material) selected.set(id, material);
  }
  return selected;
}

type CompiledAiDocument = Awaited<ReturnType<typeof compileAiDocumentWithBlockRetry>>;
type ParsedAiDocument = ReturnType<typeof parseAiDocumentFromQingml>["document"];

/** 离验收区间的距离(区间内为 0),best-of 候选挑选用。 */
function distanceToSpec(count: number, spec: LengthSpec): number {
  switch (spec.bound) {
    case "min":
      if (count < spec.min) return spec.min - count;
      return typeof spec.softMax === "number" && count > spec.softMax ? count - spec.softMax : 0;
    case "max":
      if (typeof spec.max === "number" && count > spec.max) return count - spec.max;
      return count < spec.min ? spec.min - count : 0;
    case "exact":
    case "approx":
    default:
      if (count < spec.min) return spec.min - count;
      if (typeof spec.max === "number" && count > spec.max) return count - spec.max;
      return 0;
  }
}

type DraftIntent = z.infer<typeof writeDraftInputSchema>["intent"];

interface RunConfig {
  intent: DraftIntent;
  thinking: boolean;
  temperature: number;
  schedule: "fast" | "budgeted";
}

interface ReasonBudget {
  outputMs: number;
  thinkMs: number;
  totalMs: number;
  thinkEffectiveMs: number;
}

// express 温度:验收实测 AI-IR JSON 坏率 temp0=0% / 0.4≈2% / 0.5=4% / 0.7=12%。
// 取 0.4 兼顾"创作发散"与 JSON 稳定;语法随机错由一轮 4 路赛马与解析修复吸收。
const EXPRESS_TEMPERATURE = 0.4;
const REASON_TEMPERATURE = 0.3;
const REASON_HEARTBEAT_MS = 7_500;
const REASON_BUDGET_MAX_MS = 75_000;
const PRO_REASON_BUDGET_MULTIPLIER = 3;
const RACE_ABORT_SETTLE_GRACE_MS = 250;

function runConfigForIntent(intent: DraftIntent): RunConfig {
  return intent === "reason"
    ? { intent, thinking: true, temperature: REASON_TEMPERATURE, schedule: "budgeted" }
    : { intent: "express", thinking: false, temperature: EXPRESS_TEMPERATURE, schedule: "fast" };
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function reasonBudgetMultiplier(tier: DeepseekTier): number {
  return tier === "pro" ? PRO_REASON_BUDGET_MULTIPLIER : 1;
}

function makeReasonBudget(target: number, tier: DeepseekTier = "flash"): ReasonBudget {
  const targetUnits = Math.max(1, Math.ceil(target / 1000));
  const multiplier = reasonBudgetMultiplier(tier);
  const outputMs = Math.round(clampMs(targetUnits * 6_000, 10_000, 25_000) * multiplier);
  const thinkMs = Math.round(clampMs(targetUnits * 12_000, 15_000, 50_000) * multiplier);
  const totalMs = Math.min(thinkMs + outputMs, Math.round(REASON_BUDGET_MAX_MS * multiplier));
  return {
    outputMs,
    thinkMs,
    totalMs,
    thinkEffectiveMs: totalMs - outputMs,
  };
}

function createLinkedAbortController(parent?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  if (!parent) return { controller, cleanup: () => undefined };

  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abort();
    return { controller, cleanup: () => undefined };
  }

  parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => parent.removeEventListener("abort", abort),
  };
}

async function waitForRaceTasksToSettle(tasks: readonly Promise<unknown>[]): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, RACE_ABORT_SETTLE_GRACE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type DraftChatMessage = { role: "system" | "user" | "assistant"; content: string };

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeConversationMessages(messages: unknown): DraftChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: DraftChatMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const content = contentText(record.content).trim();
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function buildWriteDraftFinalInstruction(
  input: z.infer<typeof writeDraftInputSchema>,
  lengthSpec: LengthSpec | null,
): string {
  return [
    `标题: ${input.title}`,
    `方向: ${input.outline}`,
    lengthSpec
      ? [
          `长度规格:`,
          `- ${describeLengthSpec(lengthSpec)}`,
          `- 优先级: 硬约束;与章节结构或素材覆盖冲突时字数优先,合并/概述低优先级内容`,
          `- 写作时先按节分配字数预算再写`,
          `- 剧本同样必须服从该范围;超限时先压缩重复动作、说明与台词,不得以排版或情节完整为由突破上限`,
        ].join("\n")
      : "",
    input.styleHint ? `风格: ${input.styleHint}` : "",
    `请充分吸收以上对话中用户提出的所有具体要求。`,
    `逐行拆分或改写用户给出的诗词、歌词、剧本时,原文每个空行必须在原位输出为空 <p></p>,不得吞并。`,
    `现在进入文档生成模式:只输出完整闭合的 QingML 标记。首字符必须是 <。不要输出确认、解释、markdown fence 或收尾总结。`,
  ].filter(Boolean).join("\n");
}

function buildDraftMessages(
  conversationMessages: unknown,
  finalInstruction: string,
  systemPrompt: string,
): DraftChatMessage[] {
  const history = normalizeConversationMessages(conversationMessages)
    .filter((message) => message.role !== "system");
  return [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: finalInstruction },
  ];
}

function failureKindFromError(error: unknown, finishReason: string | null | undefined): string {
  if (isLengthTruncatedFinishReason(finishReason)) return "length_truncated";
  if (error && typeof error === "object" && "diagnostics" in error) {
    const diagnostics = (error as { diagnostics?: { failureKind?: string } }).diagnostics;
    if (diagnostics?.failureKind) return diagnostics.failureKind;
  }
  const message = error instanceof Error ? error.message : String(error);
  // 时间预算/abort:lane 被 thinkTimer/hardTimer 掐(reason 预算超时)或通用 AbortError。
  // 归到明确 kind,与真 QingML 结构错(compile_failed)区分,避免报错甩锅"QingML 校验失败"。
  if (error instanceof Error && error.name === "AbortError") return "reason_budget_exceeded";
  if (/budget exceeded|\baborted\b/i.test(message)) return "reason_budget_exceeded";
  if (/Unexpected end|end of JSON|Expected ',' or ']'|Expected ',' or '}'/i.test(message)) return "unclosed_brackets";
  if (/property value|after property|unterminated string|bad control character/i.test(message)) return "unescaped_quote";
  return "unknown";
}

function tallyFailureKinds(kinds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of kinds) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

export function createWriteDraftTool(opts: {
  state: SessionState;
  replaceDraftCandidateDoc: (
    state: SessionState,
    doc: PmDoc,
    legacySections: LegacySection[] | undefined,
    writeGuard: TurnWriteGuard,
    expectedMutationRevision: number,
  ) => LegacySection[];
}) {
  return createTool({
    id: "writeDraft",
    description:
      "生成或重写完整草稿,写入待审候选文档。不要在聊天里输出正文 JSON。\n" +
      "把已有正文整理/重构/转换成两级或三级嵌套列表时,先 readDraft 取目标块,再用 editDraft action:\"replaceBlock\" 把这些块重写成 children 递归的嵌套列表,尽量逐字保留原文。",
    inputSchema: writeDraftInputSchema,
    outputSchema: writeDraftOutputSchema,
    execute: async (input, context): Promise<WriteDraftOutput> => {
      const writeGuard = captureTurnWriteGuard(opts.state, context);
      assertTurnWriteAllowed(opts.state, writeGuard);
      const expectedMutationRevision =
        currentDraftMutationRevision(opts.state);
      const stopHeartbeat = startToolHeartbeat(context, { tool: "writeDraft" });
      try {
      const materials = context?.requestContext?.get("materials") as Map<string, Material> | undefined;
      const messages = context?.requestContext?.get("messages");
      const selectedMaterials = pickMaterials(materials, input.basedOnMaterialIds);
      const materialRelevanceText = [
        context?.requestContext?.get("userText"),
        input.title,
        input.outline,
        input.styleHint,
      ].filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      ).join("\n");
      const materialContext = materialContextFrom(selectedMaterials, {
        relevanceText: materialRelevanceText,
      });
      // 长度意图规格化:四种 bound 语义 + 统一计数口径,见 utils/lengthSpec.ts
      const lengthSpec = makeLengthSpec(input);
      const userPrompt = buildWriteDraftFinalInstruction(input, lengthSpec);
      const diagramActivationHint = [
        context?.requestContext?.get("userText"),
        input.title,
        input.outline,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
      // 外层模型忘调技能时静默补激活；只恢复规范注入，不阻断本次写稿。
      autoActivateDiagramVizSkillForWrite(
        context?.requestContext,
        diagramActivationHint,
      );
      const diagramHint = [
        diagramActivationHint,
        input.styleHint,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
      // 技能载荷只组装一次，再由四条 lane 共用，避免重复读取与重复付费。
      const skillWriteInject = await buildActivatedSkillWriteInject({
        requestContext: context?.requestContext,
        hintText: diagramHint,
      });
      const steeringTail = buildQingmlSteeringTail(
        materialContext,
        userPrompt,
        skillWriteInject.content,
      );
      const draftMessages = buildDraftMessages(messages, steeringTail, AIIR_SYSTEM_PROMPT);
      const runConfig = runConfigForIntent(input.intent ?? "express");
      const nestedIntent = detectNestedListIntent(diagramHint);

      // 写稿小卡片:生成期间只镜像一条展示 lane。首个吐正文的 lane 获得展示权,
      // 后续保持粘滞;展示 lane 死亡才切到存活 lane 里当前字数最多者。
      const writer = (
        context as
          | { writer?: { write: (chunk: Record<string, unknown>) => Promise<unknown> | unknown } }
          | undefined
      )?.writer;
      type ProgressPhase = "writing" | "revising" | "finalizing" | "failed";
      type LaneProgressState = {
        key: number;
        raw: string;
        charCount: number;
        alive: boolean;
        contentStarted: boolean;
      };
      const laneProgress = new Map<number, LaneProgressState>();
      let displayLaneKey: number | null = null;
      let lastEmitAt = 0;
      let lastEmitChars = 0;
      let lastEmitPhase: string | null = null;
      let progressWriteChain: Promise<unknown> = Promise.resolve();
      const writeProgress = (progress: Record<string, unknown>) => {
        if (!writer) return Promise.resolve();
        progressWriteChain = writeToolStreamChunk(writer, {
          type: "writedraft-progress",
          progress,
        }).catch(() => undefined);
        return progressWriteChain;
      };
      const laneState = (laneKey: number): LaneProgressState => {
        const existing = laneProgress.get(laneKey);
        if (existing) return existing;
        const created: LaneProgressState = {
          key: laneKey,
          raw: "",
          charCount: 0,
          alive: true,
          contentStarted: false,
        };
        laneProgress.set(laneKey, created);
        return created;
      };
      const updateLaneRaw = (laneKey: number, raw: string) => {
        const lane = laneState(laneKey);
        lane.raw = raw;
        lane.charCount = countVisibleChars(aiIrStreamPreviewFromMarkup(raw));
        if (lane.charCount > 0) {
          lane.contentStarted = true;
          if (displayLaneKey === null) displayLaneKey = laneKey;
        }
      };
      const selectAliveLeadLane = (): LaneProgressState | null => {
        let selected: LaneProgressState | null = null;
        for (const lane of laneProgress.values()) {
          if (!lane.alive) continue;
          if (!lane.contentStarted && lane.charCount <= 0) continue;
          if (!selected || lane.charCount > selected.charCount) selected = lane;
        }
        return selected;
      };
      const currentDisplayLane = (): LaneProgressState | null => {
        if (displayLaneKey !== null) {
          const lane = laneProgress.get(displayLaneKey);
          if (lane?.alive) return lane;
        }
        const next = selectAliveLeadLane();
        displayLaneKey = next?.key ?? null;
        return next;
      };
      const emitProgress = (
        phase: ProgressPhase,
        rawSoFar: string,
        revisionCount: number,
        force = false,
        fullExcerpt = false,
      ) => {
        const text = aiIrStreamPreviewFromMarkup(rawSoFar);
        const charCount = countVisibleChars(text);
        const now = Date.now();
        // 相位切换强制发并复位计数;否则按 200ms 或 24 字节流。
        const phaseChanged = phase !== lastEmitPhase;
        const firstVisibleContent = lastEmitChars === 0 && charCount > 0;
        if (!force && !phaseChanged && !firstVisibleContent && now - lastEmitAt < 200 && charCount - lastEmitChars < 24) return;
        lastEmitPhase = phase;
        lastEmitAt = now;
        lastEmitChars = charCount;
        return writeProgress({
          title: input.title,
          phase,
          charCount,
          excerpt: phase === "failed" ? null : fullExcerpt ? text : tailExcerpt(text, 220),
          targetLength: lengthSpec?.target ?? null,
          minLength: lengthSpec?.min ?? null,
          maxLength: lengthSpec?.max ?? null,
          revisionCount,
          lengthStatus: null,
        });
      };
      const emitDisplayProgress = (force = false, phase: ProgressPhase = "writing") => {
        const displayLane = currentDisplayLane();
        return emitProgress(phase, displayLane?.raw ?? "", 0, force);
      };
      const markLaneDead = (laneKey: number) => {
        const lane = laneProgress.get(laneKey);
        if (!lane) return;
        lane.alive = false;
        if (displayLaneKey !== laneKey) return;
        const next = selectAliveLeadLane();
        displayLaneKey = next?.key ?? null;
        if (next) void emitProgress("writing", next.raw, 0, true);
      };
      const emitWinnerFrame = (winnerLaneKey: number, raw: string, revisionCount: number) => {
        const previousDisplay = displayLaneKey;
        updateLaneRaw(winnerLaneKey, raw);
        displayLaneKey = winnerLaneKey;
        return emitProgress("finalizing", raw, revisionCount, previousDisplay !== winnerLaneKey, true);
      };
      const emitFailureFrame = () => {
        const displayLane = currentDisplayLane();
        return emitProgress("failed", displayLane?.raw ?? "", 0, true);
      };
      // 赛道流结束(候选已产出)后交出展示权:该赛道字数若脱靶,赛马还要等其余路,
      // 展示若继续钉在它身上,前端会呈现"打完了却卡住不动"的缺漏观感(260726 用户报障)。
      // 有别的活口在写就切过去(与赛道死亡同语义);没有就保持现内容,避免闪空。
      // 若该候选最终胜出,emitWinnerFrame 会重新锁定并整帧覆盖。
      const settleLaneDisplay = (laneKey: number) => {
        const lane = laneProgress.get(laneKey);
        if (!lane) return;
        lane.alive = false;
        if (displayLaneKey !== laneKey) return;
        const next = selectAliveLeadLane();
        if (!next) return;
        displayLaneKey = next.key;
        void emitProgress("writing", next.raw, 0, true);
      };

      // ---- 赛马式生成:固定一轮 4 路并发,不因字数脱靶加赛;全废快速返回让 agent 重调工具。----
      // 字数未满足硬边界也如实交稿(lengthStatus 标 below_min/above_hard_max),由外层模型用 editDraft
      // 局部增删逼近——工具内不再做串行修订轮(被赛马取代,避免三段串行延迟)。
      const raceLanes = 4;
      const raceRounds = 1;

      type DraftCandidate = {
        laneKey: number;
        document: ParsedAiDocument;
        doc: PmDoc;
        legacySections: LegacySection[] | undefined;
        count: number;
        raw: string;
        kind: "express" | "fallback" | "refinement";
      };
      const candidates: DraftCandidate[] = [];
      const failureKinds: string[] = [];
      const activeModelTier = resolveModelTier(context?.requestContext);
      const activeModelId = resolveModelId(context?.requestContext, "flash");
      const countOf = (doc: PmDoc) =>
        // 字数/长度验收只算正文文字:跳过图片/图表/附件等媒体节点(与右下角落款 countDocVisibleChars 同口径)
        countByUnit(pmToPlainText(doc, { skipMedia: true }), lengthSpec?.unit ?? "withPunct");

      /** 单路生成:一次内层调用+解析编译,失败返回 null(其余路兜着)。 */
      const runLane = async (params: {
        roundIdx: number;
        laneIdx: number;
        prompt: string;
        thinking: boolean;
        temperature: number;
        kind: DraftCandidate["kind"];
        abortSignal?: AbortSignal;
        onContentStart?: () => void;
      }): Promise<DraftCandidate | null> => {
        const laneKey = params.roundIdx * raceLanes + params.laneIdx;
        const innerSpan = startInnerLlmSpan({
          name: "inner_llm:writeDraft",
          sessionId: opts.state.sessionId,
          clientTraceId: opts.state.clientTraceId ?? null,
          streamId: (context?.requestContext?.get("streamId") as string | null | undefined) ?? opts.state.streamId,
          runId: (context?.requestContext?.get("runId") as string | null | undefined) ?? opts.state.runId,
          origin: opts.state.origin ?? "manual",
          toolName: "writeDraft",
          toolCallId: context?.agent?.toolCallId ?? null,
          modelName: activeModelId,
          system: AIIR_SYSTEM_PROMPT,
          user: params.prompt,
          attempt: laneKey + 1,
          maxAttempts: raceLanes * raceRounds,
        });
        let raw = "";
        let finishReason: string | null = null;
        try {
          laneState(laneKey);
          await emitDisplayProgress(false, params.roundIdx > 0 ? "revising" : "writing");
          const result = await streamInnerModel({
            requestContext: context?.requestContext,
            callSite: "writeDraft",
            lane: laneKey,
            tier: "flash",
            messages: draftMessages,
            branchSteeringTail: buildQingmlSteeringTail(
              materialContext,
              params.prompt,
              skillWriteInject.content,
            ),
            // 真流式:delta 只进内存赛道状态 + 整帧替换的展示进度,候选文档仅由完整 result.raw 构建,
            // 判废降级重跑最多表现为进度回退,无落库风险。
            liveTextDeltas: true,
            thinking: params.thinking,
            temperature: params.temperature,
            abortSignal: params.abortSignal,
            maxRetries: 2,
            maxTokens: WRITE_DRAFT_MAX_TOKENS,
            onContentStart: params.onContentStart,
            onContentDelta: (_delta, currentRaw) => {
              raw = currentRaw;
              updateLaneRaw(laneKey, raw);
              if (displayLaneKey === laneKey) void emitDisplayProgress(false, params.roundIdx > 0 ? "revising" : "writing");
            },
          });
          raw = result.raw;
          finishReason = result.finishReason;
          updateLaneRaw(laneKey, raw);
          if (displayLaneKey === laneKey) await emitDisplayProgress(true, params.roundIdx > 0 ? "revising" : "writing");
          if (isLengthTruncatedFinishReason(finishReason)) {
            failureKinds.push("length_truncated");
            innerSpan.end({
              ok: false,
              outputText: raw,
              error: `length_truncated: finishReason=${finishReason}`,
            });
            markLaneDead(laneKey);
            return null;
          }
          const parsed = parseAiDocumentFromQingml(raw, input.title);
          const document = parsed.document;
          const compiled = await compileAiDocumentWithBlockRetry(document, undefined, 0);
          if (!compiled.success || !compiled.doc) {
            failureKinds.push("compile_failed");
            innerSpan.end({ ok: false, outputText: raw, error: `compile_failed: ${compiled.error ?? "AI-IR 编译失败"}` });
            markLaneDead(laneKey);
            return null;
          }
          innerSpan.end({ ok: true, outputText: raw });
          const candidate: DraftCandidate = {
            laneKey,
            document,
            doc: compiled.doc,
            legacySections: compiled.legacySections,
            count: countOf(compiled.doc),
            raw,
            kind: params.kind,
          };
          // 达标候选会当场胜出并由 emitWinnerFrame 锁定展示,不移交(避免闪别家文本);
          // 脱靶候选要等其余赛道,交出展示权让前端继续看到"还在写"。
          if (!isStopWorthyCandidate(candidate)) settleLaneDisplay(laneKey);
          return candidate;
        } catch (error) {
          const failureKind = failureKindFromError(error, finishReason);
          failureKinds.push(failureKind);
          innerSpan.end({ ok: false, outputText: raw, error: `${failureKind}: ${error instanceof Error ? error.message : String(error)}` });
          markLaneDead(laneKey);
          return null;
        }
      };

      const bestOf = (pool: readonly DraftCandidate[]): DraftCandidate | null => {
        if (pool.length === 0) return null;
        if (!lengthSpec) return pool[0]!;
        return pool.reduce((a, b) =>
          distanceToSpec(b.count, lengthSpec) <= distanceToSpec(a.count, lengthSpec) ? b : a,
        );
      };
      const reachesNestedDepth = (candidate: DraftCandidate): boolean =>
        !nestedIntent.wantsNestedList || pmDocHasNestedList(candidate.doc, nestedIntent.minDepth);
      const bestStructurallyAware = (pool: readonly DraftCandidate[]): DraftCandidate | null => {
        if (!nestedIntent.wantsNestedList) return bestOf(pool);
        const structurallyValid = pool.filter(reachesNestedDepth);
        return structurallyValid.length > 0 ? bestOf(structurallyValid) : bestOf(pool);
      };
      const isStopWorthyCandidate = (candidate: DraftCandidate): boolean => {
        if (!reachesNestedDepth(candidate)) return false;
        if (runConfig.schedule === "budgeted" && candidate.kind !== "refinement") return false;
        return lengthSpec ? withinSpec(candidate.count, lengthSpec) : true;
      };

      let firstRoundBestCount: number | null = null;
      const extraRoundsUsed = 0;
      let reasonRefinementCount = 0;

      const laneStates = Array.from({ length: raceLanes }, (_, lane) => {
        const linked = createLinkedAbortController(context?.abortSignal);
        return {
          lane,
          contentStarted: false,
          controller: linked.controller,
          cleanup: linked.cleanup,
        };
      });
      let finished = 0;
      let resolved = false;
      let acceptedLane: number | null = null;
      let acceptedCandidate: DraftCandidate | null = null;
      let resolveRace!: () => void;
      const raceDone = new Promise<void>((resolve) => {
        resolveRace = resolve;
      });
      const finishRace = () => {
        if (resolved) return;
        resolved = true;
        if (acceptedLane !== null) abortOtherLanes(acceptedLane);
        resolveRace();
      };
      const abortOtherLanes = (winnerLane: number) => {
        for (const lane of laneStates) {
          if (lane.lane === winnerLane || lane.controller.signal.aborted) continue;
          lane.controller.abort(new Error("writeDraft accepted candidate; cancelling slower lane"));
        }
      };
      const acceptCandidate = async (candidate: DraftCandidate) => {
        if (acceptedCandidate) return;
        acceptedCandidate = candidate;
        acceptedLane = candidate.laneKey;
        await emitWinnerFrame(candidate.laneKey, candidate.raw, candidate.kind === "refinement" ? 1 : 0);
        finishRace();
      };

      const budget = runConfig.schedule === "budgeted"
        ? makeReasonBudget(lengthSpec?.target ?? 1000, activeModelTier)
        : null;
      const heartbeat = runConfig.schedule === "budgeted"
        ? setInterval(() => {
            void emitDisplayProgress(true);
          }, REASON_HEARTBEAT_MS)
        : null;
      const thinkTimer = budget
        ? setTimeout(() => {
            for (const lane of laneStates.slice(1)) {
              if (!lane.contentStarted && !lane.controller.signal.aborted) {
                lane.controller.abort(new Error("reason thinking budget exceeded"));
              }
            }
          }, budget.thinkEffectiveMs)
        : null;
      const hardTimer = budget
        ? setTimeout(() => {
            for (const lane of laneStates) {
              if (!lane.controller.signal.aborted) {
                lane.controller.abort(new Error("reason hard budget exceeded"));
              }
            }
          }, budget.totalMs)
        : null;

      try {
        await emitDisplayProgress(true);
        const tasks = laneStates.map(async (lane) => {
          try {
            const isReasonRefinement = runConfig.schedule === "budgeted" && lane.lane > 0;
            const result = await runLane({
              roundIdx: 0,
              laneIdx: lane.lane,
              prompt: userPrompt,
              thinking: isReasonRefinement ? runConfig.thinking : false,
              temperature: runConfig.temperature,
              kind: isReasonRefinement ? "refinement" : runConfig.schedule === "budgeted" ? "fallback" : "express",
              abortSignal: lane.controller.signal,
              onContentStart: () => {
                lane.contentStarted = true;
              },
            });
            if (resolved) return;
            if (result) {
              candidates.push(result);
              if (result.kind === "refinement") reasonRefinementCount += 1;
              if (isStopWorthyCandidate(result)) await acceptCandidate(result);
            }
          } finally {
            lane.cleanup();
            finished += 1;
            if (finished === laneStates.length) finishRace();
          }
        });
        await raceDone;
        await waitForRaceTasksToSettle(tasks);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (thinkTimer) clearTimeout(thinkTimer);
        if (hardTimer) clearTimeout(hardTimer);
        for (const lane of laneStates) lane.cleanup();
      }

      if (candidates.length === 0) {
        const failureSummary = failureKinds.length > 0 ? tallyFailureKinds(failureKinds) : {};
        await emitFailureFrame();
        await progressWriteChain;
        return {
          ok: false,
          error: (() => {
            // 按主导失败分型条件化文案:超时/被掐 ≠ QingML 结构错,别再无脑甩锅"校验失败"(否则 debug 走沟里)。
            const totalFails = failureKinds.length || 1;
            const budgetFails = failureSummary["reason_budget_exceeded"] ?? 0;
            const lengthFails = failureSummary["length_truncated"] ?? 0;
            const detail = `失败分型: ${JSON.stringify(failureSummary)}。`;
            if (lengthFails === totalFails) {
              return (
                `writeDraft 失败: ${lengthFails}/${totalFails} 路都因达到输出长度上限而截断，` +
                `截断稿未进入候选池。${detail}` +
                `重新调用时必须压缩生成规模：减少图表节点数、精简样式并压缩正文篇幅；` +
                `如果已连续两次因超长失败，请按更小规模出稿，并在正文中向用户说明。`
              );
            }
            if (budgetFails > totalFails / 2) {
              return (
                `writeDraft 失败: ${budgetFails}/${totalFails} 路因生成超时(时间预算内未完成、当前模型较慢)被中止,` +
                `非 QingML 结构错误。${detail}` +
                `请直接重新调用 writeDraft 重试(慢模型可考虑切更快的 flash 档,或加大 reason 预算)。`
              );
            }
            return (
              `writeDraft 失败: 4 路并行候选都未通过 QingML/AI-IR 校验。${detail}` +
              `请直接重新调用 writeDraft 进行工具维度重试，不要改用 editDraft；多为模型随机 QingML 结构错误，前缀缓存命中后重调成本较低。`
            );
          })(),
        };
      }

      firstRoundBestCount = bestStructurallyAware(candidates)?.count ?? bestOf(candidates)?.count ?? null;

      // 注:不再因"想要嵌套但没达深度"额外补一路 LLM 重试(那是正则判意图驱动的强制重跑,
      // 易拖慢首稿且命中率提升有限)。嵌套结构仍由候选优选(bestStructurallyAware)挑达标的那版 +
      // 下面的 structuralFailures 诊断兜底;层级格式由 system.ts / writeDraft 输出契约里的 children 范本约束。
      const champion = acceptedCandidate ?? (
        nestedIntent.wantsNestedList
          ? bestStructurallyAware(candidates)!
          : runConfig.schedule === "budgeted" && !lengthSpec
            ? [...candidates].reverse().find((candidate) => candidate.kind === "refinement") ?? candidates[0]!
            : bestStructurallyAware(candidates)!
      );
      await emitWinnerFrame(champion.laneKey, champion.raw, champion.kind === "refinement" ? 1 : 0);
      await progressWriteChain;
      const firstCount = firstRoundBestCount ?? champion.count;
      const finalDoc = champion.doc;
      const finalDocument = champion.document;
      const finalLegacySections = champion.legacySections;
      const finalCount = countOf(finalDoc);
      const nestedListReachedDepth = nestedIntent.wantsNestedList
        ? pmDocHasNestedList(finalDoc, nestedIntent.minDepth)
        : undefined;
      const structuralFailures = nestedIntent.wantsNestedList && !nestedListReachedDepth
        ? ["nested-list"]
        : undefined;

      let candidate: LegacySection[];
      try {
        assertTurnWriteAllowed(opts.state, writeGuard);
        candidate = opts.replaceDraftCandidateDoc(
          opts.state,
          finalDoc,
          finalLegacySections,
          writeGuard,
          expectedMutationRevision,
        );
      } catch (error) {
        if (error instanceof DraftMutationConflictError) {
          return { ok: false, error: DRAFT_MUTATION_CONFLICT_ERROR };
        }
        throw error;
      }
      context?.requestContext?.set("legacySections", candidate);
      context?.requestContext?.set("doc", opts.state.docDraftCandidateDoc ?? finalDoc);
      return {
        ok: true,
        blockCount: opts.state.docDraftCandidateDoc?.content.length ?? finalDoc.content.length,
        wordCount: finalCount,
        visibleCharCount: finalCount,
        targetLength: lengthSpec?.target,
        minLength: lengthSpec?.min,
        maxLength: lengthSpec?.max,
        firstVisibleCharCount: lengthSpec ? firstCount : undefined,
        previewExcerpt: headExcerpt(aiIrStreamPreviewFromMarkup(champion.raw || JSON.stringify(finalDocument.blocks)), 240),
        // reason 模式下该字段复用为"成功精修路数";express 仍表示加赛轮数。
        revisionCount: runConfig.schedule === "budgeted"
          ? reasonRefinementCount
          : lengthSpec
            ? extraRoundsUsed
            : undefined,
        lengthStatus: getLengthStatus(firstCount, finalCount, lengthSpec, extraRoundsUsed),
        nestedListReachedDepth,
        structuralFailures,
      };
      } finally {
        stopHeartbeat();
      }
    },
  });
}

export const writeDraftInternals = {
  makeReasonBudget,
  reasonBudgetMultiplier,
  runConfigForIntent,
  failureKindFromError,
};

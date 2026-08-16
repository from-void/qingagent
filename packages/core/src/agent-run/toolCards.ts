import type {
  AskUserQuestionKind,
  AskUserSliderSpec,
  AuthCardPresentation,
  CommandCardBody,
  CommandTerminalKind,
  DiffHunk,
  DocSuggestion,
  ResearchCardBody,
  ToolCallSpec,
  ToolCallStatus,
  WriteDraftCardBody,
  WriteDraftFailureDiagnostic,
} from "@qingagent/contract-ts";
import { hardenInlineSvg } from "@qingagent/doc-render";
import { Buffer } from "node:buffer";
import { assessCommand } from "../workspace/commandRisk.js";
import { createSuggestionFromDiffHunk } from "../doc-engine/draftReviewSuggestions.js";
import {
  redactSensitiveText,
  redactedJsonText,
  redactedSerializedText,
} from "./redaction.js";
import type { SessionState } from "../session/sessionState.js";
import type { PendingConfirm } from "../session/sessionState.js";
import type { QuestionnaireToolName } from "./questionnaireTools.js";
import { isRunScriptFailureKind } from "../runtime/scriptFailure.js";

function commandPolicyBlockFromOutput(output: string): { title: string; icon: string; reason: string } | null {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("命令已被拒绝:")) {
    return { title: "命令被拦截", icon: "🚫", reason: trimmed };
  }
  if (trimmed.startsWith("命令需要审批:")) {
    return { title: "命令需要审批", icon: "⚠️", reason: trimmed };
  }
  return null;
}

export function commandCardStatusFromCard(card: CommandCardBody): ToolCallStatus {
  if (card.phase === "done") return { kind: "done" };
  if (card.phase === "running") {
    return { kind: "running", data: { progressPct: null, etaSec: null } };
  }
  return {
    kind: "failed",
    data: {
      retriable: false,
      reason: card.outputTail || "命令未执行",
    },
  };
}

/** 确认通过后的命令卡占位；只含 ConfirmSpec 已脱敏的预览。 */
export function confirmedCommandCardSpec(
  pending: PendingConfirm,
  status: "pending" | "running",
): ToolCallSpec {
  return {
    id: pending.toolCallId,
    name: pending.toolName,
    render: { kind: "chatInline" },
    status: status === "pending"
      ? { kind: "pending" }
      : { kind: "running", data: { progressPct: null, etaSec: null } },
    body: {
      kind: "commandCard",
      data: {
        title: pending.spec.title,
        icon:
          pending.spec.kind === "install"
            ? "📦"
            : pending.spec.kind === "send"
              ? "📤"
              : "⚙️",
        command: pending.spec.commandPreview ?? "",
        exitCode: 0,
        outputTail: "",
        phase: "running",
        cancellable: true,
      },
    },
    result: null,
  };
}

/** 执行命令工具结束时定格成友好终端卡。命令原文与输出脱敏后藏详情,标题用人话。 */
export function commandCardFromResult(
  args: Record<string, unknown>,
  toolResult: unknown,
  ok: boolean,
  ownerToolCallId?: string,
): CommandCardBody {
  const rawCommand = typeof args.command === "string" ? args.command : "";
  const command = redactSensitiveText(rawCommand);
  const structured =
    toolResult !== null && typeof toolResult === "object" && !Array.isArray(toolResult)
      ? toolResult as Record<string, unknown>
      : null;
  // 新链路直接读取结构化执行信号；字符串解析只兼容旧快照/旧 provider。
  const outRaw = redactedJsonText(
    typeof structured?.output === "string" ? structured.output : toolResult ?? "",
  );
  const exitMatch = outRaw.match(/(?:^|\n)Exit code:?\s*(-?\d+)\s*$/i);
  const outputForDisplay = outRaw
    .replace(/(?:^|\n)Exit code:?\s*-?\d+\s*$/i, "")
    .trimEnd();
  const hasStructuredStatus =
    typeof structured?.success === "boolean" ||
    typeof structured?.exitCode === "number";
  const structuredExitCode = typeof structured?.exitCode === "number"
    ? structured.exitCode
    : null;
  const exitCode = structuredExitCode ?? (
    exitMatch ? Number(exitMatch[1]) : ok ? 0 : 1
  );
  const cancelled = structured?.cancelled === true;
  const timedOut = structured?.timedOut === true;
  // 交互式授权收口:不是超时、不是失败、更不是用户中止,卡面必须单独说清,
  // 否则用户只会看到"未完成"却不知道该做什么(0729 语雀真机)。
  const authRequired = !cancelled && !timedOut && structured?.authRequired === true;
  // killed = 被信号打死但不是我们主动取消:必须与"已中止"分开,否则用户看到的
  // 结论是"你把它停了",而真相可能是沙箱写墙拒绝或 OOM(0729 真机 P1)。
  const killedBySignal = !cancelled && !timedOut && structured?.killed === true;
  const pid = typeof structured?.pid === "string" || typeof structured?.pid === "number"
    ? String(structured.pid)
    : null;
  const background =
    structured?.background === true && pid !== null && structured?.success === true;
  const structuredFailed = structured !== null && (
    structured.success === false || exitCode !== 0 || cancelled || timedOut ||
    killedBySignal || authRequired
  );
  const legacyNonZeroExit = structured === null && exitMatch !== null && exitCode !== 0;
  const policyBlock = commandPolicyBlockFromOutput(outRaw);
  if (policyBlock) {
    return {
      title: policyBlock.title,
      icon: policyBlock.icon,
      command,
      exitCode: 1,
      outputTail: policyBlock.reason.slice(-600),
      phase: "failed",
      terminalKind: "failed",
    };
  }
  const verdict = assessCommand(rawCommand);
  // 本卡是 tool-result 的定格,标题描述实际结果;安全态占位标题归一成"运行命令"。
  const cardTitle =
    verdict.risk === "deny" || (verdict.risk === "safe" && verdict.title === "执行操作")
      ? "运行命令"
      : verdict.title.replace(/^AI 想/, "");
  const failed =
    structuredFailed || legacyNonZeroExit || (!hasStructuredStatus && !ok);
  const terminalKind: CommandTerminalKind | undefined = background
    ? undefined
    : timedOut
      ? "timedOut"
      : cancelled
        ? "aborted"
        : authRequired
          ? "authRequired"
          : killedBySignal
            ? "killed"
            : failed
              ? "failed"
              : "succeeded";
  return {
    title: cardTitle,
    icon: verdict.icon,
    command,
    exitCode,
    outputTail: background && pid
      ? `已在后台启动（PID: ${pid}）`
      : outputForDisplay.slice(-600),
    // 后台工具调用的职责是拉起进程；spawn 成功时这张卡即完成。进程真正的
    // 成败仍由 PID owner 索引和后续 lifecycle 事件收口。
    phase: background ? "done" : failed ? "failed" : "done",
    ...(terminalKind ? { terminalKind } : {}),
    ...(background && pid
      ? {
          pid,
          ownerToolCallId: ownerToolCallId ?? "",
          background: true,
        }
      : {}),
  };
}

/** commandCard 的 status 是唯一权威；任何终态改写都同步收敛 body，避免恢复后永久转圈。 */
export function alignCommandCardWithStatus(spec: ToolCallSpec): ToolCallSpec {
  if (spec.body.kind !== "commandCard") return spec;
  const status = spec.status;
  const phase = status.kind === "failed" || status.kind === "aborted"
    ? "failed"
    : status.kind === "done"
      ? "done"
      : status.kind === "pending" || status.kind === "running"
        ? "running"
        : spec.body.data.phase;
  const reason = status.kind === "failed" ? status.data.reason : "";
  const existingTerminalKind = spec.body.data.terminalKind;
  const terminalKind: CommandTerminalKind | undefined = phase === "running"
    ? undefined
    : status.kind === "aborted"
      ? "aborted"
      : phase === "done"
      ? "succeeded"
      : existingTerminalKind && existingTerminalKind !== "succeeded"
        ? existingTerminalKind
        : "failed";
  const outputTail = reason && !spec.body.data.outputTail.includes(reason)
    ? [spec.body.data.outputTail, reason].filter(Boolean).join("\n")
    : spec.body.data.outputTail;
  return {
    ...spec,
    body: {
      kind: "commandCard",
      data: {
        ...spec.body.data,
        phase,
        terminalKind,
        exitCode:
          phase === "failed" && spec.body.data.exitCode === 0
            ? -1
            : spec.body.data.exitCode,
        outputTail,
      },
    },
  };
}

export function isTerminalCommandCard(spec: ToolCallSpec): boolean {
  return (
    spec.body.kind === "commandCard" &&
    spec.body.data.terminalKind !== undefined &&
    (spec.status.kind === "done" || spec.status.kind === "failed" || spec.status.kind === "aborted")
  );
}

function scriptFailureTerminalKind(result: Record<string, unknown>): CommandTerminalKind {
  // failureKind 只由宿主计时器、AbortSignal、RSS 护栏或受控 Worker 外壳写入。
  // 旧快照/旧 provider 没有该字段时，错误文本可能来自用户代码，必须保守归入代码错误。
  if (!isRunScriptFailureKind(result.failureKind)) return "codeError";
  // 契约的 terminalKind 没有平台故障档；执行器自身不可用按通用失败呈现,不冤枉用户代码。
  return result.failureKind === "platformError" ? "failed" : result.failureKind;
}

/** 把 run_js / run_python 定格成同款命令卡:脚本当 command、stdout/返回值/错误当 outputTail,
 *  复用 CommandCard 的可展开样式,让用户能看到并展开运行的脚本与输出(与沙箱命令卡样式统一)。 */
export function scriptCardFromResult(
  toolName: string,
  args: Record<string, unknown>,
  toolResult: unknown,
  ok: boolean,
): CommandCardBody {
  const code = typeof args.code === "string" ? args.code : "";
  const r = (toolResult ?? {}) as Record<string, unknown>;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const error = typeof r.error === "string" ? r.error : "";
  const resultText =
    r.result !== undefined && r.result !== null
      ? typeof r.result === "string"
        ? r.result
        : JSON.stringify(r.result)
      : "";
  const output = redactedJsonText(
    [stdout, resultText ? `=> ${resultText}` : "", error ? `Error: ${error}` : ""]
      .filter(Boolean)
      .join("\n"),
  );
  const failed = !ok || r.ok === false || Boolean(error);
  const terminalKind: CommandTerminalKind = failed
    ? scriptFailureTerminalKind(r)
    : "succeeded";
  const isPython = toolName === "run_python";
  return {
    // 统一显示名:运行时 bar 与完成时 card 都叫「运行代码」,不暴露 JS/Python 实现细节。
    title: "运行代码",
    icon: isPython ? "PY" : "JS",
    command: redactSensitiveText(code),
    exitCode: failed ? 1 : 0,
    outputTail: output.slice(-600),
    phase: failed ? "failed" : "done",
    terminalKind,
  };
}

/** 工具结束时把 writeDraft 出参定格成迷你草稿卡数据(done/failed)。 */
export function writeDraftCardFromResult(
  args: Record<string, unknown>,
  toolResult: Record<string, unknown>,
  ok: boolean,
): WriteDraftCardBody {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const diagnostic = writeDraftFailureDiagnostic(toolResult.diagnostic);
  return {
    title: typeof args.title === "string" ? args.title : "",
    phase: ok ? "done" : "failed",
    charCount: num(toolResult.visibleCharCount) ?? 0,
    charCountApproximate: false,
    // 完成卡保留开头预览(直播/历史重开都有内容);拿不到则 null。
    excerpt: typeof toolResult.previewExcerpt === "string" ? toolResult.previewExcerpt : null,
    diagnostic,
    targetLength: num(toolResult.targetLength),
    minLength: num(toolResult.minLength),
    maxLength: num(toolResult.maxLength),
    revisionCount: num(toolResult.revisionCount) ?? 0,
    lengthStatus: typeof toolResult.lengthStatus === "string" ? toolResult.lengthStatus : null,
  };
}

function writeDraftFailureDiagnostic(value: unknown): WriteDraftFailureDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.failureKind !== "string"
    || typeof record.tagSkeleton !== "string"
    || !Array.isArray(record.warningKinds)
    || record.warningKinds.some((kind) => typeof kind !== "string")
    || !Array.isArray(record.errorLocations)
  ) {
    return null;
  }
  return value as WriteDraftFailureDiagnostic;
}

type GenerateSvgCardBody = Extract<ToolCallSpec["body"], { kind: "generateSvg" }>["data"];
type GenerateSvgCardProgress = GenerateSvgCardBody["progress"];
type GenerateSvgProgressData = NonNullable<GenerateSvgCardProgress>;

export function generateSvgToolCallSpec(
  toolCallId: string,
  args: Record<string, unknown>,
  status: ToolCallStatus,
  result: ToolCallSpec["result"] = null,
  progress: GenerateSvgCardProgress = null,
): ToolCallSpec {
  const description =
    typeof args.description === "string"
      ? args.description
      : typeof args.prompt === "string"
        ? args.prompt
        : "";
  return {
    id: toolCallId,
    name: "generateSvg",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "generateSvg",
      data: {
        prompt: description,
        style: typeof args.style === "string" ? args.style : null,
        aspect: typeof args.aspect === "string" ? args.aspect : null,
        progress,
      },
    },
    result,
  };
}

export function normalizeGenerateSvgProgress(value: unknown): GenerateSvgProgressData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const stage = record.stage;
  if (
    stage !== "starting" &&
    stage !== "streaming" &&
    stage !== "sanitizing" &&
    stage !== "done" &&
    stage !== "failed"
  ) {
    return null;
  }
  const elapsedMs = typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
    ? Math.max(0, Math.round(record.elapsedMs))
    : 0;
  const rawKb = typeof record.rawKb === "number" && Number.isFinite(record.rawKb)
    ? Math.max(0, Math.round(record.rawKb * 10) / 10)
    : 0;
  return {
    stage,
    elapsedMs,
    rawKb,
    message: typeof record.message === "string" ? record.message : "",
    error: typeof record.error === "string" && record.error ? record.error : null,
    src: typeof record.src === "string" && record.src ? record.src : null,
    width: typeof record.width === "number" && Number.isFinite(record.width) ? record.width : null,
    height: typeof record.height === "number" && Number.isFinite(record.height) ? record.height : null,
    partialSvg: typeof record.partialSvg === "string" && record.partialSvg
      ? hardenInlineSvg(record.partialSvg)
      : null,
  };
}

export function generateSvgProgressFromResult(result: Record<string, unknown>): GenerateSvgProgressData | null {
  if (typeof result.src !== "string" || !result.src) return null;
  return {
    stage: "done",
    elapsedMs: 0,
    rawKb: typeof result.svg === "string" ? Math.round((Buffer.byteLength(result.svg, "utf8") / 1024) * 10) / 10 : 0,
    message: "SVG 已生成",
    error: null,
    src: result.src,
    width: typeof result.width === "number" && Number.isFinite(result.width) ? result.width : null,
    height: typeof result.height === "number" && Number.isFinite(result.height) ? result.height : null,
    partialSvg: null,
  };
}

export function latestGenerateSvgProgress(
  state: SessionState,
  toolCallId: string,
): GenerateSvgProgressData | null {
  for (const message of state.chatHistory) {
    const part = message.parts.find((p) => p.kind === "toolCall" && p.data.id === toolCallId);
    if (part?.kind === "toolCall" && part.data.body.kind === "generateSvg") {
      return part.data.body.data.progress;
    }
  }
  return null;
}

export function readImageToolCallSpec(
  toolCallId: string,
  args: Record<string, unknown>,
  status: ToolCallStatus,
  result: ToolCallSpec["result"] = null,
  thumbnailSrc: string | null = null,
  excerpt: string | null = null,
): ToolCallSpec {
  return {
    id: toolCallId,
    name: "readImage",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "readImageCard",
      data: {
        prompt: typeof args.prompt === "string" ? args.prompt : "",
        thumbnailSrc,
        excerpt,
      },
    },
    result,
  };
}

export function researchCardToolCallSpec(
  toolCallId: string,
  data: ResearchCardBody,
  status: ToolCallStatus,
  result: ToolCallSpec["result"] = null,
): ToolCallSpec {
  return {
    id: toolCallId,
    name: "webSearch",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "researchCard",
      data,
    },
    result,
  };
}

const DEFAULT_QR_EXPIRES_IN_SEC = 300;

function qrExpiryFromDuration(expiresInSec: unknown, fallbackInSec: number): number {
  const durationSec =
    typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0
      ? expiresInSec
      : fallbackInSec;
  return Date.now() + durationSec * 1000;
}

function qrExpiryFromAbsolute(expiresAt: unknown, fallbackInSec: number): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  if (typeof expiresAt === "string") {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return qrExpiryFromDuration(undefined, fallbackInSec);
}

export interface AuthCardToolCallInput {
  toolCallId: string;
  toolName: string;
  presentation: AuthCardPresentation;
  status: ToolCallStatus;
  content?: unknown;
  imageDataUri?: unknown;
  title?: unknown;
  code?: unknown;
  note?: unknown;
  expiresAt?: unknown;
  expiresInSec?: unknown;
  fallbackExpiresInSec?: number;
  refreshQuery?: unknown;
  confirmQuery?: unknown;
  confirmLabel?: unknown;
  connectorId?: "github" | "feishu" | "wechat-mp";
  pendingId?: unknown;
  pendingText?: string;
  invalidText?: string;
  sourceArgs?: Record<string, unknown>;
}

/**
 * 授权/分享卡的唯一规格构造器。连接器调用方从 ConnectorDefinition 传 presentation；
 * show_qr 的字符串链接固定为 link、图片固定为 scan，不允许模型替连接器猜展示形态。
 */
export function authCardToolCallSpec(input: AuthCardToolCallInput): ToolCallSpec {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  const content = str(input.content);
  const imageDataUri = str(input.imageDataUri);
  if (!content && !imageDataUri) {
    const invalidText =
      input.invalidText ?? `${input.toolName} 缺少 content/imageDataUri,无法渲染授权卡`;
    const invalidStatus: ToolCallSpec["status"] = input.status.kind === "done"
      ? { kind: "failed", data: { retriable: true, reason: invalidText } }
      : input.status;
    return {
      id: input.toolCallId,
      name: input.toolName,
      render: { kind: "chatInline" },
      status: invalidStatus,
      body: {
        kind: "generic",
        data: {
          argsJson:
            input.pendingText ??
            redactedSerializedText(input.sourceArgs ?? {}),
        },
      },
      result:
        input.status.kind === "done"
          ? { kind: "genericText", data: invalidText }
          : null,
    };
  }
  const expiresAt = input.expiresAt === undefined
    ? qrExpiryFromDuration(
        input.expiresInSec,
        input.fallbackExpiresInSec ?? DEFAULT_QR_EXPIRES_IN_SEC,
      )
    : qrExpiryFromAbsolute(
        input.expiresAt,
        input.fallbackExpiresInSec ?? DEFAULT_QR_EXPIRES_IN_SEC,
      );
  return {
    id: input.toolCallId,
    name: input.toolName,
    render: { kind: "chatInline" },
    status: input.status,
    body: {
      kind: "qrCard",
      data: {
        presentation: input.presentation,
        content: content ?? "",
        imageDataUri,
        title: str(input.title),
        code: str(input.code),
        note: str(input.note),
        expiresAt,
        refreshQuery:
          str(input.refreshQuery) ?? "授权卡已过期,请帮我重新生成",
        confirmQuery: str(input.confirmQuery),
        confirmLabel: str(input.confirmLabel),
        connectorId: input.connectorId,
        pendingId: str(input.pendingId) ?? undefined,
      },
    },
    result: null,
  };
}

export const PURE_UI_TOOL_NAMES = new Set(["show_qr"]);

/** legacy/UI 通道元数据；quickClarification 仅用于兼容老快照。 */
export type AskUserPurposeKind = "initialBrief" | "quickClarification" | "directionChange";

export function askUserRenderModeFromSpec(
  spec: ToolCallSpec | null | undefined,
): "fullpage" | "overlay" | null {
  if (spec?.body.kind !== "askUser") return null;
  const mode = spec.body.data.mode?.kind;
  return mode === "fullpage" || mode === "overlay" ? mode : null;
}

export interface BuildAskUserToolCallSpecInput {
  toolCallId: string;
  toolName: QuestionnaireToolName;
  id?: string;
  renderMode: "fullpage" | "overlay";
  purpose?: AskUserPurposeKind | null;
  source?: string | null;
  rationale?: string | null;
  questions: Array<{
    id: string;
    header?: string | null;
    label: string;
    kind: "single" | "multi" | "text" | "slider" | { kind: string };
    options: Array<{
      value: string;
      label: string;
      description: string | null;
      preview: string | null;
    }>;
    placeholder: string | null;
    /** F4 滑块配置(kind=slider 时存在),投影必须透传,否则前端 validator 拒收。 */
    slider?: AskUserSliderSpec | null;
  }>;
  status?: ToolCallStatus;
}

export function buildAskUserToolCallSpec(
  input: BuildAskUserToolCallSpecInput,
): ToolCallSpec {
  const status = input.status ?? { kind: "pending" };
  return {
    id: input.toolCallId,
    name: input.toolName,
    render: { kind: input.renderMode === "fullpage" ? "rightForm" : "rightOverlay" },
    status,
    body: {
      kind: "askUser",
      data: {
        id: input.id ?? input.toolCallId,
        mode: { kind: input.renderMode },
        purpose: input.purpose ? { kind: input.purpose } : null,
        source: input.source === "null" ? null : (input.source ?? null),
        rationale: input.rationale === "null" ? null : (input.rationale ?? null),
        questions: input.questions.map((q) => ({
          id: q.id,
          header: q.header ?? null,
          label: q.label,
          kind: (typeof q.kind === "object" ? q.kind : { kind: q.kind }) as AskUserQuestionKind,
          options: q.options,
          placeholder: q.placeholder,
          // F4:slider 配置透传(无则缺省,旧问卷兼容)
          ...(q.slider ? { slider: q.slider } : {}),
        })),
      },
    },
    result: null,
  };
}

// ⚠️【勿删·铁律】docSuggestion 帧是右侧补丁审阅的数据骨架,不是死代码。
// 这个 spec 经 toolCallUpdated 发到前端 → workspaceState 存 draft.toolCalls →
// protocol.applyPatchOverlaysWithReport 构建绿色 diff/接受拒绝/patchSummary。
// 删掉它的 emit(settleDraftCandidate/updatePatchVerdict/commitPatches/markSuggestionConflicts
// 里的 yield toolCallUpdated(...docSuggestion...))会让整个右侧审阅失效——曾误删已回退。
export function buildSuggestionToolCallSpec(
  suggestion: DocSuggestion,
  status: ToolCallStatus = { kind: "reviewing" },
): ToolCallSpec {
  return {
    id: suggestion.id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status,
    body: {
      kind: "docSuggestion",
      data: {
        kind: "suggestion",
        data: suggestion,
      },
    },
    result: suggestion.conflict
      ? { kind: "genericText", data: suggestion.conflict.message }
      : null,
  };
}

export function suggestionFromDiffHunk(input: {
  hunk: DiffHunk;
  docId: string;
  baseVersion: number;
  baseSchemaVersion: number;
  batchId?: string;
}): DocSuggestion {
  return createSuggestionFromDiffHunk(input);
}

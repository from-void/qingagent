import type {
  AskUserQuestionKind,
  AskUserSliderSpec,
  CommandCardBody,
  DiffHunk,
  DocSuggestion,
  ResearchCardBody,
  ToolCallSpec,
  ToolCallStatus,
  WriteDraftCardBody,
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
import type { QuestionnaireToolName } from "./questionnaireTools.js";

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
  return {
    kind: "failed",
    data: {
      retriable: false,
      reason: card.outputTail || "命令未执行",
    },
  };
}

/** 执行命令工具结束时定格成友好终端卡。命令原文与输出脱敏后藏详情,标题用人话。 */
export function commandCardFromResult(
  args: Record<string, unknown>,
  toolResult: unknown,
  ok: boolean,
): CommandCardBody {
  const rawCommand = typeof args.command === "string" ? args.command : "";
  const command = redactSensitiveText(rawCommand);
  // 结果可能是字符串(stdout)或 {output}/对象;取文本并脱敏
  const outRaw = redactedJsonText(toolResult ?? "");
  // 退出码:原版失败时结果含 "Exit code: N"
  const exitMatch = outRaw.match(/Exit code:?\s*(\d+)/i);
  // 工具 catch 路径返回 "Error: <msg>"(无 Exit code 行),不能因为没退出码就当成功
  // (R10-3:Error 前缀无 Exit code 被误渲完成态)。
  const looksLikeError = !exitMatch && /^Error:/.test(outRaw.trimStart());
  const exitCode = exitMatch ? Number(exitMatch[1]) : ok && !looksLikeError ? 0 : 1;
  const policyBlock = commandPolicyBlockFromOutput(outRaw);
  if (policyBlock) {
    return {
      title: policyBlock.title,
      icon: policyBlock.icon,
      command,
      exitCode: 1,
      outputTail: policyBlock.reason.slice(-600),
      phase: "failed",
    };
  }
  const verdict = assessCommand(rawCommand);
  // 本卡是 tool-result 的定格,标题描述实际结果;安全态占位标题归一成"运行命令"。
  const cardTitle =
    verdict.risk === "deny" || (verdict.risk === "safe" && verdict.title === "执行操作")
      ? "运行命令"
      : verdict.title.replace(/^AI 想/, "");
  return {
    title: cardTitle,
    icon: verdict.icon,
    command,
    exitCode,
    outputTail: outRaw.slice(-600),
    // "完成"的定义 = 命令真的跑起来并有产出,而非退出码为 0(用户口径)。退出码非零但有输出
    // (如校验类命令)仍算已完成,退出码进详情区显示;只有 catch 路径(Error 前缀、根本没跑起来)
    // 才算未完成。policy 拦截已在上面提前 return failed。
    phase: looksLikeError ? "failed" : "done",
  };
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
  const failed = !ok || Boolean(error);
  const isPython = toolName === "run_python";
  return {
    // 统一显示名:运行时 bar 与完成时 card 都叫「运行代码」,不暴露 JS/Python 实现细节。
    title: "运行代码",
    icon: isPython ? "PY" : "JS",
    command: redactSensitiveText(code),
    exitCode: failed ? 1 : 0,
    outputTail: output.slice(-600),
    phase: failed ? "failed" : "done",
  };
}

/** 工具结束时把 writeDraft 出参定格成迷你草稿卡数据(done/failed)。 */
export function writeDraftCardFromResult(
  args: Record<string, unknown>,
  toolResult: Record<string, unknown>,
  ok: boolean,
): WriteDraftCardBody {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    title: typeof args.title === "string" ? args.title : "",
    phase: ok ? "done" : "failed",
    charCount: num(toolResult.visibleCharCount) ?? num(toolResult.wordCount) ?? 0,
    // 完成卡保留开头预览(直播/历史重开都有内容);拿不到则 null。
    excerpt: typeof toolResult.previewExcerpt === "string" ? toolResult.previewExcerpt : null,
    targetLength: num(toolResult.targetLength),
    minLength: num(toolResult.minLength),
    maxLength: num(toolResult.maxLength),
    revisionCount: num(toolResult.revisionCount) ?? 0,
    lengthStatus: typeof toolResult.lengthStatus === "string" ? toolResult.lengthStatus : null,
  };
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

export function qrCardToolCallSpec(
  toolCallId: string,
  args: Record<string, unknown>,
  status: ToolCallStatus,
): ToolCallSpec {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const content = str(args.content);
  const imageDataUri = str(args.imageDataUri);
  // content(编码模式)与 imageDataUri(图片模式)至少给一个,两者都无才无法渲染。
  if (!content && !imageDataUri) {
    return {
      id: toolCallId,
      name: "show_qr",
      render: { kind: "chatInline" },
      status,
      body: {
        kind: "generic",
        data: { argsJson: redactedSerializedText(args) },
      },
      result: status.kind === "done"
        ? { kind: "genericText", data: "show_qr 缺少 content/imageDataUri,无法渲染二维码" }
        : null,
    };
  }
  const expiresInSec =
    typeof args.expiresInSec === "number" && Number.isFinite(args.expiresInSec) && args.expiresInSec > 0
      ? args.expiresInSec
      : 300;
  // 用「收到工具调用的此刻」换算成绝对过期时间戳,前端据此倒计时——不受 agent 思考/网络/渲染延迟影响。
  const expiresAt = Date.now() + expiresInSec * 1000;
  return {
    id: toolCallId,
    name: "show_qr",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "qrCard",
      data: {
        content: content ?? "",
        imageDataUri,
        title: str(args.title),
        code: str(args.code),
        note: str(args.note),
        expiresAt,
        refreshQuery: str(args.refreshQuery) ?? "二维码过期了,请帮我重新生成",
        confirmQuery: str(args.confirmQuery),
        confirmLabel: str(args.confirmLabel),
      },
    },
    result: null,
  };
}

/** 可信 connector bridge 专用：pendingId/device flow 元数据绝不经过模型参数。 */
export function githubAuthCardToolCallSpec(
  toolCallId: string,
  input: { pendingId: string; userCode: string; verificationUri: string; expiresAt: string },
): ToolCallSpec {
  const expiresAt = Date.parse(input.expiresAt);
  return {
    id: toolCallId,
    name: "github_auth_start",
    render: { kind: "chatInline" },
    status: { kind: "done" },
    body: {
      kind: "qrCard",
      data: {
        content: input.verificationUri,
        imageDataUri: null,
        title: "连接 GitHub",
        code: input.userCode,
        note: "复制用户码并在 GitHub 完成授权。",
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 15 * 60_000,
        refreshQuery: "GitHub 授权已中断，请重新发起连接",
        confirmQuery: null,
        connectorId: "github",
        pendingId: input.pendingId,
      },
    },
    result: null,
  };
}

export function feishuAuthCardToolCallSpec(
  toolCallId: string,
  input: {
    mode: "authorization" | "configuration";
    pendingId: string;
    url: string;
    userCode?: string;
    expiresAt: string;
  },
): ToolCallSpec {
  const expiresAt = Date.parse(input.expiresAt);
  const configuration = input.mode === "configuration";
  return {
    id: toolCallId,
    name: "feishu_auth_start",
    render: { kind: "chatInline" },
    status: { kind: "done" },
    body: {
      kind: "qrCard",
      data: {
        content: input.url,
        imageDataUri: null,
        title: configuration ? "创建你的飞书应用" : "扫码授权飞书",
        code: input.userCode ?? null,
        note: configuration
          ? `用飞书扫码，或 [点此打开创建向导](${input.url})，完成后连接器会自动继续。`
          : `用飞书 App 扫码，或 [点此在浏览器授权](${input.url})。`,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000,
        refreshQuery: configuration ? "创建应用的链接过期了，请重新发起" : "飞书授权二维码过期了，请重新生成",
        confirmQuery: null,
        connectorId: "feishu",
        pendingId: input.pendingId,
      },
    },
    result: null,
  };
}

/**
 * wechat_auth_start 授权卡:工具**直接**产出二维码卡片,base64 图片不经过模型
 * (微信登录码是 7KB+ base64,若让模型当 show_qr 参数复述会卡死/出错)。
 * running(无 result)显示生成中占位;done 从 result.imageDataUri 渲染 qrCard(图片模式),
 * 授权交互文案(标题/引导/确认/刷新)在此硬编码,模型无需操心。
 */
export function wechatAuthQrToolCallSpec(
  toolCallId: string,
  result: Record<string, unknown> | null,
  status: ToolCallStatus,
): ToolCallSpec {
  const imageDataUri =
    result && typeof result.imageDataUri === "string" && result.imageDataUri
      ? result.imageDataUri
      : null;
  if (!imageDataUri) {
    return {
      id: toolCallId,
      name: "wechat_auth_start",
      render: { kind: "chatInline" },
      status,
      body: { kind: "generic", data: { argsJson: "正在生成微信登录二维码…" } },
      result:
        status.kind === "done"
          ? { kind: "genericText", data: "微信登录二维码生成失败,请重试" }
          : null,
    };
  }
  const expiresInSec =
    typeof result?.expiresInSec === "number" && Number.isFinite(result.expiresInSec) && result.expiresInSec > 0
      ? (result.expiresInSec as number)
      : 240;
  const expiresAt = Date.now() + expiresInSec * 1000;
  return {
    id: toolCallId,
    name: "wechat_auth_start",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "qrCard",
      data: {
        content: "",
        imageDataUri,
        title: "扫码登录微信公众号",
        code: null,
        note: "用你**公众号管理员**的那个微信扫码,扫完手机上点「登录」,再点下方按钮",
        expiresAt,
        refreshQuery: "微信登录二维码过期了,请帮我重新生成",
        confirmQuery: "我已扫完码,请继续",
        confirmLabel: "我已扫码完成",
        connectorId: result?.connectorId === "wechat-mp" ? "wechat-mp" : undefined,
        pendingId: typeof result?.pendingId === "string" ? result.pendingId : undefined,
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

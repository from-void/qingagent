import { memo, useEffect, useMemo, useState, useRef } from "react";
import type { ReactNode } from "react";
import type {
  AskUserAnswerCardPart,
  ActionCardData,
  ChatChip,
  ChatMessage,
  MessagePart,
  ToolCallSpec,
} from "../data/protocol";
import {
  ASK_USER_RESTORE_INTERRUPTED_MESSAGE,
  parseChipRichText,
  sanitizeVisibleText,
} from "@qingagent/contract-ts";
import { InkBubble } from "../../../system";
import { SparkleIcon, FileChipIcon } from "../../../system/SkillMenu";
import { StreamingChars, useStreamFxConfig } from "./StreamingText";
import type { StreamFxConfig } from "../data/streamFxConfig";
import { truncateLabel } from "../textUtils";
import { countChars, longTextPreview, LongTextFullscreen } from "../../../system/longText";
import { desktopDataUrl } from "../../../system/desktopDataTransport";
import { BrowserViewPart } from "./BrowserViewPart";
import { DraftMiniCard } from "./DraftMiniCard";
import { AuthCard } from "./AuthCard";
import { ReviewOutcomeCard } from "./ReviewOutcomeCard";
import {
  UImageSummary,
  UnifiedToolCall,
  UProcessFold,
  type MaterialLabelMap,
  type SkillLabelMap,
} from "./chatUnified";
import {
  getLastAssistantMessageId,
  getThinkingSummaryLabel,
} from "./chatMessageThinking";
import { ThinkingMarquee } from "./ThinkingMarquee";
import {
  CaretIcon,
  CheckIcon,
  CloseIcon,
  ExternalLinkIcon,
  QuoteIcon,
  StatusDotIcon,
  StatusSquareIcon,
} from "./icons";
import { useSkills } from "../../../overlays/settings/useSkills";
import { useResourceList } from "../../../system/resources";

export interface ChatMessageListProps {
  messages: ChatMessage[];
  /** Show a loading indicator at the bottom (e.g. during document generation). */
  showLoading?: boolean;
  /**
   * 当前整轮是否仍在运行。包含活跃流、后端 agentBusy 与发送后的乐观等待窗；
   * 仅用于轮级完成判定，不能替代 streamActive 驱动逐字动画。
   */
  turnActive?: boolean;
  streamActive: boolean;
  /** 改动B 微调:二次编辑审批入口"打字"进行中——patchSummary 工具条显示 loading 文案。 */
  patchRevealing?: boolean;
  /** 当前审批轮"真正落地"的处数(单一真相源派生)。用于纠正 patchSummary 显示,
   * 使"已修改 N 处"与正文标记数严格一致;null = 不在审批态,用气泡自带 count。 */
  livePatchCount?: number | null;
  /** 当前审批轮全部 hunk id 的稳定 key,用于把上面的计数精确对到这一轮的气泡(避免影响历史气泡)。 */
  liveHunkKey?: string;
  /** 当前会话 id,用于给整篇审历史记忆加会话维度,避免跨会话同 hunk id 误命中。 */
  sessionId?: string | null;
  /** 当前活动审批轮是否为「整篇改写」(大改 ≥70%)——大改时左侧不报离散「N 处」。 */
  wholeDocReview?: boolean;
  /** 已判为「整篇改写」的审批轮 session+hunkKey 集合:commit 后该轮 live 信号消失,历史气泡仍按整篇显示。 */
  wholeDocReviewKeys?: ReadonlySet<string>;
  /** Ref to the scroll container for auto-scroll support. */
  scrollRef?: React.Ref<HTMLDivElement>;
  /** debug 模式:开则思考条常驻可展开(旧行为);关则只在思考进行中显示滚动文案条、完成即隐去。 */
  debugMode?: boolean;
}

/** 首 token 前窗口:流已开始但助手第一个 part 还没到 —— 最后一条消息还是 user。 */
export function shouldShowPreTokenLoading(messages: ChatMessage[], streamActive: boolean): boolean {
  return streamActive && messages.length > 0 && messages[messages.length - 1]?.role.kind === "user";
}

/**
 * 尾段是否代表「模型请求已发出、但这一段还没吐出任何正文」。
 *
 * 原来只认 `thinking` 尾段,于是「思考中」只在模型真吐 reasoning_content 时才出现:
 * 自定义 OpenAI 协议网关/多数 openai 协议模型压根不吐 reasoning,指示条永远不出;
 * 更常见的是工具跑完等模型续写的那几秒到几十秒,界面完全静默(用户报的"看不出在干活")。
 * 判据改成「没有正在流的正文,也没有在等用户/在跑的工具」:
 * - 无 part:空的 agent 消息刚建好,请求刚发出;
 * - thinking:reasoning 在流,marquee 同时滚 reasoning 首句;
 * - 工具已结束(done/failed/aborted/accepted/rejected/committed):模型正在生成下一段;
 * - text/code 尾段:正文已在逐字出现,自带可视反馈,不再叠指示条;
 * - 工具 pending/running/reviewing:工具条自己有运行态/待办文案,叠"思考中"是谎报。
 */
export function isAwaitingModelSegment(lastPart: MessagePart | undefined): boolean {
  if (!lastPart) return true;
  if (lastPart.kind === "text" || lastPart.kind === "code") return false;
  if (lastPart.kind === "toolCall") {
    const status = lastPart.data.status.kind;
    return status !== "pending" && status !== "running" && status !== "reviewing";
  }
  return true;
}

export function ChatMessageList({
  messages,
  showLoading,
  streamActive,
  turnActive = streamActive,
  patchRevealing,
  livePatchCount,
  liveHunkKey,
  sessionId,
  wholeDocReview,
  wholeDocReviewKeys,
  scrollRef,
  debugMode = false,
}: ChatMessageListProps) {
  const [loadingSlow, setLoadingSlow] = useState(false);
  // Track message IDs that existed on first render — those should not animate
  const initialIdsRef = useRef<Set<string> | null>(null);
  if (initialIdsRef.current === null) {
    initialIdsRef.current = new Set(messages.map((m) => m.id));
  }
  const lastAssistantMessageId = useMemo(
    () => getLastAssistantMessageId(messages),
    [messages],
  );
  const { skills } = useSkills();
  const skillLabels = useMemo<SkillLabelMap>(
    () => Object.fromEntries(skills.map((skill) => [skill.name, skill.label])),
    [skills],
  );
  const fileResources = useResourceList({ kind: "file" });
  const materialLabels = useMemo<MaterialLabelMap>(
    () => Object.fromEntries(
      fileResources.map((resource) => [resource.resourceRef.id, resource.displayName]),
    ),
    [fileResources],
  );
  const visibleAskUserAnswerToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind === "askUserAnswerCard") ids.add(part.data.toolCallId);
      }
    }
    return ids;
  }, [messages]);
  // 轮级折叠标记:把消息分轮,判断每轮是否"已结清"(非进行中流 + 无运行中工具 + 无待审批 live patch),
  // 以及该消息是否本轮最后一条 agent 消息。只有"已结清且是本轮收尾"的消息才允许折叠过程。
  const turnFlags = useMemo(
    () => computeTurnFlags(messages, lastAssistantMessageId, turnActive, liveHunkKey),
    [messages, lastAssistantMessageId, turnActive, liveHunkKey],
  );
  const trailingMessageId = messages[messages.length - 1]?.id;
  const messageRows = useMemo(
    () =>
      messages.map((m) => {
        const patchKeys = getMessagePatchKeys(m);
        const hasPatchSummary = patchKeys.length > 0;
        const isLivePatchMessage =
          liveHunkKey != null && patchKeys.includes(liveHunkKey);
        const rowStreamActive = streamActive && m.id === lastAssistantMessageId;
        const flags = turnFlags.get(m.id);

        return (
          <MessageRow
            key={m.id}
            message={m}
            isNew={!initialIdsRef.current!.has(m.id)}
            streamActive={rowStreamActive}
            isLastAssistantMessage={m.id === lastAssistantMessageId}
            isTrailingMessage={m.id === trailingMessageId}
            turnSettled={flags?.turnSettled ?? false}
            turnReasoningDone={flags?.turnReasoningDone ?? false}
            isFinalAgentMsg={flags?.isFinalAgentMsg ?? false}
            patchRevealing={isLivePatchMessage ? patchRevealing : false}
            livePatchCount={isLivePatchMessage ? livePatchCount : null}
            liveHunkKey={isLivePatchMessage ? liveHunkKey : undefined}
            sessionId={hasPatchSummary ? sessionId : null}
            wholeDocReview={isLivePatchMessage ? wholeDocReview : false}
            wholeDocReviewKeys={hasPatchSummary ? wholeDocReviewKeys : undefined}
            debugMode={debugMode}
            skillLabels={skillLabels}
            materialLabels={materialLabels}
            visibleAskUserAnswerToolCallIds={visibleAskUserAnswerToolCallIds}
          />
        );
      }),
    [
      debugMode,
      lastAssistantMessageId,
      liveHunkKey,
      livePatchCount,
      messages,
      materialLabels,
      patchRevealing,
      sessionId,
      streamActive,
      skillLabels,
      trailingMessageId,
      turnFlags,
      visibleAskUserAnswerToolCallIds,
      wholeDocReview,
      wholeDocReviewKeys,
    ],
  );

  useEffect(() => {
    if (!showLoading) {
      setLoadingSlow(false);
      return;
    }
    setLoadingSlow(false);
    const timer = window.setTimeout(() => setLoadingSlow(true), 2_000);
    return () => window.clearTimeout(timer);
  }, [showLoading]);

  return (
    <div className="ws-chat u-scope" data-wf="ChatMessageList" ref={scrollRef}>
      {messageRows}
      {showLoading && (
        <div className="wf-msg agent" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-3)", fontSize: 13 }}>
          <span className="chat-loading-dots">
            <span /><span /><span />
          </span>
          {loadingSlow ? "正在准备上下文,首次对话会稍慢…" : "正在连接模型…"}
        </div>
      )}
      {messages.length === 0 && <EmptyHint />}
    </div>
  );
}

type MessageRowProps = {
  message: ChatMessage;
  isNew: boolean;
  streamActive: boolean;
  isLastAssistantMessage: boolean;
  /** 是否为整条列表的最后一条消息(等待态指示条只挂在真正的队尾)。 */
  isTrailingMessage?: boolean;
  turnSettled?: boolean;
  turnReasoningDone?: boolean;
  isFinalAgentMsg?: boolean;
  patchRevealing?: boolean;
  livePatchCount?: number | null;
  liveHunkKey?: string;
  sessionId?: string | null;
  wholeDocReview?: boolean;
  wholeDocReviewKeys?: ReadonlySet<string>;
  debugMode?: boolean;
  skillLabels?: SkillLabelMap;
  materialLabels?: MaterialLabelMap;
  visibleAskUserAnswerToolCallIds: ReadonlySet<string>;
};

type VisibleMessageRole = "user" | "agent" | "system";
type PatchSummaryPart = Extract<MessagePart, { kind: "patchSummary" }>;
type PatchSummaryDataWithReviewOutcome = PatchSummaryPart["data"] & {
  reviewOutcome?: "abandoned" | "failed" | "committed";
  appliedCount?: number;
  conflictCount?: number;
};

function isUserStandaloneCardPart(part: MessagePart): part is Extract<MessagePart, { kind: "reviewOutcome" | "askUserAnswerCard" | "actionCard" }> {
  return part.kind === "reviewOutcome" || part.kind === "askUserAnswerCard" || part.kind === "actionCard";
}

export function sanitizeVisibleMessagePart(
  part: MessagePart,
  role: VisibleMessageRole,
  options: { debugMode?: boolean } = {},
): MessagePart | null {
  if (role === "system") return null;
  if (role === "user") return part;
  switch (part.kind) {
    case "text": {
      const body = sanitizeVisibleText(part.data.body);
      return body ? { ...part, data: { body } } : null;
    }
    case "code": {
      const body = sanitizeVisibleText(part.data.body);
      return body ? { ...part, data: { ...part.data, body } } : null;
    }
    case "toolCall":
    case "citation":
    case "image":
    case "patchSummary":
    case "reviewOutcome":
    case "askUserAnswerCard":
    case "actionCard":
      return part;
    case "thinking":
      return options.debugMode ? part : null;
  }
}

// 外部提案来源:服务端把调用方编进消息 id(external-<client>-<uuid>);web 只做展示映射。
export type ExternalClient = "claude-code" | "codex" | "deepseek" | "agent";

export function parseExternalClient(id: string): ExternalClient | null {
  const match = /^external-([a-z0-9]+)-/.exec(id);
  if (!match) return null;
  switch (match[1]) {
    case "claudecode":
      return "claude-code";
    case "codex":
    case "chatgpt": // Codex 已并入统一 ChatGPT(2026-05 团队合并,7 月桌面端统一),两个 wire 名同源。
      return "codex";
    case "deepseek":
      return "deepseek";
    default:
      // 老格式 external-<uuid> 或未知来源:统一按"外部 Agent"展示。
      return "agent";
  }
}

const EXTERNAL_AGENT_LABEL: Record<ExternalClient, string> = {
  "claude-code": "Claude Code",
  // Codex 已统一升级并入 ChatGPT(OpenAI 2026-05 合并 ChatGPT/Codex,7 月桌面端统一)。
  codex: "ChatGPT",
  deepseek: "DeepSeek Harness",
  agent: "外部 Agent",
};

// 官方 Claude Code 标志(块状机器人脸,clay 橙),path 取自 @lobehub/icons 的 claudecode 图标。
function ClaudeCodeRobot() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="#D97757" fillRule="evenodd" clipRule="evenodd">
      <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  );
}

// 官方 ChatGPT/OpenAI 标志(六向环结),path 取自 @lobehub/icons 的 openai 图标;
// Codex 已并入统一 ChatGPT 桌面体验,来源图标随品牌升级。
function ChatGPTLogo() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

// DeepSeek Harness 官方标志(黑白鲸首,取自 Harness 产品 wordmark 左标,currentColor 随主题)。
function DeepSeekLogo() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M23.0584 4.95203C22.8129 4.83203 22.7074 5.06103 22.5639 5.17704C22.5149 5.21454 22.4734 5.26354 22.4319 5.30854C22.0734 5.69155 21.6543 5.94306 21.1073 5.91306C20.3073 5.86806 19.6243 6.11957 19.0203 6.73158C18.8918 5.97706 18.4652 5.52655 17.8162 5.23754C17.4767 5.08753 17.1332 4.93703 16.8952 4.61052C16.7292 4.37801 16.6837 4.11901 16.6007 3.8635C16.5477 3.70949 16.4952 3.55199 16.3177 3.52549C16.1252 3.49549 16.0497 3.65699 15.9742 3.792C15.6722 4.34401 15.5552 4.95203 15.5667 5.56805C15.5932 6.95359 16.1782 8.05712 17.3407 8.84215C17.4727 8.93215 17.5067 9.02215 17.4652 9.15366C17.3857 9.42416 17.2917 9.68667 17.2087 9.95718C17.1557 10.1297 17.0767 10.1677 16.8917 10.0922C16.2537 9.82568 15.7027 9.43117 15.2156 8.95465C14.3891 8.15513 13.6416 7.2726 12.7096 6.58158C12.4906 6.42007 12.2716 6.27007 12.045 6.12707C11.094 5.20354 12.1696 4.44502 12.4186 4.35501C12.6791 4.26101 12.5091 3.938 11.6675 3.942C10.826 3.9455 10.056 4.22751 9.07446 4.60302C8.93096 4.65952 8.77995 4.70052 8.62545 4.73452C7.73492 4.56552 6.80989 4.52802 5.84386 4.63702C4.02481 4.83953 2.57177 5.69955 1.50373 7.1676C0.220694 8.93215 -0.0813148 10.9372 0.288196 13.0283C0.676708 15.2323 1.80174 17.0569 3.53029 18.4834C5.32285 19.9625 7.38741 20.6875 9.74298 20.5485C11.1735 20.466 12.7661 20.2745 14.5626 18.7539C15.0156 18.9795 15.4912 19.0695 16.2797 19.137C16.8872 19.1935 17.4722 19.107 17.9252 19.013C18.6347 18.8629 18.5857 18.2059 18.3292 18.0854C16.2497 17.1169 16.7062 17.5109 16.2912 17.1919C17.3477 15.9419 18.9618 13.7198 19.4598 10.6942C19.5088 10.3602 19.5713 9.88968 19.5638 9.61917C19.5598 9.45417 19.5978 9.39016 19.7863 9.37116C20.3073 9.31116 20.8128 9.16866 21.2773 8.91315C22.6249 8.17713 23.1684 6.96809 23.2964 5.51905C23.3154 5.29754 23.2924 5.06853 23.0584 4.95203ZM11.3165 17.9954C9.30097 16.4109 8.32344 15.8894 7.91992 15.9119C7.54241 15.9344 7.61042 16.3664 7.69342 16.6479C7.78042 16.9259 7.89342 17.1174 8.05193 17.3614C8.16143 17.5229 8.23694 17.7629 7.94243 17.9434C7.29341 18.3449 6.16487 17.8084 6.11187 17.7819C4.79833 17.0084 3.7003 15.9874 2.92628 14.5908C2.17875 13.2468 1.74474 11.8047 1.67324 10.2657C1.65424 9.89418 1.76374 9.76267 2.13375 9.69517C2.62077 9.60517 3.12278 9.58617 3.6093 9.65767C5.66636 9.95818 7.41741 10.8777 8.88545 12.3348C9.72348 13.1643 10.3575 14.1558 11.0105 15.1243C11.705 16.1529 12.4521 17.1329 13.4036 17.9364C13.7396 18.2179 14.0076 18.4319 14.2641 18.5899C13.4906 18.6764 12.1996 18.6949 11.3165 17.9964V17.9954ZM12.2826 11.7817C12.2826 11.6167 12.4146 11.4852 12.5806 11.4852C12.6181 11.4852 12.6521 11.4927 12.6826 11.5037C12.7241 11.5187 12.7621 11.5412 12.7921 11.5752C12.8451 11.6277 12.8751 11.7027 12.8751 11.7817C12.8751 11.9467 12.7431 12.0782 12.5771 12.0782C12.4111 12.0782 12.2826 11.9467 12.2826 11.7817ZM15.2831 13.3208C15.0906 13.3998 14.8981 13.4673 14.7131 13.4748C14.4261 13.4898 14.1131 13.3733 13.9431 13.2308C13.6791 13.0093 13.4901 12.8853 13.4111 12.4988C13.3771 12.3338 13.3961 12.0782 13.4261 11.9317C13.4941 11.6162 13.4186 11.4137 13.1961 11.2297C13.0151 11.0797 12.7846 11.0382 12.5316 11.0382C12.4371 11.0382 12.3506 10.9967 12.2861 10.9632C12.1806 10.9107 12.0936 10.7792 12.1766 10.6177C12.2031 10.5652 12.3316 10.4377 12.3616 10.4152C12.7051 10.2197 13.1011 10.2837 13.4676 10.4302C13.8071 10.5692 14.0641 10.8242 14.4336 11.1847C14.8111 11.6202 14.8791 11.7402 15.0941 12.0672C15.2641 12.3228 15.4186 12.5853 15.5247 12.8858C15.5887 13.0733 15.5057 13.2268 15.2831 13.3208Z" />
    </svg>
  );
}

function ExternalAgentLogo({ client }: { client: ExternalClient }) {
  if (client === "claude-code") return <ClaudeCodeRobot />;
  if (client === "codex") return <ChatGPTLogo />;
  if (client === "deepseek") return <DeepSeekLogo />;
  // 通用外部 agent:终端提示符记号。
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8 L9 12 L5 16 M12 16 H18" />
    </svg>
  );
}

// 外部工具代用户操作的两种来源:改文档(提交修改)与代发消息。文案随动作走,来源 logo 复用。
const EXTERNAL_ACTION_TEXT: Record<"edit" | "send", string> = {
  edit: "提交了修改",
  send: "代你发送了一条消息",
};

function ExternalOpNote({ client, action }: { client: ExternalClient; action: "edit" | "send" }) {
  return (
    <div className="wf-external-op" data-wf="ExternalOpNote">
      <ExternalAgentLogo client={client} />
      <span>{EXTERNAL_AGENT_LABEL[client]} {EXTERNAL_ACTION_TEXT[action]}</span>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  isNew,
  streamActive,
  isLastAssistantMessage,
  isTrailingMessage = false,
  turnSettled = false,
  turnReasoningDone = false,
  isFinalAgentMsg = false,
  patchRevealing,
  livePatchCount,
  liveHunkKey,
  sessionId,
  wholeDocReview,
  wholeDocReviewKeys,
  debugMode = false,
  skillLabels,
  materialLabels,
  visibleAskUserAnswerToolCallIds,
}: MessageRowProps) {
  const role = message.role.kind;
  // 审阅 chip 不需要知道来源、其下游逻辑不受影响。判据 = 服务端约定的 external-* 消息 id。
  const isExternalMessage = message.id.startsWith("external-");
  const externalClient = isExternalMessage ? parseExternalClient(message.id) : null;
  if (role === "user") {
    if (message.parts.length > 0 && message.parts.every(isUserStandaloneCardPart)) {
      return (
        <div className="wf-msg agent wf-msg-user-card" data-wf="ChatMsg-user-card">
          {message.parts.map((p, i) => (
            <UserPartView key={i} part={p} />
          ))}
        </div>
      );
    }
    // Check if the text body contains chip markers for inline rendering
    const textPart = message.parts.find((p) => p.kind === "text");
    const body = textPart?.kind === "text" ? textPart.data.body : "";
    const hasChipMarkers =
      message.chips &&
      message.chips.length > 0 &&
      /\{\{chip:\d+\}\}/.test(body);

    return (
      <>
        {isExternalMessage && externalClient && <ExternalOpNote client={externalClient} action="send" />}
        <InkBubble
          animate={isNew}
          className="wf-msg user"
        >
          <div data-wf="ChatMsg-user">
          {hasChipMarkers ? (
            <>
              {message.parts.map((p, i) =>
                p.kind === "text" ? (
                  <UserPartWithChips
                    key={i}
                    body={p.data.body}
                    chips={message.chips!}
                  />
                ) : (
                  <UserPartView key={i} part={p} />
                ),
              )}
            </>
          ) : (
            <>
              {message.parts.map((p, i) => (
                <UserPartView key={i} part={p} />
              ))}
              {message.chips && message.chips.length > 0 && (
                <div
                  style={{
                    marginTop: 4,
                    display: "flex",
                    gap: 4,
                    flexWrap: "wrap",
                  }}
                >
                  {message.chips.map((chip, i) => (
                    <ChatChipBadge key={i} chip={chip} />
                  ))}
                </div>
              )}
            </>
          )}
          </div>
        </InkBubble>
      </>
    );
  }
  if (role === "system") {
    return null;
  }
  // 非 debug 模式:思考条不各自渲染,统一合并成一条放在**消息最底部**(永远在最新内容下面,跟着流走);
  // 只要「模型正在跑但这一段还没吐正文」(见 isAwaitingModelSegment)就出「思考中」——不依赖模型
  // 是否返回 reasoning,下面那行滚动文案只是有 reasoning 时的辅助。一旦正文开始逐字出现,或工具进入
  // 运行/待用户处理态(它们自带文案),思考条立即掐断。
  // debug 模式:思考 part 照旧各自渲染(可展开)。
  const lastPart = message.parts[message.parts.length - 1];
  // isTrailingMessage:流在跑但新一轮的 agent 消息还没建时,最后一条 agent 消息是上一轮的,
  // 不能让它冒出「思考中」(那一窗由底部"正在连接模型…"负责)。
  const thinkingTailActive =
    !debugMode &&
    streamActive &&
    isLastAssistantMessage &&
    isTrailingMessage &&
    isAwaitingModelSegment(lastPart);
  // 只取「尾部连续的 thinking part」= 当前这一轮的 reasoning。多 step turn 里
  // parts 形如 [思考1, 工具调用, 思考2, ...];历史轮的 thinking 被工具调用隔开,
  // 绝不能把它们一起拼进 marquee —— 否则进入新一轮思考时会把上一轮的句子又轮播一遍
  // (用户报的"第二轮思考中又冒出第一轮文案、一个一个重复"就是这个)。
  const currentThinkingText = thinkingTailActive
    ? (() => {
        const tail: string[] = [];
        for (let i = message.parts.length - 1; i >= 0; i--) {
          const p = message.parts[i];
          if (p?.kind !== "thinking") break; // 遇到非 thinking(工具调用/文本)即到本轮 reasoning 起点
          tail.push(p.data.steps.join(""));
        }
        return tail.reverse().join("\n\n");
      })()
    : "";
  // 可见 parts(过滤掉非 debug 的思考 part 等)+ 原始下标(给 key 稳定)
  const visibleParts: { part: MessagePart; key: number }[] = [];
  message.parts.forEach((p, i) => {
    const vp = sanitizeVisibleMessagePart(p, "agent", { debugMode });
    if (
      vp &&
      !(
        vp.kind === "toolCall" &&
        shouldSuppressOverlayAskUserToolCall(
          vp.data,
          visibleAskUserAnswerToolCallIds,
        )
      )
    ) {
      visibleParts.push({ part: vp, key: i });
    }
  });
  const renderPart = (vp: { part: MessagePart; key: number }) => (
    <PartView
      key={vp.key}
      part={vp.part}
      streamActive={streamActive}
      isLastAssistantMessage={isLastAssistantMessage}
      patchRevealing={patchRevealing}
      livePatchCount={livePatchCount}
      liveHunkKey={liveHunkKey}
      sessionId={sessionId}
      wholeDocReview={wholeDocReview}
      wholeDocReviewKeys={wholeDocReviewKeys}
      skillLabels={skillLabels}
      materialLabels={materialLabels}
      visibleAskUserAnswerToolCallIds={visibleAskUserAnswerToolCallIds}
    />
  );

  // part 在渲染层全部被过滤时直接收掉整条消息，避免遗留空的 .wf-msg.agent 外壳。
  // user 答卷卡走上方独立分支，不会被这里误伤。
  if (
    visibleParts.length === 0 &&
    !thinkingTailActive &&
    !(isExternalMessage && externalClient)
  ) {
    return null;
  }

  // 产出物后置:某些工具的产出物(二维码等)很重要,不该被过程折叠收掉。统一做法 = 像
  // patchSummary(已修改N处)一样,把它放到**最终回复之后**展示;原位只留一条简单工具条
  // (生成二维码·已完成,走 UnifiedToolCall),跟着过程正常折叠。要后置哪些 = 看工具(白名单)。
  const artifacts = visibleParts.filter(
    (vp) =>
      vp.part.kind === "toolCall" &&
      vp.part.data.status.kind === "done" &&
      ARTIFACT_BODY_KINDS.has(vp.part.data.body.kind),
  );
  const renderArtifact = (vp: { part: MessagePart; key: number }) => {
    if (vp.part.kind !== "toolCall") return null;
    const b = vp.part.data.body;
    // 产出物统一用圆角矩形容器(产出物展示规范)
    if (b.kind === "qrCard") {
      return <div key={`art-${vp.key}`} className="u-artifact"><AuthCard data={b.data} /></div>;
    }
    return null;
  };
  // 配图(generateSvg):卡片本身不动(仍内联随过程折叠);这里额外收集本轮产出的图,
  // 在底部补一条「已生成 N 张图片」汇总(缩略图可放大),折叠后也能看到/放大产出图。
  const svgImages = visibleParts.flatMap((vp) => {
    if (vp.part.kind !== "toolCall") return [];
    const b = vp.part.data.body;
    if (b.kind !== "generateSvg") return [];
    if (vp.part.data.status.kind !== "done") return [];
    const src = b.data.progress?.src;
    return src ? [{ src, prompt: b.data.prompt }] : [];
  });

  // 轮级过程折叠(出最终回复就折):本轮**结清**后,把最终回复之前的"过程"(工具/中间文字)
  // 收成「过程·N步」。折叠条件(全满足才折):
  //  ① turnSettled —— 本轮已结清(非进行中、无运行工具、无待审批 live patch;父组件按轮判定)
  //  ② isFinalAgentMsg —— 本消息是本轮收尾的 agent 消息
  //  ③ 有最终正文回复(lastTextIdx>0),且其后**没有跟随的工具调用**(只允许跟一条已结的 patchSummary)
  //     —— 防止"文案后还有工具在跑/排队"被误折(用户实测 bug)
  //  ④ 过程里确实有工具(stepCount>0)
  //  ⑤ 不含问卷(askUser);审批(patchSummary)只在 turnSettled(已接受/放弃)时才会走到这
  let lastTextIdx = -1;
  visibleParts.forEach((vp, i) => { if (vp.part.kind === "text") lastTextIdx = i; });
  const hasAskUser = visibleParts.some(
    (vp) => vp.part.kind === "toolCall" && vp.part.data.body.kind === "askUser",
  );
  // 最终回复之后只允许 patchSummary(已修改N处),不允许还有工具调用
  const trailingHasTool =
    lastTextIdx >= 0 &&
    visibleParts.slice(lastTextIdx + 1).some((vp) => vp.part.kind === "toolCall");
  const processParts = lastTextIdx > 0 ? visibleParts.slice(0, lastTextIdx) : [];
  const stepCount = processParts.filter((vp) => vp.part.kind === "toolCall").length;
  const foldProcess =
    !debugMode &&
    turnSettled &&
    isFinalAgentMsg &&
    !hasAskUser &&
    !trailingHasTool &&
    lastTextIdx > 0 &&
    stepCount > 0;

  // 外部工具提案:在消息行顶部单独挂一条"外部操作"信息条,表达来源(改文档);与下方通用审阅 chip 解耦,
  // 审阅 chip 不需要知道来源、其下游逻辑不受影响。isExternalMessage/externalClient 已在函数顶部算好。
  return (
    <div className="wf-msg agent" data-wf="ChatMsg-agent">
      {isExternalMessage && externalClient && <ExternalOpNote client={externalClient} action="edit" />}
      {foldProcess ? (
        <>
          <UProcessFold steps={stepCount}>{processParts.map(renderPart)}</UProcessFold>
          {visibleParts.slice(lastTextIdx).map(renderPart)}
        </>
      ) : (
        visibleParts.map(renderPart)
      )}
      {/* 产出物后置:重要产出物放到最终回复之后,圆角展示(产出物展示规范)。
          【设计确认·评审勿当"重复展示"删】无论折不折都渲染,这是有意的:
          ① 二维码:原位 ToolCallRow 已把 qrCard 渲成**简单条**(不是整张卡),这里后置的圆角码是
             唯一一份真码 → 不重复。
          ② 配图:USvg 卡内联保留(随过程折叠),底部「已生成 N 张图片」是**缩略图汇总**(整卡 +
             小缩略图两种视角),按设计共存,不是重复。
          (用户已确认上述非 bug;曾被自动评审误报为"非折叠轮重复展示"。) */}
      {artifacts.map(renderArtifact)}
      {/* 图片汇总在「推理结束」即出现(luna r1 第7项):门 turnReasoningDone 而非 turnSettled——
          SVG 插图后进入待审阅态时 turnSettled 会一直 false,汇总行不能拖到用户提交后才出。
          推理进行中不出(用户拍板);二维码(qrCard)不延后——授权码要青简中途等用户扫。 */}
      {turnReasoningDone ? <UImageSummary images={svgImages} /> : null}
      {thinkingTailActive && <ThinkingMarquee thinkingText={currentThinkingText} active />}
    </div>
  );
});

// 产出物工具白名单:这些工具的产出物很重要,不随过程折叠收掉,而是后置到最终回复之后、
// 圆角展示。原位只留一条简单工具条(随过程正常折叠)。要后置哪些 = 看具体工具。
const ARTIFACT_BODY_KINDS = new Set<string>(["qrCard"]);

function getMessagePatchKeys(message: ChatMessage): string[] {
  const keys: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "patchSummary") {
      keys.push(getPatchSummaryKey(part.data.hunkIds));
    }
  }
  return keys;
}

type TurnFoldFlag = {
  turnSettled: boolean;
  /** 推理已结束(非进行中流式轮、无运行工具),但可能还有待审批的 live patch。 */
  turnReasoningDone: boolean;
  isFinalAgentMsg: boolean;
};

// 把消息按"轮"分组(普通 user 消息开启新轮,askUser 答卷续回原轮),逐轮算两个折叠判定标记:
//  - turnSettled:本轮已结清 —— 不是进行中的流式轮、轮内没有运行中/等待中的工具、
//    也没有待审批的 live patch(审批未接受/放弃前不折)。
//  - isFinalAgentMsg:该消息是本轮最后一条 agent 消息(过程折叠只挂在收尾消息上)。
function computeTurnFlags(
  messages: ChatMessage[],
  lastAssistantMessageId: string | null,
  turnActive: boolean,
  liveHunkKey: string | undefined,
): Map<string, TurnFoldFlag> {
  const flags = new Map<string, TurnFoldFlag>();
  const turns: ChatMessage[][] = [];
  for (const m of messages) {
    // askUser 答卷是被挂起 agent 轮的恢复点，不是新业务轮。服务端会在答卷后新建
    // agent message；若在这里按普通 user 切轮，lastAssistantMessageId 只能压住恢复后的
    // 半轮，恢复前已经 done 的配图会在整轮仍运行时提前冒出汇总。
    const resumesSuspendedTurn =
      m.role.kind === "user" &&
      m.parts.length > 0 &&
      m.parts.every((part) => part.kind === "askUserAnswerCard");
    if (m.role.kind === "user" && !resumesSuspendedTurn) turns.push([m]);
    else {
      if (turns.length === 0) turns.push([]);
      turns[turns.length - 1]!.push(m);
    }
  }
  for (const turn of turns) {
    const agentMsgs = turn.filter((m) => m.role.kind === "agent");
    const finalAgentId = agentMsgs.length ? agentMsgs[agentMsgs.length - 1]!.id : null;
    const isActiveTurn =
      turnActive &&
      lastAssistantMessageId != null &&
      turn.some((m) => m.id === lastAssistantMessageId);
    const anyRunningTool = agentMsgs.some((m) =>
      m.parts.some(
        (p) =>
          p.kind === "toolCall" &&
          (p.data.status.kind === "running" || p.data.status.kind === "pending"),
      ),
    );
    const anyLivePatch =
      liveHunkKey != null &&
      agentMsgs.some((m) => getMessagePatchKeys(m).includes(liveHunkKey));
    const reasoningDone = !isActiveTurn && !anyRunningTool;
    const settled = reasoningDone && !anyLivePatch;
    for (const m of turn) {
      flags.set(m.id, {
        turnSettled: settled,
        turnReasoningDone: reasoningDone,
        isFinalAgentMsg: m.id === finalAgentId,
      });
    }
  }
  return flags;
}

function getPatchSummaryKey(hunkIds: readonly string[]): string {
  return hunkIds.slice().sort().join(",");
}

function getPatchSummaryReviewOutcome(
  part: PatchSummaryPart,
): "abandoned" | "failed" | "committed" | null {
  const outcome = (part.data as PatchSummaryDataWithReviewOutcome).reviewOutcome;
  return outcome === "abandoned" || outcome === "failed" || outcome === "committed"
    ? outcome
    : null;
}

/** 聊天正文的内联 markdown run；start 按 Unicode 码点计，供流式动画稳定复用。 */
export type StreamingInlineRun =
  | { kind: "plain" | "bold" | "code"; text: string; start: number }
  | { kind: "link"; text: string; href: string; start: number }
  | { kind: "image"; text: string; src: string; start: number };

type ParsedMarkdownLink = {
  end: number;
  text: string;
  href: string | null;
};

function safeHttpHref(rawHref: string): string | null {
  try {
    const url = new URL(rawHref);
    return url.protocol === "http:" || url.protocol === "https:" ? rawHref : null;
  } catch {
    return null;
  }
}

function safeImageHref(rawHref: string): string | null {
  if (rawHref.startsWith("/api/v1/files/")) return desktopDataUrl(rawHref);
  return safeHttpHref(rawHref);
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\[\]()<>])/g, "$1");
}

function findQuotedTitleEnd(value: string, start: number, quote: string): number {
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === "\\") {
      i += 1;
    } else if (value[i] === quote) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 解析一个完整 markdown 链接。
 * href=null 表示语法完整但协议不安全/目标无效；调用方会把整段保留成纯文本，
 * 避免再从 javascript:/data: 目标内部误提取出一个裸 URL。
 */
function parseMarkdownLinkAt(
  value: string,
  start: number,
  validateHref: (rawHref: string) => string | null = safeHttpHref,
): ParsedMarkdownLink | null {
  if (value[start] !== "[") return null;

  let labelEnd = -1;
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === "\\") {
      i += 1;
    } else if (value[i] === "]") {
      labelEnd = i;
      break;
    }
  }
  if (labelEnd <= start + 1 || value[labelEnd + 1] !== "(") return null;

  let cursor = labelEnd + 2;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;

  let rawHref = "";
  if (value[cursor] === "<") {
    const hrefStart = cursor + 1;
    let hrefEnd = -1;
    for (let i = hrefStart; i < value.length; i++) {
      if (value[i] === "\\") {
        i += 1;
      } else if (value[i] === ">") {
        hrefEnd = i;
        break;
      } else if (value[i] === "\n") {
        return null;
      }
    }
    if (hrefEnd < 0) return null;
    rawHref = value.slice(hrefStart, hrefEnd);
    cursor = hrefEnd + 1;
  } else {
    const hrefStart = cursor;
    let parenDepth = 0;
    for (; cursor < value.length; cursor++) {
      const char = value[cursor]!;
      if (char === "\\") {
        cursor += 1;
      } else if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        if (parenDepth === 0) break;
        parenDepth -= 1;
      } else if (/\s/u.test(char) && parenDepth === 0) {
        break;
      }
    }
    rawHref = value.slice(hrefStart, cursor);
  }
  if (!rawHref) return null;

  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  if (value[cursor] !== ")") {
    const quote = value[cursor];
    if (quote !== "\"" && quote !== "'" && quote !== "(") return null;
    const titleEnd = findQuotedTitleEnd(value, cursor, quote === "(" ? ")" : quote);
    if (titleEnd < 0) return null;
    cursor = titleEnd;
    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    if (value[cursor] !== ")") return null;
  }

  const href = unescapeMarkdown(rawHref);
  return {
    end: cursor + 1,
    text: unescapeMarkdown(value.slice(start + 1, labelEnd)),
    href: validateHref(href),
  };
}

function parseMarkdownImageAt(value: string, start: number): ParsedMarkdownLink | null {
  if (value[start] !== "!" || value[start + 1] !== "[") return null;
  return parseMarkdownLinkAt(value, start + 1, safeImageHref);
}

function trimBareUrlEnd(candidate: string): number {
  let end = candidate.length;
  while (end > 0) {
    const char = candidate[end - 1]!;
    if (/[.,!;:，。！；：、]/u.test(char)) {
      end -= 1;
      continue;
    }
    if (char === ")") {
      const body = candidate.slice(0, end);
      const opens = (body.match(/\(/g) ?? []).length;
      const closes = (body.match(/\)/g) ?? []).length;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return end;
}

function parseBareUrlAt(value: string, start: number): { end: number; href: string } | null {
  const prefix = value.slice(start, start + 8).toLowerCase();
  if (!prefix.startsWith("http://") && !prefix.startsWith("https://")) return null;
  let candidateEnd = start;
  while (
    candidateEnd < value.length &&
    !/[\s<>"'`[\]{}，。！？；：、]/u.test(value[candidateEnd]!)
  ) {
    candidateEnd += 1;
  }
  const hrefEnd = start + trimBareUrlEnd(value.slice(start, candidateEnd));
  if (hrefEnd <= start) return null;
  const href = value.slice(start, hrefEnd);
  return safeHttpHref(href) ? { end: hrefEnd, href } : null;
}

function splitInlineMarkdownRuns(value: string, optimisticTrailingBold = false): StreamingInlineRun[] {
  const runs: StreamingInlineRun[] = [];
  const toCharOffset = (index: number) => Array.from(value.slice(0, index)).length;
  let plainStart = 0;
  let cursor = 0;

  const pushPlain = (from: number, to: number) => {
    if (to > from) {
      runs.push({ kind: "plain", text: value.slice(from, to), start: toCharOffset(from) });
    }
  };

  while (cursor < value.length) {
    const markdownImage = parseMarkdownImageAt(value, cursor);
    if (markdownImage) {
      if (markdownImage.href) {
        pushPlain(plainStart, cursor);
        runs.push({
          kind: "image",
          text: markdownImage.text,
          src: markdownImage.href,
          start: toCharOffset(cursor),
        });
        plainStart = markdownImage.end;
      }
      cursor = markdownImage.end;
      continue;
    }

    if (value[cursor] === "`") {
      const end = value.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        pushPlain(plainStart, cursor);
        runs.push({
          kind: "code",
          text: value.slice(cursor + 1, end),
          start: toCharOffset(cursor + 1),
        });
        cursor = end + 1;
        plainStart = cursor;
        continue;
      }
    }

    if (value.startsWith("**", cursor)) {
      const end = value.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        pushPlain(plainStart, cursor);
        runs.push({
          kind: "bold",
          text: value.slice(cursor + 2, end),
          start: toCharOffset(cursor + 2),
        });
        cursor = end + 2;
        plainStart = cursor;
        continue;
      }
    }

    const markdownLink = parseMarkdownLinkAt(value, cursor);
    if (markdownLink) {
      if (markdownLink.href) {
        pushPlain(plainStart, cursor);
        runs.push({
          kind: "link",
          text: markdownLink.text,
          href: markdownLink.href,
          start: toCharOffset(cursor + 1),
        });
        plainStart = markdownLink.end;
      }
      cursor = markdownLink.end;
      continue;
    }

    const bareUrl = parseBareUrlAt(value, cursor);
    if (bareUrl) {
      pushPlain(plainStart, cursor);
      runs.push({
        kind: "link",
        text: bareUrl.href,
        href: bareUrl.href,
        start: toCharOffset(cursor),
      });
      cursor = bareUrl.end;
      plainStart = cursor;
      continue;
    }

    cursor += 1;
  }
  pushPlain(plainStart, value.length);

  if (!optimisticTrailingBold) return runs;
  const tail = runs[runs.length - 1];
  if (!tail || tail.kind !== "plain") return runs;
  const openIndex = tail.text.lastIndexOf("**");
  if (openIndex < 0) return runs;

  runs.pop();
  const before = tail.text.slice(0, openIndex);
  const content = tail.text.slice(openIndex + 2);
  if (before) runs.push({ ...tail, text: before });
  if (content) {
    runs.push({
      kind: "bold",
      text: content,
      start: tail.start + Array.from(tail.text.slice(0, openIndex + 2)).length,
    });
  }
  return runs;
}

function parseStandaloneLink(value: string): { title: string; href: string } | null {
  const markdownLink = parseMarkdownLinkAt(value, 0);
  if (markdownLink?.href && markdownLink.end === value.length) {
    return { title: markdownLink.text, href: markdownLink.href };
  }
  const bareUrl = parseBareUrlAt(value, 0);
  if (bareUrl?.end === value.length) {
    return { title: toolHost(bareUrl.href), href: bareUrl.href };
  }
  return null;
}

/**
 * Render chat text with basic markdown support:
 * - **bold**
 * - `code`
 * - [text](https://example.com) links and bare http(s) URLs
 * - ![alt](https://example.com/image.png) and /api/v1/files/ images
 * - Unordered lists (- item / * item)
 * - Ordered lists (1. item)
 * - Newlines
 */
export function renderSimpleMarkdown(text: string) {
  const lines = text.split("\n");
  const result: JSX.Element[] = [];
  type MarkdownListToken = {
    content: string;
    indent: number;
    line: number;
    ordinal: number | null;
    type: "ul" | "ol";
  };
  let listTokens: MarkdownListToken[] = [];
  let blockKey = 0;

  function parseListLine(line: string, lineIndex: number): MarkdownListToken | null {
    const match = /^([ \t]*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!match) return null;
    const indent = Array.from(match[1]!).reduce(
      (width, character) => width + (character === "\t" ? 4 : 1),
      0,
    );
    return {
      content: match[4]!,
      indent,
      line: lineIndex,
      ordinal: match[3] == null ? null : Number.parseInt(match[3], 10),
      type: match[3] == null ? "ul" : "ol",
    };
  }

  function nextNonBlankLineIsList(lineIndex: number): boolean {
    for (let index = lineIndex + 1; index < lines.length; index++) {
      const candidate = lines[index]!;
      if (candidate.trim() === "") continue;
      return parseListLine(candidate, index) !== null;
    }
    return false;
  }

  function flushList() {
    if (listTokens.length === 0) return;
    const listBlockKey = blockKey++;

    function renderListAt(start: number, depth: number): { node: JSX.Element; next: number } {
      const first = listTokens[start]!;
      const Tag = first.type;
      const items: JSX.Element[] = [];
      let index = start;
      let expectedOrdinal = first.ordinal ?? 1;

      while (index < listTokens.length) {
        const token = listTokens[index]!;
        if (token.indent !== first.indent || token.type !== first.type) break;
        index += 1;

        const children: JSX.Element[] = [];
        while (index < listTokens.length && listTokens[index]!.indent > first.indent) {
          const nested = renderListAt(index, depth + 1);
          children.push(nested.node);
          index = nested.next;
        }

        // Markdown 允许作者把每个自动编号项都写成 `1.`；除 1 外的跳号才视为显式序号。
        const explicitValue =
          token.type === "ol" &&
          token.ordinal !== null &&
          token.ordinal !== 1 &&
          token.ordinal !== expectedOrdinal
            ? token.ordinal
            : undefined;
        items.push(
          <li key={`li-${listBlockKey}-${token.line}`} value={explicitValue}>
            {renderInline(token.content, `li-${listBlockKey}-${token.line}`)}
            {children}
          </li>,
        );
        if (token.type === "ol") {
          expectedOrdinal = (explicitValue ?? expectedOrdinal) + 1;
        }
      }

      const startOrdinal = first.type === "ol" ? first.ordinal ?? 1 : undefined;
      return {
        node: (
          <Tag
            key={`list-${listBlockKey}-${first.line}-${depth}`}
            className={depth === 0 ? "chat-list" : "chat-list chat-list-nested"}
            start={startOrdinal}
          >
            {items}
          </Tag>
        ),
        next: index,
      };
    }

    let index = 0;
    while (index < listTokens.length) {
      const rendered = renderListAt(index, 0);
      result.push(rendered.node);
      index = rendered.next;
    }
    listTokens = [];
  }

  function renderInline(str: string, key: string): JSX.Element {
    const parts = splitInlineMarkdownRuns(str);
    const els: (string | JSX.Element)[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.kind === "bold") {
        els.push(<strong key={`${key}-b${i}`}>{p.text}</strong>);
      } else if (p.kind === "code") {
        els.push(
          <code key={`${key}-c${i}`} className="chat-inline-code">
            {p.text}
          </code>,
        );
      } else if (p.kind === "link") {
        els.push(
          <a key={`${key}-l${i}`} className="chat-link" href={p.href} target="_blank" rel="noreferrer noopener">
            {p.text}
            <span className="ws-link-arrow"><ExternalLinkIcon size={11} /></span>
          </a>,
        );
      } else if (p.kind === "image") {
        els.push(
          <span key={`${key}-i${i}`} className="u-thumb chat-markdown-image">
            <img src={p.src} alt={p.text} loading="lazy" />
          </span>,
        );
      } else {
        els.push(p.text);
      }
    }
    return <span key={key} className="chat-markdown-inline">{els}</span>;
  }

  let bqLines: JSX.Element[] = [];

  function flushBlockquote() {
    if (bqLines.length > 0) {
      result.push(
        <blockquote key={`bq-${blockKey++}`} className="chat-bq">
          {bqLines}
        </blockquote>,
      );
      bqLines = [];
    }
  }

  // Table accumulator
  let tableRows: string[][] = [];
  let tableHasHeader = false;
  // 多行 ```代码块``` 累积(否则 ``` 反引号会原样漏出来,中文行里看着像"点")。
  let inFence = false;
  let fenceLines: string[] = [];

  function flushTable() {
    if (tableRows.length === 0) return;
    const headerRow = tableHasHeader ? tableRows[0] : null;
    const bodyRows = tableHasHeader ? tableRows.slice(1) : tableRows;
    result.push(
      <table key={`tbl-${blockKey++}`} className="chat-table">
        {headerRow && (
          <thead>
            <tr>
              {headerRow.map((cell, ci) => (
                <th key={ci}>{renderInline(cell.trim(), `th-${blockKey}-${ci}`)}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{renderInline(cell.trim(), `td-${blockKey}-${ri}-${ci}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>,
    );
    tableRows = [];
    tableHasHeader = false;
  }

  function flushFence() {
    result.push(
      <pre
        key={`code-${blockKey++}`}
        style={{
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--ink-2)",
          background: "var(--bg-subtle)",
          border: "1px solid var(--line-1, #e0e0e0)",
          padding: "8px 10px",
          margin: "4px 0",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "auto",
          maxHeight: 320,
        }}
      >
        <code>{fenceLines.join("\n")}</code>
      </pre>,
    );
    fenceLines = [];
    inFence = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // ```代码块```:进入后累积原文,闭合时整段渲成代码块,杜绝反引号漏成"点"。
    if (/^\s*```[a-zA-Z0-9_-]*\s*$/.test(line)) {
      if (inFence) {
        flushFence();
      } else {
        flushList();
        flushBlockquote();
        flushTable();
        inFence = true;
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    const listMatch = parseListLine(line, i);
    const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
    const bqMatch = line.match(/^>\s?(.*)/);
    const hrMatch = /^\s*(---+|\*\*\*+|___+)\s*$/.test(line);

    // Table row detection: line starts and ends with |
    const tableMatch = line.match(/^\|(.+)\|$/);
    // Separator row: | --- | --- | (with optional colons for alignment)
    const isSeparator = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(line.trim());

    if (tableMatch) {
      flushList();
      flushBlockquote();
      if (isSeparator) {
        // Mark that the previous row was a header
        if (tableRows.length === 1) {
          tableHasHeader = true;
        }
        // Skip the separator row itself
        continue;
      }
      const cells = tableMatch[1]!.split("|");
      tableRows.push(cells);
      continue;
    }

    // If we were accumulating table rows, flush them
    flushTable();

    if (bqMatch) {
      flushList();
      bqLines.push(<div key={`bql-${i}`}>{renderInline(bqMatch[1]!, `bql-${i}`)}</div>);
    } else {
      flushBlockquote();

      if (hrMatch) {
        flushList();
        result.push(<hr key={`hr-${i}`} className="chat-hr" />);
      } else if (headingMatch) {
        flushList();
        const level = headingMatch[1]!.length as 1 | 2 | 3 | 4;
        const Tag = `h${level}` as const;
        result.push(
          <Tag key={`h-${i}`} className="chat-heading">
            {renderInline(headingMatch[2]!, `h-${i}`)}
          </Tag>,
        );
      } else if (listMatch) {
        listTokens.push(listMatch);
      } else {
        // 列表项/子列表之间的空行只影响松紧，不应把一个列表切成多个从 1 开始的列表。
        if (
          line.trim() === "" &&
          listTokens.length > 0 &&
          nextNonBlankLineIsList(i)
        ) {
          continue;
        }
        flushList();
        const trimmed = line.trim();
        const standaloneLink = parseStandaloneLink(trimmed);
        if (standaloneLink) {
          // 整行就是一个链接 → demo 链接卡(标题 + 域名↗)
          result.push(
            <ChatLinkCard key={`lc-${i}`} title={standaloneLink.title} url={standaloneLink.href} />,
          );
        } else if (trimmed === "") {
          // Empty line: use a slim spacer instead of a full <br> to keep
          // paragraph gaps compact.
          result.push(<div key={`br-${i}`} style={{ height: 4 }} />);
        } else {
          result.push(<div key={`p-${i}`} style={{ marginBottom: 1 }}>{renderInline(line, `p-${i}`)}</div>);
        }
      }
    }
  }
  flushBlockquote();
  flushList();
  flushTable();
  // 流式中未闭合的代码块也渲出来(避免半截丢失/反引号漏出)。
  if (inFence && fenceLines.length > 0) flushFence();
  return result;
}

/** 链接卡(demo .img-card 观感:边框 + 标题 + 域名↗)。整行链接时用。 */
function ChatLinkCard({ title, url }: { title: string; url: string }) {
  return (
    <a
      className="ws-link-card"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={url}
      data-wf="ChatLinkCard"
    >
      <div className="ws-link-card-meta">
        <div className="ws-link-card-title">
          <span className="ws-link-tag">链接</span>
          {title}
        </div>
        <div className="ws-link-card-host">
          {toolHost(url)}
          <span className="ws-link-arrow"><ExternalLinkIcon size={11} /></span>
        </div>
      </div>
    </a>
  );
}

/**
 * Render user message text preserving newlines. Chip markers embedded
 * in the text are detected and rendered as styled chip badges.
 */
function UserPartView({ part }: { part: MessagePart }) {
  if (part.kind !== "text") return <PartView part={part} />;
  const body = part.data.body;
  // Preserve newlines in user messages
  const lines = body.split("\n");
  return (
    <div style={{ marginBottom: 2, whiteSpace: "pre-wrap" }}>
      {lines.map((line, i) => (
        <span key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </div>
  );
}

function AskUserAnswerCard({ data }: { data: AskUserAnswerCardPart }) {
  if (data.items.length === 0) return null;
  // 与 fullpage「已提交答案」汇总卡(askuser-card)统一样式:打勾金头 + 问/答两列行。
  // 加 --answers modifier:答案可换行,避免多选/长自由文本被 .askuser-card-a 的 nowrap 省略号吞掉。
  return (
    <div className="askuser-card askuser-card--answers" data-wf="AskUserAnswerCard" aria-label={data.title}>
      <div className="askuser-card-header">
        <span className="askuser-card-check"><CheckIcon size={13} /></span>
        <span>{data.title}</span>
      </div>
      <div className="askuser-card-body">
        {data.items.map((item, index) => {
          const answerText = item.answerText;
          if (!answerText) return null;
          return (
            <div className="askuser-card-row" key={`${item.questionId}-${index}`}>
              <span className="askuser-card-q">{item.questionLabel}</span>
              <span className="askuser-card-a">{answerText}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionCard({ data }: { data: ActionCardData }) {
  const status = data.status;
  const statusLabel = status === "running"
    ? "审查中"
    : status === "done"
      ? "审查已完成"
      : status === "aborted"
        ? "审查已中止"
        : status === "failed"
          ? "审查未完成"
          : null;
  const statusIcon = status === "done"
    ? <CheckIcon size={13} />
    : status === "running"
      ? <span className="chat-loading-dots"><span /><span /><span /></span>
      : status === "aborted"
        ? <StatusSquareIcon size={8} />
        : <CloseIcon size={10} />;
  return (
    <div
      className="askuser-card askuser-card--answers"
      data-wf="ActionCard"
      data-status={status}
      aria-label={statusLabel ? `${data.title} · ${statusLabel}` : data.title}
    >
      <div className="askuser-card-header">
        <span className="askuser-card-check" aria-hidden="true">
          {statusIcon}
        </span>
        <span>{data.title}</span>
        {statusLabel ? (
          <span style={{ marginLeft: "auto", color: "var(--ink-3)", fontWeight: 400 }}>
            {statusLabel}
          </span>
        ) : null}
      </div>
      {data.lines.length > 0 ? <div className="askuser-card-body">
        {data.lines.map((line, index) => (
          <div className="askuser-card-row" key={`${line.label}-${index}`}>
            <span className="askuser-card-q">{line.label}</span>
            <span className="askuser-card-a">{line.value}</span>
          </div>
        ))}
      </div> : null}
    </div>
  );
}

/**
 * Render user message text with inline chips. Parses `{{chip:N}}`
 * markers in the body and replaces them with styled chip badges,
 * preserving the interleaved order of text and chips.
 */
/** 长文本小条在气泡里的展示:与输入框一致(单行小条 + hover 预览),点击全屏看原文。 */
function LongTextChipCard({ chip }: { chip: ChatChip }) {
  const [open, setOpen] = useState(false);
  const full = chip.text ?? "";
  return (
    <>
      <span
        className="chat-chip chat-chip-longtext"
        data-kind="longtext"
        role="button"
        tabIndex={0}
        title="查看全文"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="c-ico">
          <FileChipIcon size={13} />
        </span>
        <span className="c-label">长文本</span>
        <span className="c-tag">{chip.suffix ?? `${countChars(full)} 字`}</span>
        <span className="lt-pop" aria-hidden>
          <span className="lt-pop-text">{longTextPreview(full)}</span>
          <span className="lt-pop-hint">点击查看全文</span>
        </span>
      </span>
      {open && <LongTextFullscreen text={full} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 对话气泡里的引用 chip:与输入框 makeChatChipNode 统一(图标 + 主标签 + 后缀小标签)。 */
function ChatChipBadge({ chip, inline }: { chip: ChatChip; inline?: boolean }) {
  // 批注标记在线路上复用 text chip 以把完整指令展开给模型；气泡仍只显示短标签，
  // 不误渲染成「长文本」卡片，也不暴露隐藏指令。
  if (chip.kind.kind === "text" && chip.text != null && chip.label.startsWith("批注·")) {
    return (
      <span
        className="chat-chip chat-chip-annotation"
        data-kind="annotation"
        style={inline ? { display: "inline-flex", verticalAlign: "baseline" } : undefined}
      >
        <span className="c-ico"><QuoteIcon size={12} /></span>
        <span className="c-label">{chip.label}</span>
      </span>
    );
  }
  // 长文本卡片(kind=text 且带原文)单独渲染成可展开卡片。
  if (chip.kind.kind === "text" && chip.text != null) {
    return <LongTextChipCard chip={chip} />;
  }
  // skill 是后端语义类型；展示层继续复用 mention chip，保证历史/发送后气泡 WYSIWYG 不变。
  const displayKind = chip.kind.kind === "skill" ? "mention" : chip.kind.kind;
  return (
    <span
      className="chat-chip"
      data-kind={displayKind}
      style={inline ? { display: "inline-flex", verticalAlign: "baseline" } : undefined}
    >
      <span className="c-ico">
        {chip.kind.kind === "mention" || chip.kind.kind === "skill" ? (
          <SparkleIcon size={12} />
        ) : chip.kind.kind === "attach" ? (
          <FileChipIcon size={12} />
        ) : (
          <QuoteIcon size={12} />
        )}
      </span>
      <span className="c-label">{truncateLabel(chip.label)}</span>
      {chip.suffix && <span className="c-tag">{chip.suffix}</span>}
    </span>
  );
}

function UserPartWithChips({ body, chips }: { body: string; chips: ChatChip[] }) {
  const parts = parseChipRichText(body);
  return (
    <div style={{ marginBottom: 2, whiteSpace: "pre-wrap" }}>
      {parts.map((part, i) => {
        if (part.kind === "chip") {
          const chip = chips[part.index];
          if (!chip) return null;
          return <ChatChipBadge key={`chip-${i}`} chip={chip} inline />;
        }
        // Render text segment, preserving newlines
        const lines = part.text.split("\n");
        return (
          <span key={`text-${i}`}>
            {lines.map((line, j) => (
              <span key={j}>
                {line}
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

type PartViewProps = {
  part: MessagePart;
  streamActive?: boolean;
  isLastAssistantMessage?: boolean;
  patchRevealing?: boolean;
  livePatchCount?: number | null;
  liveHunkKey?: string;
  sessionId?: string | null;
  wholeDocReview?: boolean;
  wholeDocReviewKeys?: ReadonlySet<string>;
  skillLabels?: SkillLabelMap;
  materialLabels?: MaterialLabelMap;
  visibleAskUserAnswerToolCallIds?: ReadonlySet<string>;
};

const EMPTY_VISIBLE_ASK_USER_ANSWER_TOOL_CALL_IDS: ReadonlySet<string> = new Set();

const PartView = memo(function PartView({
  part,
  streamActive = false,
  isLastAssistantMessage = false,
  patchRevealing,
  livePatchCount,
  liveHunkKey,
  sessionId,
  wholeDocReview,
  wholeDocReviewKeys,
  skillLabels,
  materialLabels,
  visibleAskUserAnswerToolCallIds = EMPTY_VISIBLE_ASK_USER_ANSWER_TOOL_CALL_IDS,
}: PartViewProps) {
  const [open, setOpen] = useState(false);
  switch (part.kind) {
    case "text":
      if (part.data.body.trim() === "") return null;
      return <MarkdownText text={part.data.body} streamActive={streamActive} />;
    case "code":
      return (
        <pre style={{ marginBottom: 2 }}>
          <code>{part.data.body}</code>
        </pre>
      );
    case "toolCall":
      return (
        <ToolCallRow
          spec={part.data}
          skillLabels={skillLabels}
          materialLabels={materialLabels}
          visibleAskUserAnswerToolCallIds={visibleAskUserAnswerToolCallIds}
        />
      );
    case "askUserAnswerCard":
      return <AskUserAnswerCard data={part.data} />;
    case "actionCard":
      return <ActionCard data={part.data} />;
    case "thinking": {
      const thinkingText = part.data.steps.join("");
      const summaryLabel = getThinkingSummaryLabel(
        thinkingText.length,
        streamActive,
        isLastAssistantMessage,
      );
      return (
        <div data-wf="Thinking" style={{ marginBottom: 2 }}>
          <span
            className="wf-msg tool"
            role="button"
            tabIndex={0}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen((v) => !v);
              }
            }}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            <span className="caret" style={{ display: "inline-flex", alignItems: "center", marginRight: 4 }}>
              <CaretIcon size={11} direction={open ? "down" : "right"} />
            </span>
            <span style={{ color: "var(--ink-3)", fontSize: 13 }}>
              {summaryLabel}
            </span>
          </span>
          {open && (
            <div
              className="ws-tool-detail"
              style={{
                fontSize: 13,
                color: "var(--ink-3)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                padding: "6px 0 6px 16px",
                borderLeft: "2px solid var(--line-1, #e0e0e0)",
                marginLeft: 4,
                marginTop: 4,
              }}
            >
              {renderSimpleMarkdown(thinkingText)}
            </div>
          )}
        </div>
      );
    }
    case "citation":
      return (
        <span className="wf-chip mono" style={{ marginRight: 4 }}>
          ¶ {part.data.sourceRef.id}#{part.data.anchor}
        </span>
      );
    case "image":
      return <BrowserViewPart data={part.data} />;
    case "reviewOutcome":
      return <ReviewOutcomeCard data={part.data} />;
    case "patchSummary": {
      // 二次编辑审批态:左侧只显示一条合并条目。
      // N 的单一真相源:若这条气泡属于当前审批轮(hunkIds 与本轮一致),用派生的"真正落地处数"
      // livePatchCount,保证与正文标记数、序号严格一致;否则(历史气泡)用气泡自带 count。
      const partKey = getPatchSummaryKey(part.data.hunkIds);
      const isLive =
        livePatchCount != null && liveHunkKey != null && partKey === liveHunkKey;
      const reviewOutcome = getPatchSummaryReviewOutcome(part);
      const committedCount = (part.data as PatchSummaryDataWithReviewOutcome).appliedCount;
      const conflictCount = (part.data as PatchSummaryDataWithReviewOutcome).conflictCount;
      const count = reviewOutcome === "committed" && committedCount !== undefined
        ? committedCount
        : isLive
          ? (livePatchCount as number)
          : part.data.count;
      // 整篇改写(大改):live 由 wholeDocReview 判定;commit 后该轮 live 信号消失,靠 wholeDocReviewKeys 记忆。
      const rememberedWholeDocKey = buildWholeDocReviewKey(sessionId, partKey);
      const isWholeDoc =
        (isLive && wholeDocReview === true) ||
        (rememberedWholeDocKey ? (wholeDocReviewKeys?.has(rememberedWholeDocKey) ?? false) : false);
      // "· 待您审批"只在「当前活动审批轮」挂;已确认/历史气泡不再挂(审完了不该还显"待您审核")。
      const pendingSuffix = isLive ? " · 待确认" : "";
      // 打字进行中显示 loading;大改显「整篇改写」,小改显「已修改 N 处」(去 emoji)。
      // 注:审阅 chip 保持通用,不掺入"外部工具"维度——外部来源由 MessageRow 顶部一条独立信息条表达,二者解耦。
      return (
        <div data-wf="PatchSummary" style={{ marginBottom: 2 }}>
          <span
            className="wf-msg tool"
            style={{ color: "var(--ink-3)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
          >
            {reviewOutcome === "failed" ? (
              <>本轮修改未写入，正文保持上一版</>
            ) : reviewOutcome === "abandoned" ? (
              <>本轮候选已放弃，正文保持上一版</>
            ) : reviewOutcome === "committed" && committedCount !== undefined && conflictCount !== undefined && conflictCount > 0 ? (
              <>{committedCount} 处已写入，{conflictCount} 处因文档变化失效</>
            ) : reviewOutcome === "committed" && committedCount === undefined ? (
              <>本轮修改已写入</>
            ) : isLive && patchRevealing && !isWholeDoc ? (
              <>
                <span className="chat-loading-dots"><span /><span /><span /></span>
                正在应用修改…
              </>
            ) : isWholeDoc ? (
              // 大改:整篇审右侧已是终稿,左侧不再显"正在应用修改…"(内联揭示对整篇审无意义)。
              <>整篇改写{pendingSuffix}</>
            ) : (
              <>已修改 {count} 处{pendingSuffix}</>
            )}
          </span>
        </div>
      );
    }
  }
});

/**
 * 把"正在流式写入的一行"切成内联 run(0702:流式加粗实时渲染):
 * - 完整的 `**粗**` / `` `码` `` / `[文](url)` / `![图](url)` / 裸 http(s) URL 立即按样式渲染;
 * - **尾部未闭合的 `**`** 乐观按加粗渲染——闭合符流到时视觉零跳变,这就是"边写边粗";
 *   (未闭合反引号/半截链接不乐观,保持字面,与成行后 renderInline 的字面行为一致)
 * - `start` 为**可见内容**在原始行里的字符偏移(Array.from 计数,与 StreamingChars 的
 *   segment offset 同单位),供进场动画 key 稳定:标记符隐藏/闭合都不会让已有字重播动画。
 */
export function splitStreamingInlineRuns(line: string): StreamingInlineRun[] {
  return splitInlineMarkdownRuns(line, true);
}

/** 流式最后一行:内联样式实时渲染 + 每 run 内保持逐段进场动画(key=原文绝对偏移)。 */
function StreamingInlineLine({
  line,
  baseKey,
  config,
}: {
  line: string;
  baseKey: number;
  config: StreamFxConfig;
}) {
  const runs = useMemo(() => splitStreamingInlineRuns(line), [line]);
  return (
    <>
      {runs.map((run) => {
        if (run.kind === "image") {
          return (
            <span key={`i${run.start}`} className="u-thumb chat-markdown-image">
              <img src={run.src} alt={run.text} loading="lazy" />
            </span>
          );
        }
        const inner = (
          <StreamingChars text={run.text} baseKey={baseKey + run.start} config={config} />
        );
        if (run.kind === "bold") return <strong key={`b${run.start}`}>{inner}</strong>;
        if (run.kind === "code")
          return (
            <code key={`c${run.start}`} className="chat-inline-code">
              {inner}
            </code>
          );
        if (run.kind === "link")
          return (
            <a
              key={`l${run.start}`}
              className="chat-link"
              href={run.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {inner}
              <span className="ws-link-arrow"><ExternalLinkIcon size={11} /></span>
            </a>
          );
        return <span key={`p${run.start}`}>{inner}</span>;
      })}
    </>
  );
}

function MarkdownText({ text, streamActive }: { text: string; streamActive?: boolean }) {
  // 流式时:已完成的行照常按 markdown 渲染,"正在写的最后一行"走 StreamingInlineLine——
  // 逐段进场动画不变,同时内联 markdown(**粗**/`码`/链接)实时渲染(0702:此前最后一行是纯文本,
  // 单行短回复整条裸奔 `**`,同轮后续工具还在跑时会一直挂着)。成行或停流后整体按 markdown 渲染。
  // 结构行(列表/标题/引用/表格/围栏)不拆,避免破坏 markdown。效果由 streamFxConfig 默认柔焦档决定。
  const cfg = useStreamFxConfig();
  const split = useMemo(() => {
    if (!streamActive) return null;
    const lastNl = text.lastIndexOf("\n");
    const lastLine = text.slice(lastNl + 1);
    if (lastLine.length === 0) return null;
    if (/^(\s*[-*+]\s|\s*\d+[.、]\s|#{1,6}\s|>\s|\||```)/.test(lastLine)) return null;
    return {
      before: lastNl >= 0 ? text.slice(0, lastNl) : "",
      lastLine,
      baseKey: Array.from(text).length - Array.from(lastLine).length,
    };
  }, [text, streamActive]);

  const head = useMemo(() => renderSimpleMarkdown(split ? split.before : text), [split, text]);
  return (
    <div className="chat-markdown-body" style={{ marginBottom: 2 }}>
      {head}
      {split && (
        <div className="chat-markdown-inline" style={{ marginBottom: 1 }}>
          <StreamingInlineLine line={split.lastLine} baseKey={split.baseKey} config={cfg} />
        </div>
      )}
    </div>
  );
}

export function buildWholeDocReviewKey(
  sessionId: string | null | undefined,
  hunkKey: string | null | undefined,
): string | null {
  if (!sessionId || !hunkKey) return null;
  return `${sessionId}\u001f${hunkKey}`;
}

function shouldSuppressOverlayAskUserToolCall(
  spec: ToolCallSpec,
  visibleAskUserAnswerToolCallIds: ReadonlySet<string>,
): boolean {
  return (
    spec.body.kind === "askUser" &&
    spec.body.data.mode.kind === "overlay" &&
    spec.status.kind === "done" &&
    spec.result?.kind === "askUserAnswers" &&
    visibleAskUserAnswerToolCallIds.has(spec.id)
  );
}

function ToolCallRow({
  spec,
  skillLabels,
  materialLabels,
  visibleAskUserAnswerToolCallIds,
}: {
  spec: ToolCallSpec;
  skillLabels?: SkillLabelMap;
  materialLabels?: MaterialLabelMap;
  visibleAskUserAnswerToolCallIds: ReadonlySet<string>;
}) {
  const b = spec.body;
  const isRunning = spec.status.kind === "running";
  const isDone = spec.status.kind === "done";
  const isAborted = spec.status.kind === "aborted";
  // —— 保留生产组件(下一阶段单独定制) ——
  // 草稿迷你卡:流式摘录+字数,完成定格验收。
  if (b.kind === "writeDraftCard") {
    return <DraftMiniCard body={b.data} status={spec.status.kind} />;
  }
  // 二维码卡:产出物后置 —— 原位只渲简单条(生成二维码·已完成,走 UnifiedToolCall),
  // 真正的二维码由 MessageRow 后置到最终回复之后、圆角展示(不再在这里内联整张卡)。
  // ⚠️【勿删·铁律】docSuggestion **不是死代码**:它是右侧补丁审阅系统的**数据骨架**——
  //   bridge 把每个 patch 作为 docSuggestion `toolCallUpdated` 帧发出,前端 workspaceState
  //   存进 draft.toolCalls,protocol.ts 的 derivePatchPresentation 与 PM decoration 路径据此构建 diff /
  //   上一处下一处 / 接受拒绝 / patchSummary。**删掉 docSuggestion 的 emit 会让整个右侧审阅失效**
  //   (曾被自动评审误判为"早期废弃工具"而删,导致绿diff/审批条消失,已回退)。
  //   这里只是聊天侧的轻量状态行(右侧审阅另由 draft.toolCalls 驱动,与这条渲染无关)。
  if (b.kind === "docSuggestion" && b.data.kind === "suggestion") {
    const before = b.data.data.preview.deleteText;
    const truncated = truncateLabel(before);
    const isReviewing = spec.status.kind === "reviewing";
    const isAccepted = spec.status.kind === "accepted";
    const isRejected = spec.status.kind === "rejected";
    const isCommitted = spec.status.kind === "committed";
    const isFailed = spec.status.kind === "failed";
    const patchDone = isDone || isAccepted || isCommitted;
    const patchLabel = patchDone
      ? `已修改"${truncated}"`
      : isRejected
        ? `已拒绝"${truncated}"`
          : isReviewing
            ? `修改"${truncated}" · 待审阅`
            : isAborted
              ? "修改已中止"
              : isFailed
                ? "修改未完成"
                : `修改"${truncated}"中`;
    return (
      <div
        className="wf-msg tool"
        style={{ color: "var(--ink-3)", fontSize: 13, cursor: "default", display: "flex", alignItems: "center", gap: 6 }}
        data-wf="ToolCall"
      >
        {isRunning && <span className="chat-loading-dots"><span /><span /><span /></span>}
        {patchDone && <span style={{ color: "var(--ink-2)", display: "inline-flex" }}><CheckIcon size={12} /></span>}
        {isRejected && <span style={{ color: "var(--ink-3)", display: "inline-flex" }}><CloseIcon size={10} /></span>}
        {isReviewing && <span style={{ color: "var(--mark)", display: "inline-flex" }}><StatusDotIcon size={8} /></span>}
        {(isFailed || isAborted) && <span style={{ color: "var(--ink-3)", display: "inline-flex" }}><StatusSquareIcon size={8} /></span>}
        {!isRunning && !patchDone && !isRejected && !isReviewing && !isFailed && !isAborted && <span style={{ color: "var(--ink-3)", display: "inline-flex" }}><StatusDotIcon size={5} /></span>}
        {patchLabel}
      </div>
    );
  }
  // —— 确认方向问卷:fullpage 大表单态保留生产卡;overlay 走统一一行(落到 UnifiedToolCall) ——
  if (b.kind === "askUser" && b.data.mode.kind === "fullpage") {
    const isPending = spec.status.kind === "pending";
    // 完成:答案汇总卡
    if (isDone) {
      const questions = b.data.questions;
      const answersData = spec.result?.kind === "askUserAnswers" ? spec.result.data : null;
      if (questions.length === 0 && spec.result?.kind !== "askUserAnswers") {
        return null;
      }
      return (
        <div className="askuser-card" data-wf="ToolCall">
          <div className="askuser-card-header">
            <span className="askuser-card-check"><CheckIcon size={13} /></span>
            <span>已提交答案</span>
          </div>
          {answersData && (
            <div className="askuser-card-body">
              {questions.map((q) => {
                const answer = answersData[q.id];
                if (!answer) return null;
                let text = "";
                const qOptions = q.options ?? [];
                if (answer.chosen.length > 0 && qOptions.length > 0) {
                  const labelMap = new Map(qOptions.map((o) => [o.value, o.label]));
                  text = answer.chosen.map((v) => labelMap.get(v) ?? v).join("、");
                }
                if (answer.numericValue != null && q.kind.kind === "slider") {
                  const s = q.slider;
                  const atMax = s && answer.numericValue >= s.max && s.aboveLabel;
                  text = atMax ? s.aboveLabel! : `${answer.numericValue}${s?.unit ?? ""}`;
                }
                if (answer.freeText) {
                  const ft = answer.freeText.length > 30 ? answer.freeText.slice(0, 30) + "…" : answer.freeText;
                  text = text ? `${text}；"${ft}"` : `"${ft}"`;
                }
                if (!text) return null;
                return (
                  <div key={q.id} className="askuser-card-row">
                    <span className="askuser-card-q">{q.label}</span>
                    <span className="askuser-card-a">{text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    const restoreInterrupted =
      spec.result?.kind === "genericText" &&
      spec.result.data === ASK_USER_RESTORE_INTERRUPTED_MESSAGE;
    if (restoreInterrupted) {
      return (
        <div
          className="wf-msg tool"
          style={{ color: "var(--ink-3)", fontSize: 13, cursor: "default", display: "flex", alignItems: "center", gap: 6 }}
          data-wf="AskUserRestoreInterrupted"
          role="status"
        >
          <span style={{ color: "var(--ink-3)", display: "inline-flex" }} aria-hidden="true"><StatusDotIcon size={5} /></span>
          <span>{ASK_USER_RESTORE_INTERRUPTED_MESSAGE}</span>
        </div>
      );
    }
    const fullpageLabel = isAborted
      ? "已中止"
      : spec.status.kind === "failed"
        ? "未完成"
        : isPending
          ? "等待您的确认"
          : isRunning
            ? "正在准备问题"
            : (b.data.source ?? "确认方向");
    return (
      <div className="wf-msg tool" style={{ color: "var(--ink-3)", fontSize: 13, cursor: "default", display: "flex", alignItems: "center", gap: 6 }} data-wf="ToolCall">
        {isRunning && <span className="chat-loading-dots"><span /><span /><span /></span>}
        {isPending && <span style={{ color: "var(--mark)", animation: "au-pulse 1.4s infinite", display: "inline-flex" }}><StatusDotIcon size={8} /></span>}
        {!isRunning && !isPending && <span style={{ color: "var(--ink-3)", display: "inline-flex" }}><StatusDotIcon size={5} /></span>}
        {fullpageLabel}
      </div>
    );
  }
  // —— 其余(检索/配图/识图/命令/通用工具行/askUser overlay)→ 统一组件 ——
  // overlay askUser 提交后已有对应可见答卷卡时，不再重复显示「确认方向 · 已完成」。
  // 门槛在卡确实存在；卡未到、空答案无卡、pending/running 都继续保留工具行。
  if (shouldSuppressOverlayAskUserToolCall(spec, visibleAskUserAnswerToolCallIds)) {
    return null;
  }
  return (
    <UnifiedToolCall
      spec={spec}
      skillLabels={skillLabels}
      materialLabels={materialLabels}
      renderMarkdown={renderSimpleMarkdown}
    />
  );
}

function toolHost(u: unknown): string {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "");
  } catch {
    return String(u ?? "");
  }
}

export const EMPTY_HINT_TEXT =
  "你好,我是青简。想写点什么,可以直接在右侧动笔、挑个模板起头,也可以告诉我——比如「写一份面向投资人的产品 PRD」,我来帮你查资料、搭结构、写成稿。";

const EMPTY_HINT_CHARS = Array.from(EMPTY_HINT_TEXT);
const EMPTY_HINT_CHUNK_PATTERN = [2, 3, 2, 3, 3, 2, 3, 2] as const;
const EMPTY_HINT_DELAY_PATTERN_MS = [44, 50, 47, 49, 45, 50, 46, 48] as const;

export type EmptyHintTypewriterStep = {
  nextLength: number;
  delayMs: number;
};

export function buildEmptyHintTypewriterPlan(text: string): EmptyHintTypewriterStep[] {
  const chars = Array.from(text);
  const steps: EmptyHintTypewriterStep[] = [];
  let cursor = 0;
  let i = 0;
  while (cursor < chars.length) {
    const remaining = chars.length - cursor;
    let chunk: number = EMPTY_HINT_CHUNK_PATTERN[i % EMPTY_HINT_CHUNK_PATTERN.length]!;
    if (remaining <= 3) {
      chunk = remaining;
    } else if (remaining - chunk === 1 && chunk > 2) {
      chunk -= 1;
    }
    cursor = Math.min(chars.length, cursor + chunk);
    steps.push({
      nextLength: cursor,
      delayMs: EMPTY_HINT_DELAY_PATTERN_MS[i % EMPTY_HINT_DELAY_PATTERN_MS.length]!,
    });
    i += 1;
  }
  return steps;
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const matchMedia = window.matchMedia;
  if (typeof matchMedia !== "function") return false;
  return matchMedia.call(window, "(prefers-reduced-motion: reduce)").matches;
}

function useEmptyHintReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const matchMedia = window.matchMedia;
    if (typeof matchMedia !== "function") return;
    const query = matchMedia.call(window, "(prefers-reduced-motion: reduce)");
    const handleChange = () => setReducedMotion(query.matches);
    handleChange();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => query.removeEventListener("change", handleChange);
    }
    query.addListener?.(handleChange);
    return () => query.removeListener?.(handleChange);
  }, []);

  return reducedMotion;
}

function EmptyHint() {
  // 工程预置引导开场白(非 AI 生成、不调模型),复用现成 AI 气泡样式。
  const reducedMotion = useEmptyHintReducedMotion();
  const config = useStreamFxConfig();
  const [visibleLength, setVisibleLength] = useState(() =>
    readPrefersReducedMotion() ? EMPTY_HINT_CHARS.length : 0,
  );
  const completedRef = useRef(visibleLength >= EMPTY_HINT_CHARS.length);
  const planRef = useRef<EmptyHintTypewriterStep[] | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      completedRef.current = true;
      setVisibleLength(EMPTY_HINT_CHARS.length);
      return;
    }
    if (completedRef.current) return;

    const plan = planRef.current ?? buildEmptyHintTypewriterPlan(EMPTY_HINT_TEXT);
    planRef.current = plan;
    let stepIndex = plan.findIndex((step) => step.nextLength > visibleLength);
    if (stepIndex < 0) {
      completedRef.current = true;
      return;
    }

    let timeoutId: number | null = null;
    const scheduleNext = () => {
      const step = plan[stepIndex];
      if (!step) {
        completedRef.current = true;
        return;
      }
      timeoutId = window.setTimeout(() => {
        setVisibleLength(step.nextLength);
        stepIndex += 1;
        if (step.nextLength >= EMPTY_HINT_CHARS.length || stepIndex >= plan.length) {
          completedRef.current = true;
          timeoutId = null;
          return;
        }
        scheduleNext();
      }, step.delayMs);
    };

    scheduleNext();
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [reducedMotion]);

  const visibleText =
    visibleLength >= EMPTY_HINT_CHARS.length
      ? EMPTY_HINT_TEXT
      : EMPTY_HINT_CHARS.slice(0, visibleLength).join("");

  return (
    <div className="wf-msg agent" data-wf="ChatEmptyHint">
      <div style={{ marginBottom: 2 }}>
        {reducedMotion ? (
          visibleText
        ) : (
          <StreamingChars text={visibleText} baseKey={0} config={config} />
        )}
      </div>
    </div>
  );
}

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
import { InkBubble } from "../../../system";
import { SparkleIcon, FileChipIcon } from "../../../system/SkillMenu";
import { StreamingChars, useStreamFxConfig } from "./StreamingText";
import type { StreamFxConfig } from "../data/streamFxConfig";
import { truncateLabel } from "../textUtils";
import { countChars, longTextPreview, LongTextFullscreen } from "../../../system/longText";
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
import { CheckIcon } from "./icons";
import { useSkills } from "../../../overlays/settings/useSkills";
import { useResourceList } from "../../../system/resources";

export interface ChatMessageListProps {
  messages: ChatMessage[];
  /** Show a loading indicator at the bottom (e.g. during document generation). */
  showLoading?: boolean;
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

export function ChatMessageList({
  messages,
  showLoading,
  streamActive,
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
    () => computeTurnFlags(messages, lastAssistantMessageId, streamActive, liveHunkKey),
    [messages, lastAssistantMessageId, streamActive, liveHunkKey],
  );
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
            turnSettled={flags?.turnSettled ?? false}
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
  turnSettled?: boolean;
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
  reviewOutcome?: "abandoned";
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

function sanitizeVisibleText(body: string): string | null {
  const normalized = body.replace(/\r\n/g, "\n");
  if (isInternalTextBlock(normalized)) return null;
  const lines = normalized
    .split("\n")
    .filter((line) => !isInternalTextLine(line));
  const cleaned = lines.join("\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function stripMarkdownFence(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return match ? match[1]!.trim() : text.trim();
}

function isInternalTextBlock(body: string): boolean {
  const text = stripMarkdownFence(body);
  if (/\bAI-IR\b/i.test(text)) return true;
  if (/\[(?:tool-result|tool-call|askUserAnswers|internal|transcript)\]/i.test(text)) return true;
  if (/\bnumericValue\b/.test(text)) return true;
  if (/\bblock-[A-Za-z0-9_-]+\b/.test(text)) return true;
  if (/^\s*(?:system|developer)\s*:/i.test(text)) return true;
  if (/you are (?:chatgpt|codex|qingagent)/i.test(text)) return true;
  if (/^\s*[\[{]/.test(text) && /"(?:blocks|blockId|attrs|content|chosen|freeText|numericValue|tool|args|result)"/.test(text)) {
    return true;
  }
  return false;
}

function isInternalTextLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (isInternalTextBlock(text)) return true;
  if (/^(?:let me|let's|i need to|i should|i will|i'll|we need to|we should|now i|the user wants|need to)\b/i.test(text)) {
    return true;
  }
  return /\b(?:different approach|tool result|tool call|system prompt|developer instruction)\b/i.test(text);
}

// 外部提案来源:服务端把调用方编进消息 id(external-<client>-<uuid>);web 只做展示映射。
export type ExternalClient = "claude-code" | "codex" | "agent";

export function parseExternalClient(id: string): ExternalClient | null {
  const match = /^external-([a-z0-9]+)-/.exec(id);
  if (!match) return null;
  switch (match[1]) {
    case "claudecode":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      // 老格式 external-<uuid> 或未知来源:统一按"外部 Agent"展示。
      return "agent";
  }
}

const EXTERNAL_AGENT_LABEL: Record<ExternalClient, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
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

// 官方 Codex 标志(白底圆角方 + 蓝紫渐变脸),取自 @lobehub/icons 的 codex 图标。
function CodexLogo() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff" />
      <path
        fill="url(#qa-codex-grad)"
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
      />
      <defs>
        <linearGradient id="qa-codex-grad" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ExternalAgentLogo({ client }: { client: ExternalClient }) {
  if (client === "claude-code") return <ClaudeCodeRobot />;
  if (client === "codex") return <CodexLogo />;
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
  turnSettled = false,
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
  // 只要「尾段 part 是 thinking」(= 当前正在返回 reasoning)就出「思考中」——不依赖是否解析到中文句子,
  // 下面那行文案只是辅助。一旦尾段变成文本回复/工具调用(下一轮输出开始),思考条立即掐断。
  // debug 模式:思考 part 照旧各自渲染(可展开)。
  const lastPart = message.parts[message.parts.length - 1];
  const thinkingTailActive =
    !debugMode && streamActive && isLastAssistantMessage && lastPart?.kind === "thinking";
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
    (vp) => vp.part.kind === "toolCall" && ARTIFACT_BODY_KINDS.has(vp.part.data.body.kind),
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
      <UImageSummary images={svgImages} />
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

type TurnFoldFlag = { turnSettled: boolean; isFinalAgentMsg: boolean };

// 把消息按"轮"分组(user 消息开启新轮),逐轮算两个折叠判定标记:
//  - turnSettled:本轮已结清 —— 不是进行中的流式轮、轮内没有运行中/等待中的工具、
//    也没有待审批的 live patch(审批未接受/放弃前不折)。
//  - isFinalAgentMsg:该消息是本轮最后一条 agent 消息(过程折叠只挂在收尾消息上)。
function computeTurnFlags(
  messages: ChatMessage[],
  lastAssistantMessageId: string | null,
  streamActive: boolean,
  liveHunkKey: string | undefined,
): Map<string, TurnFoldFlag> {
  const flags = new Map<string, TurnFoldFlag>();
  const turns: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role.kind === "user") turns.push([m]);
    else {
      if (turns.length === 0) turns.push([]);
      turns[turns.length - 1]!.push(m);
    }
  }
  for (const turn of turns) {
    const agentMsgs = turn.filter((m) => m.role.kind === "agent");
    const finalAgentId = agentMsgs.length ? agentMsgs[agentMsgs.length - 1]!.id : null;
    const isActiveTurn =
      streamActive &&
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
    const settled = !isActiveTurn && !anyRunningTool && !anyLivePatch;
    for (const m of turn) {
      flags.set(m.id, { turnSettled: settled, isFinalAgentMsg: m.id === finalAgentId });
    }
  }
  return flags;
}

function getPatchSummaryKey(hunkIds: readonly string[]): string {
  return hunkIds.slice().sort().join(",");
}

function getPatchSummaryReviewOutcome(part: PatchSummaryPart): "abandoned" | null {
  const outcome = (part.data as PatchSummaryDataWithReviewOutcome).reviewOutcome;
  return outcome === "abandoned" ? outcome : null;
}

/**
 * Render chat text with basic markdown support:
 * - **bold**
 * - `code`
 * - Unordered lists (- item / * item)
 * - Ordered lists (1. item)
 * - Newlines
 */
export function renderSimpleMarkdown(text: string) {
  const lines = text.split("\n");
  const result: JSX.Element[] = [];
  let listItems: JSX.Element[] = [];
  let listType: "ul" | "ol" | null = null;
  let blockKey = 0;

  function flushList() {
    if (listItems.length > 0 && listType) {
      const Tag = listType;
      result.push(
        <Tag key={`list-${blockKey++}`} style={{ margin: "4px 0 4px 16px", paddingLeft: 0 }}>
          {listItems}
        </Tag>,
      );
      listItems = [];
      listType = null;
    }
  }

  function renderInline(str: string, key: string): JSX.Element {
    const parts = str.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
    const els: (string | JSX.Element)[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (p.startsWith("**") && p.endsWith("**")) {
        els.push(<strong key={`${key}-b${i}`}>{p.slice(2, -2)}</strong>);
      } else if (p.startsWith("`") && p.endsWith("`")) {
        els.push(
          <code key={`${key}-c${i}`} className="chat-inline-code">
            {p.slice(1, -1)}
          </code>,
        );
      } else if (link) {
        els.push(
          <a key={`${key}-l${i}`} className="chat-link" href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
            <span className="ws-link-arrow"> ↗</span>
          </a>,
        );
      } else {
        els.push(p);
      }
    }
    return <span key={key}>{els}</span>;
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
    const ulMatch = line.match(/^[\s]*[-*]\s+(.*)/);
    const olMatch = line.match(/^[\s]*\d+[.)]\s+(.*)/);
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
      } else if (ulMatch) {
        if (listType !== "ul") flushList();
        listType = "ul";
        listItems.push(<li key={`li-${i}`}>{renderInline(ulMatch[1]!, `li-${i}`)}</li>);
      } else if (olMatch) {
        if (listType !== "ol") flushList();
        listType = "ol";
        listItems.push(<li key={`li-${i}`}>{renderInline(olMatch[1]!, `li-${i}`)}</li>);
      } else {
        flushList();
        const trimmed = line.trim();
        const linkOnly = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        const bareUrl = trimmed.match(/^(https?:\/\/[^\s]+)$/);
        if (linkOnly) {
          // 整行就是一个链接 → demo 链接卡(标题 + 域名↗)
          result.push(<ChatLinkCard key={`lc-${i}`} title={linkOnly[1]!} url={linkOnly[2]!} />);
        } else if (bareUrl) {
          result.push(<ChatLinkCard key={`lc-${i}`} title={toolHost(bareUrl[1])} url={bareUrl[1]!} />);
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
          <span className="ws-link-arrow"> ↗</span>
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
  return (
    <div className="askuser-card askuser-card--answers" data-wf="ActionCard" aria-label={data.title}>
      <div className="askuser-card-header">
        <span className="askuser-card-check" aria-hidden="true">
          {data.icon ?? <CheckIcon size={13} />}
        </span>
        <span>{data.title}</span>
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
const CHIP_KIND_ICONS: Record<string, string> = { sel: "❝", attach: "📎", mention: "@" };

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
        title="点击查看全文"
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
        <span className="c-ico">※</span>
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
          CHIP_KIND_ICONS[chip.kind.kind] ?? "❝"
        )}
      </span>
      <span className="c-label">{truncateLabel(chip.label)}</span>
      {chip.suffix && <span className="c-tag">{chip.suffix}</span>}
    </span>
  );
}

function UserPartWithChips({ body, chips }: { body: string; chips: ChatChip[] }) {
  // Split body by chip markers, preserving the markers as separate tokens
  const segments = body.split(/(\{\{chip:\d+\}\})/);
  return (
    <div style={{ marginBottom: 2, whiteSpace: "pre-wrap" }}>
      {segments.map((seg, i) => {
        const markerMatch = seg.match(/^\{\{chip:(\d+)\}\}$/);
        if (markerMatch) {
          const chipIdx = parseInt(markerMatch[1]!, 10);
          const chip = chips[chipIdx];
          if (!chip) return null;
          return <ChatChipBadge key={`chip-${i}`} chip={chip} inline />;
        }
        // Render text segment, preserving newlines
        if (seg === "") return null;
        const lines = seg.split("\n");
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
            <span className="caret" style={{ fontSize: 10, marginRight: 4 }}>{open ? "▾" : "▸"}</span>
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
      const count = isLive ? (livePatchCount as number) : part.data.count;
      const reviewOutcome = getPatchSummaryReviewOutcome(part);
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
            {reviewOutcome === "abandoned" ? (
              <>本轮候选已放弃，正文保持上一版</>
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

/** 流式最后一行的内联 run:与 renderInline 同一套内联语法(粗体/行内码/链接)。 */
export type StreamingInlineRun =
  | { kind: "plain" | "bold" | "code"; text: string; start: number }
  | { kind: "link"; text: string; href: string; start: number };

/**
 * 把"正在流式写入的一行"切成内联 run(0702:流式加粗实时渲染):
 * - 完整的 `**粗**` / `` `码` `` / `[文](url)` 立即按样式渲染(隐藏标记符);
 * - **尾部未闭合的 `**`** 乐观按加粗渲染——闭合符流到时视觉零跳变,这就是"边写边粗";
 *   (未闭合反引号/半截链接不乐观,保持字面,与成行后 renderInline 的字面行为一致)
 * - `start` 为**可见内容**在原始行里的字符偏移(Array.from 计数,与 StreamingChars 的
 *   segment offset 同单位),供进场动画 key 稳定:标记符隐藏/闭合都不会让已有字重播动画。
 */
export function splitStreamingInlineRuns(line: string): StreamingInlineRun[] {
  const runs: StreamingInlineRun[] = [];
  const chars = Array.from(line);
  // 与 renderInline 同一 token 集;用字符数组扫描保证偏移按码点计。
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  const pushPlain = (from: number, to: number) => {
    if (to > from) runs.push({ kind: "plain", text: chars.slice(from, to).join(""), start: from });
  };
  // 在"字符偏移"空间里跑正则:对 BMP 外码点,String.index 与 char 偏移会漂;
  // 聊天正文含 emoji 常见,统一把 match.index 换算成字符偏移。
  const toCharOffset = (strIndex: number) => Array.from(line.slice(0, strIndex)).length;
  let cursor = 0;
  for (const m of line.matchAll(tokenRe)) {
    const tok = m[0]!;
    const startCh = toCharOffset(m.index!);
    pushPlain(cursor, startCh);
    const tokLen = Array.from(tok).length;
    if (tok.startsWith("**")) {
      runs.push({ kind: "bold", text: Array.from(tok).slice(2, -2).join(""), start: startCh + 2 });
    } else if (tok.startsWith("`")) {
      runs.push({ kind: "code", text: Array.from(tok).slice(1, -1).join(""), start: startCh + 1 });
    } else {
      const link = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)!;
      runs.push({ kind: "link", text: link[1]!, href: link[2]!, start: startCh + 1 });
    }
    cursor = startCh + tokLen;
  }
  // 尾巴:检查未闭合的 `**`(乐观加粗)。
  const tail = chars.slice(cursor).join("");
  const openIdx = tail.lastIndexOf("**");
  if (openIdx >= 0) {
    const openCh = cursor + Array.from(tail.slice(0, openIdx)).length;
    pushPlain(cursor, openCh);
    const content = chars.slice(openCh + 2).join("");
    if (content.length > 0) runs.push({ kind: "bold", text: content, start: openCh + 2 });
  } else {
    pushPlain(cursor, chars.length);
  }
  return runs;
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
              <span className="ws-link-arrow"> ↗</span>
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
    <div style={{ marginBottom: 2 }}>
      {head}
      {split && (
        <div style={{ marginBottom: 1 }}>
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
  // —— 保留生产组件(下一阶段单独定制) ——
  // 草稿迷你卡:流式摘录+字数,完成定格验收。
  if (b.kind === "writeDraftCard") return <DraftMiniCard body={b.data} />;
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
          : isFailed
            ? "修改已失效,未应用"
            : `修改"${truncated}"中`;
    return (
      <div
        className="wf-msg tool"
        style={{ color: "var(--ink-3)", fontSize: 13, cursor: "default", display: "flex", alignItems: "center", gap: 6 }}
        data-wf="ToolCall"
      >
        {isRunning && <span className="chat-loading-dots"><span /><span /><span /></span>}
        {patchDone && <span style={{ color: "var(--ink-2)", display: "inline-flex" }}><CheckIcon size={12} /></span>}
        {isRejected && <span style={{ color: "var(--ink-3)" }}>{"✗"}</span>}
        {isReviewing && <span style={{ color: "var(--mark)" }}>{"●"}</span>}
        {isFailed && <span style={{ color: "var(--danger, #b42318)" }}>{"!"}</span>}
        {!isRunning && !patchDone && !isRejected && !isReviewing && !isFailed && <span style={{ color: "var(--ink-3)" }}>{"·"}</span>}
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
    const fullpageLabel = isPending ? "等待您的确认" : isRunning ? "正在准备问题" : (b.data.source ?? "确认方向");
    return (
      <div className="wf-msg tool" style={{ color: "var(--ink-3)", fontSize: 13, cursor: "default", display: "flex", alignItems: "center", gap: 6 }} data-wf="ToolCall">
        {isRunning && <span className="chat-loading-dots"><span /><span /><span /></span>}
        {isPending && <span style={{ color: "var(--mark)", animation: "au-pulse 1.4s infinite" }}>●</span>}
        {!isRunning && !isPending && <span style={{ color: "var(--ink-3)" }}>{"·"}</span>}
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
  return <UnifiedToolCall spec={spec} skillLabels={skillLabels} materialLabels={materialLabels} />;
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

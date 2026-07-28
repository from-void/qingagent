import type {
  BridgeFrame,
  ChatChip,
  ChatMessage,
  MessagePart,
  ReviewContext,
} from "@qingagent/contract-ts";
import type { ToolsInput } from "@mastra/core/agent";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { buildChipOnlyGuidance, composeInlineChipText } from "../session/chipOnlyNote.js";
import { createSkillChipInstructionLoader } from "./skillChipInstructionLoader.js";
import {
  acquireQingagentSessionWorkspace,
  getQingagentSkills,
  QINGAGENT_SESSION_WORKSPACE_CONTEXT_KEY,
  qingagentAgent,
} from "../agents/qingagent.js";
import type { SessionWorkspaceLease } from "../workspace/sessionWorkspace.js";
import { guardContext, withPrefixCacheGuardContext } from "../llm/prefixCacheGuard.js";
import {
  beginSessionSnapshotTurn,
  resolveModelParams,
  resolveProtocol,
} from "../llm/modelConfig.js";
import { mastra } from "../mastra.js";
import type { SessionState } from "../session/sessionState.js";
import {
  beginTurnOwnership,
  bindTurnOwnershipToRequestContext,
  endTurnOwnership,
} from "../session/turnOwnership.js";
import { isDirectionReset } from "./questionnaireTools.js";
import {
  activeSuspensionOwnedBy,
  clearSuspension,
  hasActiveSuspension,
} from "../session/sessionState.js";
import { isServerReanchorEnabled } from "../doc-engine/draftFeatureFlags.js";
import { resolveFileIds } from "../session/uploadFileResolver.js";
import { pmToMarkdown } from "@qingagent/pm-schema";
import { schedulePersist, QINGAGENT_RESOURCE_ID } from "../session/threadPersistence.js";
import {
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_MAX_STEPS,
  TURN_RETRY_LIMIT,
} from "./agentLimits.js";
import {
  chatMessageAdded,
  newId,
  nowIso,
  streamEnd,
  streamStart,
  toolCallUpdated,
} from "./frames.js";
import { normalizeClientMessageId } from "./clientMessageId.js";
import { currentDateTimeContext } from "../session/timeProvider.js";
import {
  buildAgentTracingMetadata,
  sessionIdToTraceId,
} from "./agentSpans.js";
import {
  buildTableSelectionContext,
  buildSectionToLineMap,
  resolveSelectionChipBlocks,
  validateTableSelectionFreshness,
} from "../doc-engine/draftReadContext.js";
import { syncContentAndProjectDocState } from "../doc-engine/docStateSync.js";
import { emitProjectedDocState } from "../doc-engine/docStateMachine.js";
import {
  buildCapabilityToolSearchBridge,
  buildAttachmentContext,
  buildCapabilityTools,
  createSessionScopedTools,
  ensureSessionToolSearchProcessor,
  resolveSelectedSkillNames,
  type SelectedSkillInput,
} from "../session/sessionTools.js";
import {
  QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY,
  isQingagentToolSearchEnabled,
  preloadQingagentToolSearchTools,
} from "../agents/toolSearch.js";
import {
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  buildTodoAwarenessContent,
} from "./todoAwareness.js";
import {
  ensureWorkingMemoryPromptInPlace,
  QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY,
} from "../llm/workingMemoryPrompt.js";
import { QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY } from "../llm/omObservationsPrompt.js";
import { ensureWorkingMemorySnapshot } from "../session/workingMemory.js";
import {
  buildDocVersionAwarenessContent,
  QINGAGENT_DOC_VERSION_AWARENESS_REQUEST_CONTEXT_KEY,
} from "../llm/docVersionAwarenessPrompt.js";
import {
  isOmSidecarEnabled,
  nextOmTurnIndex,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
} from "../session/omSidecar.js";
import {
  createTurnCompletion,
  finalizeLingeringRunningToolCalls,
} from "./turnCleanup.js";
import {
  markDiagramVizEditing,
  type DiagramVizLanguage,
} from "../skills/diagramViz.js";
import { activateSkill } from "../skills/writeInject.js";
import {
  appendVisibleStreamErrorText,
  delayMs,
  draftingFailedFrame,
  IDLE_TIMEOUT_ABORT_REASON,
  isUserAbortSignal,
  streamErrorDetails,
  streamErrorMessage,
  turnRetryDelayMs,
} from "./streamErrors.js";
import { formatTurnLog, processAgentStream } from "./processAgentStream.js";
import type { ProcessOutcome } from "./processAgentStream.js";
import { resumeConfirmDecision } from "./confirmResume.js";
import { confirmService } from "../confirm/confirmService.js";
import {
  PROMISE_CONTINUATION_SYSTEM_MESSAGE,
  shouldContinuePromisedAction,
} from "./promiseContinuation.js";

const logger = mastra.getLogger();

export interface RunAgentTurnControl {
  /** 当前轮由新消息抢占旧轮而来；只用于注入轮次边界，不改变 FIFO。 */
  preemptedByNewMessage?: boolean;
}

export interface RunAgentTurnRuntimeOptions extends RunAgentTurnControl {
  /** 仅追加到模型侧当轮 user message，不进入可见用户气泡或 system prompt 前缀。 */
  turnContext?: string;
  /** idle-timeout 自动重试上限；只供已消费一次额度的恢复链路收紧为 0。 */
  idleTimeoutRetryLimit?: number;
  /** 测试/受控调用覆盖，生产默认仍取 agentLimits。 */
  idleTimeoutMs?: number;
  /** 测试/受控调用覆盖，生产默认仍取 agentLimits。 */
  firstChunkTimeoutMs?: number;
}

export const PREEMPTED_TURN_GUIDANCE =
  "\n\n[系统·本轮边界]上一轮已因这条新消息被中断。本轮用户输入是最高优先级，必须先处理本轮文本；" +
  "除非本轮文本明确要求继续等待、查询或终止上一轮后台进程，否则不得自动调用 get_process_output、kill_process 或其他工具续跑旧 PID。" +
  "抢占本身不会终止后台进程，其当前状态仍待确认。";

// ---------------------------------------------------------------------------
// runAgentTurn — unified entry point for all user interactions
// ---------------------------------------------------------------------------

export async function* runAgentTurn(
  state: SessionState,
  userText: string,
  fileIds: string[] = [],
  chips: ChatChip[] = [],
  selectedSkills: SelectedSkillInput[] = [],
  // 显示用的消息 parts 覆盖：传入时 chatHistory 的用户消息用它渲染（如审核结果缩略卡），
  // 而模型侧 state.messages 仍收 userText 全文——展示与模型上下文解耦。默认 null = 纯文本气泡。
  userDisplayParts: MessagePart[] | null = null,
  clientMessageId?: string,
  richText?: string,
  reviewContext?: ReviewContext,
  runtimeOptions: RunAgentTurnRuntimeOptions = {},
): AsyncGenerator<BridgeFrame> {
  const turnStartedAt = Date.now();
  const streamId = newId();
  const tableSelectionFreshness = validateTableSelectionFreshness(state, chips);
  if (!tableSelectionFreshness.ok) {
    logger.warn("Rejected stale table selection before agent turn", {
      sessionId: state.sessionId,
      streamId,
      tableRef: tableSelectionFreshness.tableRef,
      docVersion: state.docVersion,
    });
    yield streamStart(streamId);
    yield draftingFailedFrame(streamId, tableSelectionFreshness.reason, false);
    yield streamEnd(streamId, { kind: "error", data: tableSelectionFreshness.reason });
    return;
  }
  let activeRunId: string | null = null;
  let turnOutcome: "ok" | "error" | "cancelled" = "ok";
  let abortController = new AbortController();
  let turnOwnership = beginTurnOwnership(state, `${streamId}:attempt:0`);
  const turnCompletion = createTurnCompletion();
  let turnWasUserAborted = false;
  const omSidecarEnabled = isOmSidecarEnabled();
  let omTurnIndex: number | null = null;
  if (omSidecarEnabled) {
    state.turnCounter = nextOmTurnIndex(state);
    omTurnIndex = state.turnCounter;
  }
  state.streamId = streamId;
  state._abortController = abortController;
  state._activeTurnPromise = turnCompletion.promise;
  state._suspendedThisTurn = false;
  let turnRequestContext: RequestContext | undefined;
  let sessionWorkspaceLease: SessionWorkspaceLease | null = null;
  let omTurnStartMessageIndex = state.messages.length;
  const agentMessageId = newId();

  try {
    // Resolve workspace skills defensively: skill discovery / maybeRefresh must
    // never abort the turn. On any failure we log and fall back to the default
    // capability toolset so static tools (parseFile, …), gated capability tools
    // (fetchArticle, webSearch, …) and the
    // normal stream error-frame path still work.
    let selectedSkillNames: string[] = [];
    let workspaceSkills: Awaited<ReturnType<typeof getQingagentSkills>> | null = null;
    try {
      workspaceSkills = await getQingagentSkills();
      await workspaceSkills.maybeRefresh();
      selectedSkillNames = await resolveSelectedSkillNames(selectedSkills, workspaceSkills);
      state.selectedSkills = selectedSkillNames;
      state.selectedSkillsHadSelection = selectedSkills.length > 0;
    } catch (error) {
      logger.error("Skill resolution failed; continuing with default guidance", {
        sessionId: state.sessionId,
        error: String(error),
      });
      state.selectedSkills = [];
      state.selectedSkillsHadSelection = false;
    }
    const toolSearchEnabled = isQingagentToolSearchEnabled();
    const capabilityToolSearch = toolSearchEnabled
      ? await buildCapabilityToolSearchBridge(selectedSkillNames)
      : null;
    const capabilityTools = capabilityToolSearch?.alwaysTools ?? await buildCapabilityTools();

  logger.info("runAgentTurn started", {
    sessionId: state.sessionId,
    streamId,
    messagePreview: userText.slice(0, 120),
    fileCount: fileIds.length,
    chipCount: chips.length,
    selectedSkills: selectedSkillNames,
    toolSearchEnabled,
    serverReanchorEnabled: isServerReanchorEnabled(),
  });

  console.info(formatTurnLog("streamStart", {
    session: state.sessionId,
    stream: streamId,
    prepMs: Date.now() - turnStartedAt,
  }));
  yield streamStart(streamId);
  yield* emitProjectedDocState(state, "agent_turn_started");

  const savedFiles = await resolveFileIds(fileIds);
  const attachmentCtx = buildAttachmentContext(savedFiles, { toolSearchEnabled });
  const sectionToLine =
    state.legacySections.length > 0
      ? buildSectionToLineMap(state.legacySections)
      : null;
  if (sectionToLine) {
    state._sectionToLine = sectionToLine;
  }

  // Build selection context from chips so the agent knows which text
  // the user highlighted. This is the key signal for readDraft/editDraft.
  const selectionChips = chips.filter(
    (c) => c.kind.kind === "selection",
  );
  const selectionDiagramLanguages = new Set<DiagramVizLanguage>();

  // Store chips on state so validatePatch can use from/to for
  // position-based matching later in this turn.
  state._currentChips = selectionChips.length > 0 ? selectionChips : null;

  let selectionCtx =
    selectionChips.length > 0
      ? `\n\n【用户选中的文档片段】\n${selectionChips
          .map((c) => {
            const tableSelectionContext = buildTableSelectionContext(state, c);
            if (tableSelectionContext) return tableSelectionContext;
            // 优先按稳定 blockId 精确命中(对图表/图片等原子块也有效,且不受位置估算漂移影响)。
            const exactBlocks = resolveSelectionChipBlocks(state, c);
            if (exactBlocks.length > 0) {
              for (const exactBlock of exactBlocks) {
                if (exactBlock.type === "diagram" && exactBlock.lang) {
                  selectionDiagramLanguages.add(exactBlock.lang);
                }
              }
              if (exactBlocks.length > 1) {
                const refs = exactBlocks.map((item) => item.ref);
                const summaries = exactBlocks
                  .map(
                    (item, index) =>
                      `${index + 1}. ref="${item.ref}"（类型:${item.type}）${item.parentListRef ? `, 父列表 ref="${item.parentListRef}"` : ""}: ${item.summary}`,
                  )
                  .join("\n");
                return (
                  `> 已选中 ${exactBlocks.length} 个列表行${c.suffix ? `（位置：${c.suffix}）` : ""}\n${summaries}` +
                  `\n\n[editDraft 定位提示]\n` +
                  `- 用户精确选中了这些列表行 refs=${JSON.stringify(refs)}，直接对这些 item ref 操作，不要再用 query 模糊查找别的块。\n` +
                  `- 需要读取时，分别调用 readDraft(mode:"range", from:<itemRef>, to:<itemRef>, includeText:true) 取得该行 text。\n` +
                  `- P2 先做文本级修改:对每个目标行调用 editDraft action:"replaceText" withinRef:<itemRef>；不要 replaceBlock 整个父列表，不要改未选中的 sibling 行。\n` +
                  `- 只改标记时可用 editDraft action:"markText" withinRef:<itemRef>，但纯标记修改当前行级审阅高亮可能不明显；能改文字时优先 replaceText。\n` +
                  `- 工具失败时按 error 重新定位或询问用户，不能声称已生效。`
                );
              }
              const exact = exactBlocks[0]!;
              // 文本块的【部分选区】:label 是整段的真子串时,额外点名"块内具体选中的那段",
              // 让 markText 精确命中它而非整块重写。原子块的 label 是类型名(如"图表"),
              // 不是 summary 的子串,不触发——它本就走整块 replaceBlock。
              const label = typeof c.label === "string" ? c.label.trim() : "";
              const subSelectionLine =
                label &&
                label !== exact.summary.trim() &&
                exact.summary.includes(label)
                  ? `\n- 用户在该块内具体选中的文字是:${JSON.stringify(label)}——只改这段文字时用 replaceText withinRef 精确替换,只改标记时用 markText withinRef,别整块重写。\n- replaceText 的 find/replace 必须**范围对齐选中的这段**:replace 只是这段文字的改写,**绝不能把选区外、块里已经存在的紧邻文字(如这段后面的标题后缀)再写进 replace**——否则那段会和保留的原文重复拼接(出现「…治理：架构…治理」式重复)。若你的意图其实是改写**整块**(连同选区外部分,如把整条标题改得更学术),就改用 replaceBlock 重写整块,或把 find 设成该块当前**完整全文**、replace 设成新的完整全文。`
                  : "";
              if (exact.type === "listItem" || exact.type === "taskItem") {
                return (
                  `> ${exact.summary}${c.suffix ? `（位置：${c.suffix}）` : ""}` +
                  `\n\n[editDraft 定位提示]\n` +
                  `- 用户精确选中了列表行 ref="${exact.ref}"（类型:${exact.type}${exact.parentListRef ? `, 父列表 ref="${exact.parentListRef}"` : ""}）这一行，直接对这个 item ref 操作，不要再用 query 模糊查找别的块。\n` +
                  `- 读取该行:readDraft(mode:"range", from:"${exact.ref}", to:"${exact.ref}", includeText:true) 取得该行 text。\n` +
                  `- P2 先做文本级修改:调用 editDraft action:"replaceText" withinRef:"${exact.ref}"；不要 replaceBlock 整个父列表，不要改未选中的 sibling 行。\n` +
                  `- 只改标记时可用 editDraft action:"markText" withinRef:"${exact.ref}"，但纯标记修改当前行级审阅高亮可能不明显；能改文字时优先 replaceText。${subSelectionLine}\n` +
                  `- 工具失败时按 error 重新定位或询问用户，不能声称已生效。`
                );
              }
              return (
                `> ${exact.summary}${c.suffix ? `（位置：${c.suffix}）` : ""}` +
                `\n\n[editDraft 定位提示]\n` +
                `- 用户精确选中了 ref="${exact.ref}"（类型:${exact.type}）这个块，直接对它操作，不要再用 query 模糊查找别的块。\n` +
                `- 读取该块:readDraft(mode:"range", from:"${exact.ref}", to:"${exact.ref}") 取得它的 qingml。\n` +
                `- 整块修改(图表/图片/公式等原子块或需重写的块):基于返回 qingml 构造新 QingML 片段,调用 editDraft action:"replaceBlock" ref:"${exact.ref}"。\n` +
                `- 只改其中一小段文字:调用 editDraft action:"replaceText" withinRef:"${exact.ref}"；只改格式或标记:调用 editDraft action:"markText" withinRef:"${exact.ref}";不要把标记写成聊天里的 Markdown。${subSelectionLine}\n` +
                `- 工具失败时按 error 重新定位或询问用户，不能声称已生效。`
              );
            }
            // 降级(老链路/无可命中 blockId):退回基于选中文本的模糊定位。
            const selectedText = c.label;
            return (
              `> ${selectedText}${c.suffix ? `（位置：${c.suffix}）` : ""}` +
              `\n\n[editDraft 定位提示]\n` +
              `- 先调用 readDraft(query: ${JSON.stringify(selectedText)}) 定位含此文本的块并取得 ref。\n` +
              `- 只改一小段文字时，调用 editDraft action:"replaceText" withinRef:<上一步取得的ref>。\n` +
              `- 只改标记时，调用 editDraft action:"markText" withinRef:<上一步取得的ref>；不要把标记写成聊天里的 Markdown。\n` +
              `- 需要整块重写时，基于 readDraft 返回的 qingml 构造新 QingML 片段，然后调用 editDraft action:"replaceBlock"。\n` +
              `- 工具失败时按 error 重新定位或询问用户，不能声称已生效。`
            );
          })
          .join("\n")}\n\n[选区上下文] 用户选中了以上内容。选中本身不等于要改：若用户这轮要求修改（润色/改写/删/调整格式等），你**必须**调用 readDraft/editDraft 真正提交，不能只用文字声称已改；若用户只是要解释/评价/提问，正常回答即可，不必动文档。\n\n用户针对以上选中内容说：`
      : "";
  // 模型可见的用户正文(0702,对齐业界模式):有 richText(带 {{chip:N}} 占位)时按原位
  // 展开成内联 token(「技能：X」/「文件：X」…),chip 的位置=语义绑定,多 chip 穿插
  // ("A 用[抓网页],B 用[联网搜]")不再串台;无 richText 走纯文本,行为不变。
  let modelUserText = userText;
  if (richText && richText.trim().length > 0 && chips.length > 0) {
    const composed = await composeInlineChipText(richText, chips, {
      loadSkillInstruction: createSkillChipInstructionLoader(workspaceSkills),
    });
    modelUserText = composed.text;
    for (const warning of composed.warnings) {
      logger.warn("Skill chip context injection warning", {
        sessionId: state.sessionId,
        streamId,
        ...warning,
      });
    }
  }

  let fullUserText = attachmentCtx
    ? `${attachmentCtx}${selectionCtx ? selectionCtx : "用户说："}${modelUserText}`
    : selectionCtx
      ? `${selectionCtx}${modelUserText}`
      : modelUserText;

  // 纯 chip 发送(用户没打字):内联 token 已表达动作,再补一句引导(先询问所需输入),
  // 否则模型面对只有 token 没有诉求的消息会泛化问候/空响应(详见 chipOnlyNote.ts)。
  if (userText.trim().length === 0 && chips.length > 0) {
    const guidance = buildChipOnlyGuidance(chips);
    if (guidance) fullUserText += guidance;
  }

  // 时间锚只进当轮 user message,不写 system prompt；放在靠前位置。
  // 历史上 writeDraft 截断拍平对话上下文时会丢时效信息；现在保留完整 messages,这里仍恒开。
  fullUserText = `${currentDateTimeContext()}${fullUserText}`;
  if (runtimeOptions.turnContext?.trim()) {
    fullUserText += `\n\n${runtimeOptions.turnContext.trim()}`;
  }
  if (runtimeOptions.preemptedByNewMessage) {
    fullUserText += PREEMPTED_TURN_GUIDANCE;
  }

  // 当轮提醒只做状态提示,裁决标准统一留在 system prompt 的「问卷工具触发裁决」。
  // 不在这里重复写默认/例外规则,避免与唯一裁决段再次分叉。
  if (state._askUserCompleted !== true) {
    if (state.legacySections.length === 0) {
      fullUserText +=
        `\n\n[系统·写作流程提醒]右侧文档当前为空。请严格按 system prompt 中「问卷工具触发裁决」判断本轮是问卷、直接写还是正常对话。` +
        `"联网查/查一下/先搜一下/搜索"等搜索指令不是跳过问卷的信号:若本轮最终是新文档写作任务,先搜索拿到必要信息后,仍按「问卷工具触发裁决」决定是否单独调用 planDraft。`;
    } else {
      fullUserText +=
        `\n\n[系统·写作流程提醒]右侧文档已有内容。请**结合现有正文**判断这条消息的意图:` +
        `续写/扩写、修改某处、整体换方向、还是只是提问/解释——别当成空文档重新走问卷;` +
        `要改文档就调用 readDraft/editDraft 真正提交(不能只用文字声称已改),只是提问就直接回答。`;
    }
  }

  // Inject material inventory so the agent always knows available materials
  // and their IDs — prevents the agent from hallucinating materialIds or
  // being unable to recall them from conversation history.
  if (state.materials.size > 0) {
    const matList = Array.from(state.materials.values())
      .map((m) => `  - ${m.id}  "${m.filename}"  ${m.metadata.wordCount}字${m.summary ? `  摘要：${m.summary.slice(0, 80)}` : ""}`)
      .join("\n");
    fullUserText +=
      `\n\n[系统：当前会话已存储的素材]\n${matList}\n使用 readMaterial 工具可读取素材全文。`;
  }

  // 注入已连接的文件夹资料库清单 + 先读再动作的铁律。用户可能在任意一轮连接文件夹,
  // 所以这段每轮恒注入(不限首轮):只要连了文件夹,就该主动去读,而不是凭空写或直接反问。
  if (state.folderSources.size > 0) {
    const folderList = Array.from(state.folderSources.values())
      .map((f) => {
        const count =
          typeof f.fileCount === "number"
            ? `,约 ${f.fileCount}${f.fileCountCapped ? "+" : ""} 个文件`
            : "";
        return `  - "${f.name}" 挂载在 ${f.mountPath}${count}`;
      })
      .join("\n");
    fullUserText +=
      `\n\n[系统：当前会话已连接的文件夹资料库]\n${folderList}\n` +
      `这些是用户特意连进来的写作素材。只要本轮的写作或反问会用到它们、而你还没读过相关内容,` +
      `就必须先读再动作:先用 mastra_workspace_list_files 概览目录结构,再用 readDocument 读相关文件正文` +
      `(或先 searchDocuments 按关键词检索定位、再 readDocument 读命中文件),尽量把和当前写作意图相关的材料读全读细。` +
      `严禁连了文件夹却一个文件都没读,就直接弹问卷反问"写什么",或凭空开写。`;
  }

  const frozenWorkingMemorySnapshot = await ensureWorkingMemorySnapshot(state);
  ensureWorkingMemoryPromptInPlace(state.messages, frozenWorkingMemorySnapshot);
  omTurnStartMessageIndex = state.messages.length;
  state.messages.push({ role: "user", content: fullUserText });

  // Inject current document snapshot into the last user message when the
  // doc has changed since the last sync, so the agent always sees the latest
  // version and prompt-cache can match on the stable prefix.
  // Also builds sectionToLine map for position-based selection matching.
  if (
    state.docVersion > state.lastSyncedDocumentSnapshot &&
    state.legacySections.length > 0
  ) {
    const docLines: string[] = [];
    const sectionToLineForSnapshot = new Map<number, number>();
    let lineNum = 1;
    const markdown = state.doc ? pmToMarkdown(state.doc) : null;

    if (markdown) {
      for (let si = 0; si < state.legacySections.length; si++) {
        sectionToLineForSnapshot.set(si, si + 1);
      }
      for (const line of markdown.split("\n")) {
        docLines.push(`[${lineNum}] ${line}`);
        lineNum++;
      }
    } else {
      for (let si = 0; si < state.legacySections.length; si++) {
        // Add blank line between sections (except before the first)
        if (si > 0) {
          docLines.push(`[${lineNum}]`);
          lineNum++;
        }
        sectionToLineForSnapshot.set(si, lineNum);
        const s = state.legacySections[si]!;
        switch (s.kind) {
          case "h1":
            docLines.push(`[${lineNum}] # ${s.data.text}`);
            lineNum++;
            break;
          case "h2":
            docLines.push(`[${lineNum}] ## ${s.data.text}`);
            lineNum++;
            break;
          case "p":
            docLines.push(`[${lineNum}] ${s.data.text}`);
            lineNum++;
            break;
          case "penNote":
            docLines.push(`[${lineNum}] > ${s.data.text}`);
            lineNum++;
            break;
          case "code":
            docLines.push(`[${lineNum}] \`\`\`\n${s.data.body}\n\`\`\``);
            lineNum++;
            break;
          case "table": {
            const head = s.data.head.join(" | ");
            const sep = s.data.head.map(() => "---").join(" | ");
            const rows = s.data.rows
              .map((r) => r.join(" | "))
              .join("\n");
            docLines.push(`[${lineNum}] ${head}\n${sep}\n${rows}`);
            lineNum++;
            break;
          }
          case "image":
            docLines.push(`[${lineNum}] ![${s.data.alt}](${s.data.src})${s.data.caption ? ` ${s.data.caption}` : ""}`);
            lineNum++;
            break;
          default:
            docLines.push(`[${lineNum}]`);
            lineNum++;
            break;
        }
      }
    }

    // Store sectionToLine on session state for use by selection context
    state._sectionToLine = sectionToLineForSnapshot;

    void docLines;
    state.lastSyncedDocumentSnapshot = state.docVersion;
  }

  // 用户消息:进 chatHistory(供还原)并**作为直播帧发出**(0702 桌面验收修复)。
  // 此前只 push 不发帧 → FrameLog 直播段没有用户消息,重进(after=0 重放)时用户气泡消失,
  // 要等轮次结束、排队的 startSession(existing) 还原才回来。现在恒发直播帧:
  // - 普通 sendMessage 前端有乐观气泡,靠 clientMessageId 同 id 去重合一;
  // - 命令式发送(如审核结果回流的 userDisplayParts 路径)本就没有乐观气泡,直播帧让缩略卡当轮即可见。
  // id 优先用客户端传来的 clientMessageId,缺省回退服务端生成;做长度/类型防御,不信任裸输入。
  const safeClientMessageId = normalizeClientMessageId(clientMessageId);
  // 气泡体优先级:userDisplayParts(审核结果缩略卡等展示覆盖)> richText({{chip:N}} 原位,
  // 直播/重放/冷还原全 WYSIWYG)> 纯文本。模型侧 state.messages 已收 fullUserText 全文,展示与模型上下文解耦。
  const userChatMessage: ChatMessage = {
    id: safeClientMessageId ?? newId(),
    role: { kind: "user" },
    ts: nowIso(),
    parts:
      userDisplayParts && userDisplayParts.length > 0
        ? userDisplayParts
        : [
            {
              kind: "text",
              data: {
                body:
                  richText && richText.trim().length > 0 && chips.length > 0
                    ? richText
                    : userText,
              },
            },
          ],
    chips: chips.length > 0 ? chips : null,
  };
  state.chatHistory.push(userChatMessage);
  yield chatMessageAdded(userChatMessage);

  const agentMessage: ChatMessage = {
    id: agentMessageId,
    role: { kind: "agent" },
    ts: nowIso(),
    parts: [],
    chips: null,
  };
  yield chatMessageAdded(agentMessage);
  state.chatHistory.push(agentMessage);
  state._activeAgentMessageId = agentMessageId;

  // 展示层消息必须在进入慢模型/工具链前先耐久化。否则活跃回合中的进程切换或冷恢复
  // 只能从 Mastra 模型消息补建用户气泡,会把 actionCard 等展示 part 退化成机器 query 文本。
  await schedulePersist(state, "runAgentTurn:display_messages").catch((err) =>
    logger.error("Persist display messages before agent run failed", { error: String(err) }),
  );

    const omContextForTurn = await prepareOmContextForTurn(state).catch((error) => {
      logger.warn("[omSidecar] prepare context failed; falling back to full messages", {
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        messagesForModel: state.messages,
        tailObservationPrompt: null,
        compressed: false,
        fullTokenEstimate: 0,
        projectedTokenEstimate: 0,
        removedMessageIds: [],
        observations: null,
      };
    });
    const shouldLeaseSessionWorkspace =
      !process.env.VITEST || process.env.QINGAGENT_FORCE_SESSION_SANDBOX === "1";
    if (shouldLeaseSessionWorkspace) {
      try {
        sessionWorkspaceLease = await acquireQingagentSessionWorkspace(state.sessionId);
      } catch (error) {
        logger.error("[sessionWorkspace] 租约获取失败，保留无命令能力的降级路径", {
          sessionId: state.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const activeWorkspaceLease = sessionWorkspaceLease;
    const sessionTools = createSessionScopedTools(
      state,
      activeWorkspaceLease
        ? {
            getWorkspace: async () => activeWorkspaceLease.workspace,
            retainWorkspace: () => activeWorkspaceLease.retain(),
          }
        : {},
    );

    const messagesForModel = omContextForTurn.messagesForModel;
    const messagesForToolContext = omContextForTurn.tailObservationPrompt
      ? [
          ...messagesForModel,
          {
            role: "user" as const,
            content: omContextForTurn.tailObservationPrompt,
          },
        ]
      : messagesForModel;
    const requestContext: RequestContext = new RequestContext([
      ["materials", state.materials],
      ["messages", messagesForToolContext],
      [MASTRA_THREAD_ID_KEY, state.threadId ?? state.sessionId],
      [TODO_AWARENESS_REQUEST_CONTEXT_KEY, () => buildTodoAwarenessContent(state.todos)],
      [QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY, frozenWorkingMemorySnapshot],
      [QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY, omContextForTurn.tailObservationPrompt],
      [
        QINGAGENT_DOC_VERSION_AWARENESS_REQUEST_CONTEXT_KEY,
        () => buildDocVersionAwarenessContent(state),
      ],
      ["userText", userText],
      ["reviewContext", reviewContext ?? null],
      ["sessionId", state.sessionId],
      ["streamId", streamId],
      ["abortSignal", abortController.signal],
      ["clientTraceId", state.clientTraceId ?? null],
      ["origin", state.origin ?? "manual"],
      ["docVersion", state.docVersion],
      ["doc", state.doc],
      ["legacySections", state.legacySections],
      ["patchValidationResults", state.patchValidationResults],
      ["modelOverrides", state.modelOverrides],
      // 已完成过问卷 → askUser 默认抑制;directionChange 只有在上次完成后出现过有效写入才豁免。
      ["askUserAlreadyCompleted", state._askUserCompleted === true],
      ["isDirectionReset", isDirectionReset(state)],
      ["directionChangeAskedSinceLastWrite", state._directionChangeAskedSinceLastWrite === true],
    ]);
    if (activeWorkspaceLease) {
      requestContext.set(
        QINGAGENT_SESSION_WORKSPACE_CONTEXT_KEY,
        activeWorkspaceLease.workspace,
      );
    }
    bindTurnOwnershipToRequestContext(requestContext, turnOwnership);
    if (selectionDiagramLanguages.size > 0) {
      markDiagramVizEditing(requestContext, selectionDiagramLanguages);
    }
    for (const skillName of selectedSkillNames) {
      activateSkill(requestContext, skillName, userText);
    }
    turnRequestContext = requestContext;
    beginSessionSnapshotTurn(requestContext);
    let toolSearchPreloadedToolNames: string[] = [];
    if (capabilityToolSearch) {
      const toolSearchProcessor = ensureSessionToolSearchProcessor(state, capabilityToolSearch);
      requestContext.set(QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY, toolSearchProcessor);
      toolSearchPreloadedToolNames = await preloadQingagentToolSearchTools({
        processor: toolSearchProcessor,
        requestContext,
        messages: messagesForToolContext,
        toolNames: [
          ...(state._toolSearchLoadedToolNames ?? []),
          ...capabilityToolSearch.preloadToolNames,
        ],
      });
      if (toolSearchPreloadedToolNames.length > 0) {
        logger.info("[toolSearch] preloaded session tools", {
          sessionId: state.sessionId,
          selectedSkills: selectedSkillNames,
          persistedTools: state._toolSearchLoadedToolNames ?? [],
          tools: toolSearchPreloadedToolNames,
        });
      }
    }

    const sessionTraceId = sessionIdToTraceId(state.sessionId);
    const prefixGuardContext = {
      sessionId: state.sessionId,
      lineage: "turn" as const,
      scopeId: streamId,
      allowedToolAdditions: toolSearchPreloadedToolNames,
    };
    const sessionScopedTools: ToolsInput = {
      readMaterial: sessionTools.readMaterial,
      summarizeMaterial: sessionTools.summarizeMaterial,
    };
    sessionScopedTools.readDraft = sessionTools.readDraftAiIr;
    sessionScopedTools.editDraft = sessionTools.editDraft;
    sessionScopedTools.create_annotation_groups = sessionTools.createAnnotationGroups;
    sessionScopedTools.readDiff = sessionTools.readDiff;
    if (sessionTools.executeCommand) {
      sessionScopedTools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND] = sessionTools.executeCommand;
    }
    if (sessionTools.getProcessOutput) {
      sessionScopedTools[WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT] = sessionTools.getProcessOutput;
    }
    if (sessionTools.workspaceReadFile) {
      sessionScopedTools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE] = sessionTools.workspaceReadFile;
    }
    if (sessionTools.workspaceEditFile) {
      sessionScopedTools[WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE] = sessionTools.workspaceEditFile;
    }
    if (sessionTools.workspaceGrep) {
      sessionScopedTools[WORKSPACE_TOOLS.FILESYSTEM.GREP] = sessionTools.workspaceGrep;
    }
    if (sessionTools.workspaceSearch) {
      sessionScopedTools[WORKSPACE_TOOLS.SEARCH.SEARCH] = sessionTools.workspaceSearch;
    }
    if (sessionTools.readDocument) sessionScopedTools.readDocument = sessionTools.readDocument;
    if (sessionTools.searchDocuments) sessionScopedTools.searchDocuments = sessionTools.searchDocuments;
    if (sessionTools.writeDraft) sessionScopedTools.writeDraft = sessionTools.writeDraft;
    if (sessionTools.updateWorkingMemory) {
      sessionScopedTools.updateWorkingMemory = sessionTools.updateWorkingMemory;
    }
    const maxTurnRetries = TURN_RETRY_LIMIT;
    const idleTimeoutRetryLimit = Math.min(
      1,
      Math.max(0, runtimeOptions.idleTimeoutRetryLimit ?? 1),
    );
    let idleTimeoutRetryCount = 0;
    const makeStream = async (
      attempt: number,
      scopedPrefixGuardContext: typeof prefixGuardContext,
      modelMessages: typeof messagesForModel,
      useMemory: boolean,
    ) => {
      abortController.signal.throwIfAborted();
      return guardContext.run(scopedPrefixGuardContext, () =>
        qingagentAgent.stream(modelMessages, {
          maxSteps: AGENT_MAX_STEPS,
          // 代理偶发抖动(other side closed)时多扛几次:指数退避 1s/2s/4s/8s,共 5 次尝试。
          // Mastra 默认 maxRetries=2(只 1s/2s)对走代理的 deepseek 偏少。maxRetries 在 modelSettings 里。
          // F1:设置页的采样参数覆盖(temperature/topP/maxOutputTokens)合并,空=不覆盖走默认。
          modelSettings: {
            maxRetries: 4,
            maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
            ...resolveModelParams(requestContext),
          },
          // 智谱 GLM 等 anthropic 协议:扩展思考默认关,显式开启才会返回 reasoning 流(否则前端无"思考中")。
          // 仅对 anthropic 协议加,deepseek(openai 协议)不受影响。
          ...(resolveProtocol(requestContext) === "anthropic"
            ? { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } } } }
            : {}),
          ...(useMemory && !omSidecarEnabled
            ? {
                memory: {
                  thread: state.threadId ?? state.sessionId,
                  resource: state.resourceId || QINGAGENT_RESOURCE_ID,
                },
              }
            : {}),
          toolsets: {
            sessionScoped: sessionScopedTools,
            capabilityTools,
          },
          // Correlate every model/tool span for this session under one trace and
          // carry the raw ids in span metadata for cross-layer joins.
          // clientTraceId 必须放进 tracingOptions.metadata：Mastra 只把 metadata 透传到
          // 本轮所有子框架 span(agent_run/model_generation/tool_call/model_inference/
          // processor_run)。之前只放 sessionId/runId/streamId，导致这些框架 span 的
          // metadata.clientTraceId 全为 null，按 clientTraceId 追链时模型/工具/agent 三层
          // 断裂(Round 1 实测 5/5 命中)。clientTraceId 可能为 null(无 x-client-trace-id
          // header / 尚未绑定)，与原行为一致。
          tracingOptions: {
            ...(sessionTraceId ? { traceId: sessionTraceId } : {}),
            metadata: buildAgentTracingMetadata(state, streamId, state.runId),
          },
          requestContext,
          abortSignal: abortController.signal,
        }),
      );
    };

    let promiseContinuationCount = 0;
    for (let attempt = 0; attempt <= maxTurnRetries; attempt += 1) {
      abortController.signal.throwIfAborted();
      let modelMessages = messagesForModel;
      let outcome: ProcessOutcome;
      let isPromiseContinuationStream = false;
      while (true) {
        const baseScopeId =
          attempt === 0 ? streamId : `${streamId}:retry:${attempt}`;
        const scopedPrefixGuardContext = {
          ...prefixGuardContext,
          scopeId:
            isPromiseContinuationStream
              ? `${baseScopeId}:promise-continuation`
              : baseScopeId,
        };
        const result = await makeStream(
          attempt,
          scopedPrefixGuardContext,
          modelMessages,
          attempt === 0 && !isPromiseContinuationStream,
        );
        const runId = result.runId ?? "unknown";
        activeRunId = runId;
        console.info(formatTurnLog("start", {
          session: state.sessionId,
          run: runId,
        }));
        requestContext.set("runId", result.runId);
        outcome = yield* withPrefixCacheGuardContext(scopedPrefixGuardContext, () =>
          processAgentStream(result.fullStream, {
            state,
            agentMessageId,
            streamId,
            runId: result.runId,
            userText,
            fileIds,
            requestContext,
            abortController,
            idleTimeoutMs: runtimeOptions.idleTimeoutMs,
            firstChunkTimeoutMs: runtimeOptions.firstChunkTimeoutMs,
            deferRetryableIdleTimeout:
              idleTimeoutRetryCount < idleTimeoutRetryLimit && attempt < maxTurnRetries,
          }),
        );
        turnWasUserAborted ||= outcome.streamWasUserAborted;
        for (const stored of outcome.storedGrantApprovals) {
          yield* resumeConfirmDecision({
            session: state,
            pending: stored.pending,
            decisionId: stored.decisionId,
            accepted: true,
            resolution: "accepted",
            service: confirmService,
            agent: qingagentAgent,
            emitResolvedFrame: false,
            abortController,
          });
        }
        if (
          shouldContinuePromisedAction({
            finishReason: outcome.finishReason,
            sawToolCall: outcome.sawToolCall,
            streamWasUserAborted: outcome.streamWasUserAborted,
            finalText: outcome.finalText,
            continuationCount: promiseContinuationCount,
          })
        ) {
          promiseContinuationCount += 1;
          isPromiseContinuationStream = true;
          const lastModelMessage = messagesForModel.at(-1);
          const promiseAlreadyAppended =
            lastModelMessage?.role === "assistant" &&
            lastModelMessage.content === outcome.finalText;
          modelMessages = [
            ...messagesForModel,
            ...(promiseAlreadyAppended
              ? []
              : [{ role: "assistant" as const, content: outcome.finalText }]),
            {
              role: "system" as const,
              content: PROMISE_CONTINUATION_SYSTEM_MESSAGE,
            },
          ];
          requestContext.set(
            "messages",
            omContextForTurn.tailObservationPrompt
              ? [
                  ...modelMessages,
                  {
                    role: "user" as const,
                    content: omContextForTurn.tailObservationPrompt,
                  },
                ]
              : modelMessages,
          );
          logger.warn("Continuing agent turn after promised-action stop", {
            sessionId: state.sessionId,
            streamId,
            attempt,
            continuationCount: promiseContinuationCount,
            finishReason: outcome.finishReason,
          });
          continue;
        }
        break;
      }
      if (outcome.streamWasUserAborted) turnOutcome = "cancelled";
      const retryableIdleTimeout = outcome.retryableIdleTimeoutChunk !== undefined;
      const shouldRetry =
        (outcome.transientErrorChunk !== undefined || retryableIdleTimeout) &&
        !outcome.producedVisibleFrame &&
        // p04:问卷(askUser)的重放/出题不算副作用,瞬断后允许安全重试。
        !outcome.sawSideEffectToolCall;
      if (shouldRetry && attempt < maxTurnRetries) {
        const retryDelayMs = turnRetryDelayMs(attempt);
        if (retryableIdleTimeout) {
          idleTimeoutRetryCount += 1;
          // idle 看门狗已经 abort 当前控制器；自动重试必须换一支新 signal，且立即
          // 挂到 session 上，保证退避期间用户仍能取消下一次尝试。
          if (abortController.signal.reason === IDLE_TIMEOUT_ABORT_REASON) {
            abortController = new AbortController();
            state._abortController = abortController;
            requestContext.set("abortSignal", abortController.signal);
          }
        }
        turnOwnership = beginTurnOwnership(
          state,
          `${streamId}:attempt:${attempt + 1}`,
        );
        bindTurnOwnershipToRequestContext(requestContext, turnOwnership);
        const retryChunk = outcome.retryableIdleTimeoutChunk ?? outcome.transientErrorChunk;
        logger.warn("Retrying agent turn after zero-output stream error", {
          sessionId: state.sessionId,
          streamId,
          category: retryableIdleTimeout ? "idle_timeout" : "transient",
          attempt,
          nextAttempt: attempt + 1,
          retryDelayMs,
          error: streamErrorMessage(retryChunk),
        });
        await delayMs(retryDelayMs, abortController.signal);
        abortController.signal.throwIfAborted();
        continue;
      }
      if (shouldRetry) {
        turnOutcome = "error";
        const retryChunk = outcome.retryableIdleTimeoutChunk ?? outcome.transientErrorChunk;
        const errorDetails = streamErrorDetails(retryChunk);
        yield appendVisibleStreamErrorText(state, agentMessageId, errorDetails.userMessage);
        state.messages.push({ role: "assistant", content: errorDetails.userMessage });
        yield draftingFailedFrame(streamId, errorDetails);
      }
      break;
    }
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown error during agent turn";
    if (isUserAbortSignal(abortController.signal)) {
      turnWasUserAborted = true;
      turnOutcome = "cancelled";
      logger.info("Agent turn aborted by user; suppressing failure frame", {
        sessionId: state.sessionId,
        streamId,
        error: reason,
      });
    } else {
      turnOutcome = "error";
      logger.error("Agent turn failed", {
        sessionId: state.sessionId,
        streamId,
        error: reason,
        stack: err instanceof Error ? err.stack : undefined,
      });

      yield {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: { streamId, reason, retriable: true },
        },
      };

      yield* syncContentAndProjectDocState(state, "agent_turn_failed");
    }
  } finally {
    sessionWorkspaceLease?.release();
    if (turnOutcome === "ok" && (turnWasUserAborted || isUserAbortSignal(abortController.signal))) {
      turnOutcome = "cancelled";
    }
    console.info(formatTurnLog("end", {
      session: state.sessionId,
      run: activeRunId ?? "unknown",
      totalMs: Date.now() - turnStartedAt,
      outcome: turnOutcome,
    }));
    // Clear turn-scoped selection chips so they don't leak into the next turn.
    state._currentChips = null;
    if (!hasActiveSuspension(state)) {
      clearSuspension(state);
    } else if (!activeSuspensionOwnedBy(state, streamId)) {
      logger.info("runAgentTurn leaving suspension owned by another stream intact", {
        sessionId: state.sessionId,
        streamId,
        ownerStreamId: state._suspensionOwner?.streamId,
      });
    }

    if (state.streamId === streamId) {
      state.streamId = null;
    }
    const finalFrames: BridgeFrame[] = [];
    // 残留 running 工具调用落终态,避免"调用完仍 loading"。
    // 用户主动中止的工具卡由 abortAndCleanupTurn 统一落 failed,不能先在这里补成 done。
    if (!turnWasUserAborted && !isUserAbortSignal(abortController.signal)) {
      for (const u of finalizeLingeringRunningToolCalls(state)) {
        finalFrames.push(toolCallUpdated(u.messageId, u.toolCallId, u.spec));
      }
    }
    for await (const frame of syncContentAndProjectDocState(state, "agent_turn_finally_idle")) {
      finalFrames.push(frame);
    }
    finalFrames.push(streamEnd(streamId));

    // Final persist after all state transitions are settled.
    // This is the safety-net persist for the turn: processAgentStream's
    // fire-and-forget persist may have been queued but not yet written,
    // and the catch block has no persist at all.  By persisting here we
    // guarantee the user message + any agent response from this turn are
    // captured even if the earlier persist failed or was skipped.
    await schedulePersist(state, "runAgentTurn:finally").catch((err) =>
      logger.error("Persist after runAgentTurn finally failed", { error: String(err) }),
    );
    if (omSidecarEnabled) {
      scheduleOmSidecarAfterTurn(state, turnRequestContext, {
        turnIndex: omTurnIndex,
        turnStartMessageIndex: omTurnStartMessageIndex,
      });
    }
    turnCompletion.resolve();
    endTurnOwnership(state, turnOwnership);
    if (state._abortController === abortController) {
      state._abortController = null;
    }
    if (state._activeTurnPromise === turnCompletion.promise) {
      state._activeTurnPromise = null;
    }
    if (
      state._activeAgentMessageId === agentMessageId &&
      !turnWasUserAborted &&
      !isUserAbortSignal(abortController.signal)
    ) {
      state._activeAgentMessageId = null;
    }
    // 资源所有权必须在 finally 的首个对外 yield 前结算。即使流消费者用
    // generator.return() 提前关闭且不再拉取，也不能留下假活跃 turn。
    for (const frame of finalFrames) {
      yield frame;
    }
  }
}

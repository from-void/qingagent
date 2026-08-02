import type {
  BridgeFrame,
  DocState,
  DocSuggestion,
  LegacySection,
  ToolCallSpec,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import { getDeterministicId } from "@qingagent/pm-schema";
import {
  appendMissingVisibleAskUserAnswerMessagesFromChatHistory,
  buildDocumentSnapshot,
  cleanRestoredText,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveDocStateFacts,
  documentRepo,
  emitProjectedDocState,
  getActiveSuspensionOwner,
  getDocumentVersionCommittedAt,
  interruptQuestionnaireSpecForRestore,
  isWholeDocumentSuggestionBatchId,
  isQuestionnaireTool,
  normalizeQuestionnaireSpecForRestore,
  normalizeRestoredDocStateKind,
  schedulePersist,
  transitionDocState,
  type SessionState,
} from "./bridgeCore";
import { folderSourcesChangedFrame } from "./folderSourceFrames";
import { takeConfirmRecoveryFrames } from "./confirmRecovery";

interface LiveRestoreDocStateDecision {
  target: DocState;
}

function liveRestoreSpec(
  spec: ToolCallSpec,
  opts: { preserveToolCallId?: string | null } = {},
): ToolCallSpec | null {
  if (spec.id === opts.preserveToolCallId) {
    return null;
  }

  if (
    isQuestionnaireTool(spec.name) &&
    (spec.status.kind === "pending" || spec.status.kind === "running")
  ) {
    return interruptQuestionnaireSpecForRestore(spec);
  }

  return null;
}

function terminalizeStaleLiveRestoreToolCalls(session: SessionState): void {
  const activeOwner = getActiveSuspensionOwner(session);
  for (const message of session.chatHistory) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      const restoredSpec = liveRestoreSpec(part.data, {
        preserveToolCallId: activeOwner?.toolCallId ?? null,
      });
      if (!restoredSpec) continue;
      message.parts[i] = {
        kind: "toolCall",
        data: restoredSpec,
      };
    }
  }
}

function getLiveRestoreDocStateDecision(
  session: SessionState,
): LiveRestoreDocStateDecision {
  const facts = deriveDocStateFacts(session);
  return {
    target: {
      kind: normalizeRestoredDocStateKind({
        persistedKind: session.docState.kind,
        hasDoc: facts.hasDoc,
        hasReviewPatch: facts.hasReviewPatch,
        hasApplicableReviewPatch: facts.hasApplicableReviewPatch,
        hasOpenAskUserToolCall: facts.hasOpenAskUser,
        hasRestorableSuspension: facts.hasActiveSuspension,
      }),
    } as DocState,
  };
}

function* emitNormalizedRestoreDocState(session: SessionState): Generator<BridgeFrame> {
  const decision = getLiveRestoreDocStateDecision(session);
  terminalizeStaleLiveRestoreToolCalls(session);
  const target = decision.target;
  transitionDocState(session, target, "restore_normalized", {
    mode: "normalize",
  });
  // restore 是把完整当前状态重放给一个全新的前端连接(刷新/重进)。_lastEmittedWireKind
  // 记录的是发给【上一个】连接的 wire 态;若不清,emitProjectedDocState 会因"同 kind"短路
  // 而不发 docStateChanged,导致新连接 docState 卡在初始 empty → 正文不渲染("文章不见了")
  // + 编辑器只读。强制清空,使 restore 必发当前 docState 首帧。
  session._lastEmittedWireKind = null;
  yield* emitProjectedDocState(session, "restore_normalized");
}

function* emitReadOnlyRestoreDocState(session: SessionState): Generator<BridgeFrame> {
  // /events 的 gap/epoch restore 是订阅恢复路径,可能与正在运行的 SessionActor 并发。
  // 这里只投影当前快照,不终态化 toolCall、不 transition docState、不改 _lastEmittedWireKind。
  yield {
    kind: "docStateChanged",
    data: {
      state: deriveContentState(session),
      activeOverlay: deriveActiveOverlay(session),
      agentBusy: deriveAgentBusy(session),
    },
  };
}

export async function reconcileCachedSessionDocFromDb(session: SessionState): Promise<boolean> {
  try {
    const docRow = await documentRepo.load(session.docId);
    if (docRow && docRow.docVersion > session.docVersion) {
      session.docVersion = docRow.docVersion;
      session.doc = docRow.pmDoc;
      session.legacySections = docRow.legacySections as unknown as LegacySection[];
      try {
        const committedAt = await getDocumentVersionCommittedAt(session.docId, docRow.docVersion);
        const committedAtMs = committedAt ? Date.parse(committedAt) : Number.NaN;
        if (Number.isFinite(committedAtMs)) {
          session.lastContentEditedAt = new Date(committedAtMs).toISOString();
        }
      } catch {
        // 正文已 DB-win 时仍需返回 true 并持久化；时间查询失败不能吞掉该信号。
      }
      // DB-win 说明正文已前进到内存 session 版本之后:此前基于旧版本锚点的 review/draft 态全部失效。
      // 必须清掉,否则 restore 会同时发 documentSnapshotWritten(新版) 与 docDiffReady(旧 base),
      // 前端拿旧锚点套新正文(冷恢复 threadPersistence 有此校验/清理,热恢复此前缺失 → 冷热不一致)。
      session.suggestions.clear();
      session.patchVerdicts.clear();
      session.patchValidationResults.clear();
      session.suggestionBaseDoc = null;
      session.suggestionBaseVersion = null;
      // 清 draft scratch(等价 core 的 clearInMemoryDraftDocs,直接清字段免动 core 公共导出)
      session.docDraftBaseSections = null;
      session.docDraftBaseVersion = null;
      session.docDraftBaseDoc = null;
      session.docDraftCandidateSections = null;
      session.docDraftCandidateDoc = null;
      // 同时终止 chatHistory 里 reviewable 的 docSuggestion toolCall:否则 emitRestoreFrames 的
      // chatHistory 重放(step4)会把 status="reviewing" 的旧建议发给前端,显示成可操作 review,
      // 但后端 suggestions 已清空 → accept/reject 找不到 patch。改成 failed 终止态使其不可操作。
      for (const message of session.chatHistory) {
        for (let i = 0; i < message.parts.length; i++) {
          const part = message.parts[i];
          if (
            part?.kind === "toolCall" &&
            part.data.name === "docSuggestion" &&
            part.data.status.kind === "reviewing"
          ) {
            message.parts[i] = {
              kind: "toolCall",
              data: {
                ...part.data,
                status: { kind: "failed", data: { retriable: false, reason: "文档已更新,此修改建议已失效" } },
              },
            };
          }
        }
      }
      return true;
    }
  } catch {
    // DB 读失败不阻断重连:保留内存态,restore 照常进行。
  }
  return false;
}

/**
 * Re-emit all state frames needed to restore the frontend workspace
 * from a persisted session. Called when mode.kind === "existing".
 */
export function* emitRestoreFrames(
  session: SessionState,
  options: { readOnly?: boolean } = {},
): Generator<BridgeFrame> {
  const readOnly = options.readOnly === true;
  if (!readOnly) {
    for (const message of session.chatHistory) {
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index];
        if (part?.kind !== "toolCall") continue;
        message.parts[index] = {
          kind: "toolCall",
          data: normalizeQuestionnaireSpecForRestore(part.data),
        };
      }
    }
    const rebuiltVisibleAnswerCards = appendMissingVisibleAskUserAnswerMessagesFromChatHistory(session);
    if (rebuiltVisibleAnswerCards > 0) {
      schedulePersist(session, "restore:askUser_visible_answer_cards").catch((err) => {
        console.error(
          "[restore] Persist after rebuilding askUser answer cards failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  // 1. Emit doc state after normalizing it against live restore facts.
  // In-memory suspended runs keep their tool overlay facts; cold restored
  // sessions have already terminalized stale toolCalls in loadSessionFromThread.
  if (readOnly) {
    yield* emitReadOnlyRestoreDocState(session);
  } else {
    yield* emitNormalizedRestoreDocState(session);
  }

  for (const pending of Array.from(session.pendingConfirms.values())
    .filter((item) => item.status === "pending" && Date.parse(item.expiresAt) > Date.now())
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.toolCallId.localeCompare(b.toolCallId))) {
    yield {
      kind: "confirmRequested",
      data: {
        toolCallId: pending.toolCallId,
        spec: pending.spec,
        requestedAt: pending.requestedAt,
        expiresAt: pending.expiresAt,
      },
    };
  }
  // gap/epoch restore 必须纯读：确认恢复终态不重放；草稿冲突却是冷快照刚推导出的
  // 必要提示，必须发送但不得消费。activate 恢复仍保持一次性消费语义。
  if (!readOnly) {
    for (const frame of takeConfirmRecoveryFrames(session)) yield frame;
  }
  const pendingDraftRecoveryFrames = session._pendingDraftRecoveryFrames;
  if (!readOnly) session._pendingDraftRecoveryFrames = [];
  for (const frame of pendingDraftRecoveryFrames) yield frame;

  // 回放 AI 任务清单(与 docStateChanged 同路数:会话状态帧,页面刷新/重连恢复 pill)。
  if (session.todos.length > 0) {
    yield { kind: "todosChanged", data: { todos: session.todos } };
  }

  yield folderSourcesChangedFrame(session);

  // 2. Emit doc version if document exists
  if (session.legacySections.length > 0) {
    yield {
      kind: "documentSnapshotWritten",
      data: {
        doc: buildDocumentSnapshot(session.legacySections, session.docVersion, session.doc),
      },
    };
  }

  // 批注装饰依赖文档坐标；先恢复正文，再把完整活动组作为权威状态交给新页面重建锚点与 hover 卡。
  if (session.annotationGroups.length > 0) {
    yield {
      kind: "annotationGroupsReady",
      data: { groups: structuredClone(session.annotationGroups) },
    };
  }

  // 3. Emit materials as resources
  for (const mat of session.materials.values()) {
    const metadataWithFileId = { ...mat.metadata, fileId: mat.fileId };
    yield {
      kind: "resourceUpserted",
      data: {
        resource: {
          resourceRef: { id: mat.id, domain: { kind: "file" } },
          displayName: mat.filename,
          summary: mat.summary ?? "",
          mime: mat.mimeType,
          byteLen: mat.text.length,
          createdAt: mat.createdAt,
          metadata: metadataWithFileId,
        },
      },
    };
  }

  // 4. Emit chat messages from the restored session.
  // If chatHistory exists (rich format with tool bubbles, thinking parts),
  // use it for full-fidelity restore. Otherwise fall back to plain text
  // from session.messages for backward compatibility.
  const restoredChatMessageIds = new Set(
    session.chatHistory.map((message) => message.id),
  );
  if (session.chatHistory.length > 0) {
    // Rich restore path: emit full ChatMessages with all parts
    for (const msg of session.chatHistory) {
      // appendSeq 基线(0702 review Lane A):生成进行中触发 restore 快照时,该消息
      // 后续直播 chatMessageAppended 的 seq 延续 seqCounters 计数(而非从 1 重新数)。
      // 前端 restoreReset 清空 appendCursor 后只应用严格连续 seq === cursor+1 的增量,
      // 缺基线会把进行中消息永久冻结(且 restoreReset 广播会冻住同会话全部标签页)。
      // 铁律:基线读取与消息深拷贝必须在同一同步 tick 内完成——emitRestoreFrames 到
      // frameLog.append 之间存在微任务间隙(collectRestoreFrames 的 await / .then),
      // 活跃轮次可能继续 push parts + 涨计数,若拷贝晚于基线读取,快照内容会多于基线,
      // 增量被重复应用(正文重复);反之则内容缺失。原子捕获后两个方向都不会错位。
      const appendSeq = session.seqCounters.get(msg.id) ?? 0;
      const restoredMessage = structuredClone(msg);
      restoredMessage.parts = restoredMessage.parts.map((part) => part.kind === "toolCall"
        ? { kind: "toolCall", data: normalizeQuestionnaireSpecForRestore(part.data) }
        : part);
      yield {
        kind: "chatMessageAdded",
        data: { message: restoredMessage, appendSeq },
      };

      // For toolCall parts with a terminal status, also emit toolCallUpdated
      // so the frontend's toolCalls Map gets populated for badge rendering.
      for (const part of msg.parts) {
        if (part.kind === "toolCall") {
          yield {
            kind: "toolCallUpdated",
            data: {
              messageId: msg.id,
              toolCallId: part.data.id,
              spec: structuredClone(normalizeQuestionnaireSpecForRestore(part.data)),
            },
          };
        }
      }
    }
  }

  // 部分 rich 历史只补其缺失的稳定 id 消息；同 id 时 rich 展示层是保形真相源。
  if (
    session.chatHistory.length === 0 ||
    session.messages.some((message) => {
      const id = (message as { id?: unknown }).id;
      return typeof id === "string" && !restoredChatMessageIds.has(id);
    })
  ) {
    for (const [messageIndex, msg] of session.messages.entries()) {
      // Skip messages that are not user or assistant (pure tool results)
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const messageId = (msg as { id?: unknown }).id;
      if (typeof messageId === "string" && restoredChatMessageIds.has(messageId)) continue;
      if (session.chatHistory.length > 0 && typeof messageId !== "string") continue;

      let rawContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter(
                  (p): p is { type: "text"; text: string } =>
                    typeof p === "object" && p !== null && "type" in p && p.type === "text",
                )
                .map((p) => p.text)
                .join("")
            : "";

      // Clean injected metadata (doc snapshots, line numbers, system reminders)
      const content = cleanRestoredText(rawContent);

      // Skip messages with empty text after cleaning
      if (!content || content.trim().length === 0) continue;

      yield {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: typeof messageId === "string"
              ? messageId
              : getDeterministicId("legacy-message", {
                  sessionId: session.sessionId,
                  messageIndex,
                }),
            role: { kind: msg.role === "user" ? "user" : "agent" },
            ts:
              (msg as { createdAt?: string }).createdAt ??
              new Date().toISOString(),
            parts: [{ kind: "text", data: { body: content } }],
            chips: null,
          },
          // legacy 路径重放的都是已完结消息,不会再有直播增量,基线恒为 0。
          appendSeq: 0,
        },
      };
      if (typeof messageId === "string") restoredChatMessageIds.add(messageId);
    }
  }

  // 5. Ensure restored review sessions repopulate patch review state even
  // if the chat history was written by an older metadata version.
  if (
    session.docState.kind === "pendingReview" &&
    session.suggestions.size > 0
  ) {
    const suggestions = [...session.suggestions.values()].map((record) => record.suggestion);
    yield {
      kind: "docDiffReady",
      data: {
        baseVersion: session.suggestionBaseVersion ?? session.docVersion,
        suggestions,
        ...(isWholeDocumentSuggestionBatchId(suggestions[0]?.batchId)
          ? { wholeDocument: true }
          : {}),
        ...(session.suggestionBaseDoc ? { previewDoc: session.suggestionBaseDoc } : {}),
        ...(session.docDraftCandidateDoc ? { editedDoc: session.docDraftCandidateDoc } : {}),
      },
    };
    for (const [suggestionId, record] of session.suggestions) {
      const verdict = session.patchVerdicts.get(suggestionId);
      const status: ToolCallStatus =
        verdict === "accepted"
          ? { kind: "accepted" }
          : verdict === "rejected"
            ? { kind: "rejected" }
            : { kind: "reviewing" };
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: record.messageId,
          toolCallId: suggestionId,
          spec: buildRestoredSuggestionToolCallSpec(record.suggestion, status),
        },
      };
    }
  }
}

function buildRestoredSuggestionToolCallSpec(
  suggestion: DocSuggestion,
  status: ToolCallStatus,
): ToolCallSpec {
  return {
    id: suggestion.id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status,
    body: {
      kind: "docSuggestion",
      data: { kind: "suggestion", data: suggestion },
    },
    result: suggestion.conflict
      ? { kind: "genericText", data: suggestion.conflict.message }
      : null,
  };
}

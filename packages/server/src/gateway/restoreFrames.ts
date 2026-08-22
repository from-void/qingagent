import type {
  BridgeFrame,
  DocState,
  DocSuggestion,
  ToolCallSpec,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import {
  appendMissingVisibleAskUserAnswerMessagesFromChatHistory,
  buildDocumentSnapshot,
  currentPmDoc,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveDocStateFacts,
  deriveExternalEditing,
  documentRepo,
  emitProjectedDocState,
  getActiveSuspensionOwner,
  getDocumentVersionCommittedAt,
  hasCanonicalDoc,
  invalidateDraftStateAfterCanonicalWrite,
  interruptQuestionnaireSpecForRestore,
  isWholeDocumentSuggestionBatchId,
  isQuestionnaireTool,
  normalizeQuestionnaireSpecForRestore,
  normalizeRestoredDocStateKind,
  mapAnnotationGroupsThroughSteps,
  schedulePersist,
  transitionDocState,
  type SessionState,
} from "./bridgeCore";
import { getPmContentHash } from "@qingagent/pm-schema";
import { persistMappedAnnotationGroups } from "@qingagent/db";
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
      externalEditing: deriveExternalEditing(session),
    },
  };
}

export async function reconcileCachedSessionDocFromDb(session: SessionState): Promise<boolean> {
  try {
    const docRow = await documentRepo.load(session.docId);
    const cachedHash = getPmContentHash(currentPmDoc(session));
    const persistedHash = docRow
      ? docRow.contentHash ?? getPmContentHash(docRow.pmDoc)
      : null;
    const persistedVersionWins = docRow && docRow.docVersion > session.docVersion;
    const sameVersionDiverged = docRow
      && docRow.docVersion === session.docVersion
      && persistedHash !== cachedHash;
    if (docRow && (persistedVersionWins || sameVersionDiverged)) {
      session.docVersion = docRow.docVersion;
      session.doc = docRow.pmDoc;
      try {
        const committedAt = await getDocumentVersionCommittedAt(session.docId, docRow.docVersion);
        const committedAtMs = committedAt ? Date.parse(committedAt) : Number.NaN;
        if (Number.isFinite(committedAtMs)) {
          session.lastContentEditedAt = new Date(committedAtMs).toISOString();
        }
      } catch {
        // 正文已 DB-win 时仍需返回 true 并持久化；时间查询失败不能吞掉该信号。
      }
      // documents 是 canonical 权威源。版本前进以及「版本相同但正文 hash 分叉」都说明
      // 热 session 发生了撕裂；此前基于旧正文的 review/draft 态全部失效。统一走 core
      // 失效入口，同时推进 draft mutation revision，避免异步候选写回覆盖新 canonical。
      await invalidateDraftStateAfterCanonicalWrite(session);
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
 * 恢复边界不信任历史绝对坐标：用当前正文逐条校验 quote，错位时在原 blockId 内重搜。
 * 修复结果写回同一批注表；原文确实不存在时持久化失效，绝不把碎片范围重新交给前端。
 */
export async function reconcileSessionAnnotationAnchors(
  session: SessionState,
): Promise<boolean> {
  if (!session.doc || session.annotationGroups.length === 0) return false;
  const before = JSON.stringify(session.annotationGroups);
  const mapped = mapAnnotationGroupsThroughSteps(
    session.annotationGroups,
    [{ stepType: "annotationMappingUnknown" }],
    session.doc,
  );
  if (JSON.stringify(mapped.groups) === before) return false;

  await persistMappedAnnotationGroups(
    session.docId,
    mapped.groups,
    mapped.survivingAnchorIndexes,
  );
  session.annotationGroups = mapped.groups;
  if (mapped.invalidatedAnchorCount > 0) {
    session._invalidatedAnnotationAnchorCountForRestore = mapped.invalidatedAnchorCount;
  }
  return true;
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
  if (hasCanonicalDoc(session) && session.doc) {
    yield {
      kind: "documentSnapshotWritten",
      data: {
        doc: buildDocumentSnapshot(session.docVersion, session.doc),
      },
    };
  }

  // 批注装饰依赖文档坐标；先恢复正文，再把完整活动组作为权威状态交给新页面重建锚点与 hover 卡。
  const invalidatedAnchorCount = session._invalidatedAnnotationAnchorCountForRestore ?? 0;
  if (session.annotationGroups.length > 0 || invalidatedAnchorCount > 0) {
    yield {
      kind: "annotationGroupsReady",
      data: {
        groups: structuredClone(session.annotationGroups),
        ...(invalidatedAnchorCount > 0 ? { invalidatedAnchorCount } : {}),
      },
    };
    if (!readOnly) session._invalidatedAnnotationAnchorCountForRestore = 0;
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

  // 4. Emit the canonical rich chat history with tool bubbles and thinking parts.
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

import type { BridgeFrame, LegacySection, MessagePart } from "@qingagent/contract-ts";
import type { RequestContext } from "@mastra/core/request-context";
import { mastra } from "../mastra.js";
import { documentDraftRepo } from "../db/documentDraftRepo.js";
import { upsertDocumentSuggestion } from "../db/documentSuggestionsRepo.js";
import { buildDocumentSnapshot } from "./docGenerator.js";
import { commitDocumentOp } from "./commitDocumentOp.js";
import { cloneLegacySections } from "./docDiff.js";
import { buildDraftDiff } from "./proposalDiff.js";
import type { SessionState, SuggestionRecord } from "./sessionState.js";
import { appendPartToChatHistory, nextSeq } from "./sessionState.js";
import {
  chatMessageAppended,
  docDiffReady,
  toolCallUpdated,
} from "./frames.js";
import {
  buildSuggestionToolCallSpec,
  suggestionFromDiffHunk,
} from "./toolCards.js";
import { nextDocGenerationEvent } from "./docGenerationEvents.js";
import {
  clearDraftConfirmationState,
  clearDraftMutationScratch,
  clearReviewDiffState,
  clearSuggestionReviewState,
  clonePmDoc,
  currentPmDoc,
  hasNonEmptyCanonicalBase,
  warnIfSelectionDiffEscapesSelectedBlocks,
} from "./draftScratch.js";
import {
  syncContentAndProjectDocState,
  transitionAndProjectDocState,
} from "./docStateSync.js";
import {
  recordSettleResultSpan,
  recordStateChangeSpan,
} from "./agentSpans.js";
import { deriveTitleFromSections } from "./title.js";
import {
  getPmContentHash,
  legacySectionsToPm,
  pmToLegacySections,
} from "@qingagent/pm-schema";

const logger = mastra.getLogger();

export async function* settleDraftCandidate(opts: {
  state: SessionState;
  agentMessageId: string;
  streamId: string;
  runId: string;
  wholeDocument: boolean;
  requestContext?: RequestContext;
  generationId?: string | null;
  generationLastSeq?: number;
  emitGenerationEvent?: boolean;
}): AsyncGenerator<BridgeFrame, { hunkCount: number; docWritten: boolean }> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    wholeDocument,
    requestContext,
    generationId,
    generationLastSeq = 0,
    emitGenerationEvent = false,
  } = opts;
  const candidate = state.docDraftCandidateSections;

  {
    const draftDoc = state.docDraftCandidateDoc ?? (candidate ? legacySectionsToPm(candidate as never) : null);
    if (draftDoc) {
      const baseDoc = state.docDraftBaseDoc ?? currentPmDoc(state);
      const baseVersion = state.docDraftBaseVersion ?? state.docVersion;
      // 首稿没有可审批的原版；跳过 candidate-diff，继续走整篇直接落地路径。
      if (hasNonEmptyCanonicalBase(state, baseDoc)) {
        const hunks = buildDraftDiff(baseDoc, draftDoc, { baseVersion });
        if (hunks.length === 0) {
          await documentDraftRepo.clear(state.docId).catch((err) => {
            logger.warn("Failed to clear empty pending draft row", {
              sessionId: state.sessionId,
              docId: state.docId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          clearDraftConfirmationState(state);
          clearReviewDiffState(state);
          yield* syncContentAndProjectDocState(state, "draft_candidate_noop");
          recordSettleResultSpan(state, {
            branch: "noop",
            hunkCount: 0,
            docWritten: false,
            finalVersion: state.docVersion,
            sourceStreamId: streamId,
            runId,
          });
          return { hunkCount: 0, docWritten: false };
        }
        warnIfSelectionDiffEscapesSelectedBlocks({ state, hunks, streamId, runId });

        state.suggestions.clear();
        state.patchVerdicts.clear();
        clearReviewDiffState(state);
        state.suggestionBaseDoc = clonePmDoc(baseDoc);
        state.suggestionBaseVersion = baseVersion;

        const suggestions = hunks.map((hunk) =>
          suggestionFromDiffHunk({
            hunk,
            docId: state.docId,
            baseVersion,
            baseSchemaVersion: baseDoc.attrs.schemaVersion,
          }),
        );
        suggestions.forEach((suggestion, index) => {
          const hunk = hunks[index]!;
          const record: SuggestionRecord = {
            messageId: agentMessageId,
            toolCallId: hunk.hunkId,
            before: hunk.beforeText ?? "",
            after: hunk.afterText ?? "",
            blockIndex: hunk.blockPath[0] ?? 0,
            suggestion,
            diffHunk: hunk,
          };
          state.suggestions.set(suggestion.id, record);
        });

        await Promise.all(
          suggestions.map((suggestion) =>
            upsertDocumentSuggestion(suggestion).catch((err) => {
              logger.warn("Failed to persist candidate-diff suggestion", {
                suggestionId: suggestion.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }),
          ),
        );

        let draftPersistWarning: BridgeFrame | null = null;
        try {
          await documentDraftRepo.savePending({
            docId: state.docId,
            threadId: state.threadId ?? state.sessionId,
            baseVersion,
            baseHash: getPmContentHash(baseDoc),
            draftPmDoc: draftDoc,
            reviewBatchId: suggestions[0]?.reviewBatchId ?? null,
            groupMode: suggestions[0]?.groupMode ?? null,
          });
        } catch (err) {
          logger.error("Failed to persist pending review draft", {
            sessionId: state.sessionId,
            docId: state.docId,
            error: err instanceof Error ? err.message : String(err),
          });
          draftPersistWarning = {
            kind: "stream",
            data: {
              kind: "draftingFailed",
              data: {
                streamId,
                reason: "本次待审草稿未持久化,刷新可能无法恢复。",
                retriable: false,
              },
            },
          };
        }

        if (draftPersistWarning) {
          yield draftPersistWarning;
        }
        yield docDiffReady(baseVersion, suggestions, baseDoc, draftDoc);

        for (const record of state.suggestions.values()) {
          const spec = buildSuggestionToolCallSpec(record.suggestion, { kind: "reviewing" });
          yield toolCallUpdated(record.messageId, record.suggestion.id, spec);
        }

        const summarySeq = nextSeq(state, agentMessageId);
        const summaryPart: MessagePart = {
          kind: "patchSummary",
          data: { count: suggestions.length, hunkIds: suggestions.map((s) => s.id) },
        };
        yield chatMessageAppended(agentMessageId, summarySeq, summaryPart);
        appendPartToChatHistory(state, agentMessageId, summaryPart);

        clearDraftMutationScratch(state);
        recordStateChangeSpan(state, {
          transition: "enter_review",
          hunkCount: suggestions.length,
          docVersion: baseVersion,
        }, {
          streamId,
          runId,
        });
        yield* transitionAndProjectDocState(state, { kind: "pendingReview" }, "enter_review");
        recordSettleResultSpan(state, {
          branch: "candidateDiff",
          hunkCount: suggestions.length,
          docWritten: false,
          finalVersion: baseVersion,
          sourceStreamId: streamId,
          runId,
        });
        return { hunkCount: suggestions.length, docWritten: false };
      }
    }
  }

  if (!candidate && state.suggestions.size > 0) {
    const suggestions = Array.from(state.suggestions.values()).map((record) => record.suggestion);
    const baseVersion = state.suggestionBaseVersion ?? state.docVersion;
    yield docDiffReady(
      baseVersion,
      suggestions,
      state.doc,
      state.docDraftCandidateDoc ?? undefined,
    );

    for (const record of state.suggestions.values()) {
      const spec = buildSuggestionToolCallSpec(record.suggestion, { kind: "reviewing" });
      yield toolCallUpdated(record.messageId, record.suggestion.id, spec);
    }

    const summarySeq = nextSeq(state, agentMessageId);
    const summaryPart: MessagePart = {
      kind: "patchSummary",
      data: { count: suggestions.length, hunkIds: suggestions.map((s) => s.id) },
    };
    yield chatMessageAppended(agentMessageId, summarySeq, summaryPart);
    appendPartToChatHistory(state, agentMessageId, summaryPart);

    clearDraftMutationScratch(state);
    recordStateChangeSpan(state, {
      transition: "enter_review",
      hunkCount: suggestions.length,
      docVersion: baseVersion,
    }, {
      streamId,
      runId,
    });
    yield* transitionAndProjectDocState(state, { kind: "pendingReview" }, "enter_review");
    recordSettleResultSpan(state, {
      branch: "candidateDiff",
      hunkCount: suggestions.length,
      docWritten: false,
      finalVersion: baseVersion,
      sourceStreamId: streamId,
      runId,
    });
    return { hunkCount: suggestions.length, docWritten: false };
  }

  if (!candidate) {
    recordSettleResultSpan(state, {
      branch: "noop",
      hunkCount: 0,
      docWritten: false,
      finalVersion: state.docVersion,
      sourceStreamId: streamId,
      runId,
    });
    return { hunkCount: 0, docWritten: false };
  }

  const baseSections = state.docDraftBaseSections ?? cloneLegacySections(state.legacySections);
  const baseVersion = state.docDraftBaseVersion ?? state.docVersion;

  if (wholeDocument) {
    const nextVersionDoc = state.docDraftCandidateDoc ?? legacySectionsToPm(candidate as never);
    const result = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: baseVersion,
      opId: `generation:${state.sessionId}:${streamId}`,
      opKind: "replace_doc",
      actorType: "agent",
      summary: "AI 生成文档",
      createIfMissing: {
        title: state.title,
        docState: "editing",
        lastSyncedVersion: state.lastSyncedDocumentSnapshot,
      },
      apply: () => ({ nextDoc: nextVersionDoc }),
    });

    if (result.status !== "committed") {
      const reason =
        result.status === "conflict"
          ? `文档已被并发更新（当前版本 ${result.currentVersion}），本次生成未写入。`
          : result.status === "validation_error"
            ? "生成文档未通过 PM schema 校验，未写入。"
            : result.status === "patch_conflict"
              ? "生成提交遇到 patch 冲突，未写入。"
              : "文档不存在，生成结果未写入。";
      if (emitGenerationEvent && generationId) {
        yield {
          kind: "docGenerationEvent",
          data: nextDocGenerationEvent(generationId, generationLastSeq, {
            kind: "generation_failed",
            data: { reason },
          }),
        };
      } else {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: { streamId, reason, retriable: true },
          },
        };
      }
      clearDraftConfirmationState(state);
      yield* syncContentAndProjectDocState(state, "generate_doc_failed");
      recordSettleResultSpan(state, {
        branch: "wholeDocument",
        hunkCount: 0,
        docWritten: false,
        finalVersion: state.docVersion,
        sourceStreamId: streamId,
        runId,
      });
      return { hunkCount: 0, docWritten: false };
    }

    state.doc = result.doc;
    state.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
    state.docVersion = result.docVersion;
    state._directionChangeAskedSinceLastWrite = false;
    requestContext?.set("legacySections", state.legacySections);
    requestContext?.set("doc", result.doc);
    requestContext?.set("directionChangeAskedSinceLastWrite", false);
    const versionDoc = buildDocumentSnapshot(state.legacySections, state.docVersion, result.doc);
    const committedDoc = result.doc;
    if (emitGenerationEvent && generationId) {
      yield {
        kind: "docGenerationEvent",
        data: nextDocGenerationEvent(generationId, generationLastSeq, {
          kind: "generation_finished",
          data: {
            doc: committedDoc,
            finalVersion: state.docVersion,
            contentHash: getPmContentHash(committedDoc),
          },
        }),
      };
    } else {
      yield {
        kind: "documentSnapshotWritten",
        data: { doc: versionDoc },
      };
    }

    const nextTitle = deriveTitleFromSections(state.legacySections);
    if (nextTitle) {
      state.title = nextTitle;
      yield {
        kind: "sessionMeta",
        data: { sessionId: state.sessionId, title: state.title },
      };
    }

    await documentDraftRepo.clear(state.docId).catch((err) => {
      logger.warn("Failed to clear pending draft after whole document commit", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    clearDraftConfirmationState(state);
    clearSuggestionReviewState(state);
    yield* transitionAndProjectDocState(
      state,
      { kind: "editing" },
      "draft_candidate_committed",
    );
    recordSettleResultSpan(state, {
      branch: "wholeDocument",
      hunkCount: 0,
      docWritten: true,
      finalVersion: state.docVersion,
      sourceStreamId: streamId,
      runId,
    });
    return { hunkCount: 0, docWritten: true };
  }

  void baseSections;
  void candidate;
  void baseVersion;
  clearDraftConfirmationState(state);
  clearReviewDiffState(state);
  yield* syncContentAndProjectDocState(state, "draft_candidate_noop");
  recordSettleResultSpan(state, {
    branch: "noop",
    hunkCount: 0,
    docWritten: false,
    finalVersion: state.docVersion,
    sourceStreamId: streamId,
    runId,
  });
  return { hunkCount: 0, docWritten: false };
}

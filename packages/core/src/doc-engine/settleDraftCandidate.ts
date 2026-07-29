import type { BridgeFrame, LegacySection, MessagePart } from "@qingagent/contract-ts";
import type { RequestContext } from "@mastra/core/request-context";
import { mastra } from "../mastra.js";
import { documentDraftRepo } from "@qingagent/db";
import { persistMappedAnnotationGroups, saveInitialReviewBatch } from "@qingagent/db";
import { buildDocumentSnapshot } from "./docGenerator.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { cloneLegacySections } from "./docDiff.js";
import { buildDraftDiff } from "./proposalDiff.js";
import { createSuggestionBatchId } from "./draftReviewSuggestions.js";
import type { SessionState, SuggestionRecord } from "../session/sessionState.js";
import { appendPartToChatHistory, nextSeq } from "../session/sessionState.js";
import {
  chatMessageAppended,
  docDiffReady,
  toolCallUpdated,
} from "../agent-run/frames.js";
import {
  buildSuggestionToolCallSpec,
  suggestionFromDiffHunk,
} from "../agent-run/toolCards.js";
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
} from "../agent-run/agentSpans.js";
import { deriveTitleFromSections } from "../session/title.js";
import { generateTitleAfterFirstDraft } from "../session/titleGeneration.js";
import {
  buildAnnotationMappingSteps,
  mapAnnotationGroupsThroughSteps,
} from "./annotationMapping.js";
import {
  getPmContentHash,
  legacySectionsToPm,
  pmToLegacySections,
} from "@qingagent/pm-schema";
import { Buffer } from "node:buffer";

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

        const batchId = createSuggestionBatchId(baseVersion, draftDoc);
        const suggestions = hunks.map((hunk) =>
          suggestionFromDiffHunk({
            hunk,
            docId: state.docId,
            baseVersion,
            baseSchemaVersion: baseDoc.attrs.schemaVersion,
            batchId,
          }),
        );
        try {
          await saveInitialReviewBatch({
            draft: {
              docId: state.docId,
              threadId: state.threadId ?? state.sessionId,
              baseVersion,
              baseHash: getPmContentHash(baseDoc),
              draftPmDoc: draftDoc,
              batchId,
              reviewBatchId: suggestions[0]?.reviewBatchId ?? null,
              groupMode: suggestions[0]?.groupMode ?? null,
            },
            suggestions,
          });
        } catch (err) {
          logger.error("Failed to persist candidate-diff review state", {
            sessionId: state.sessionId,
            docId: state.docId,
            error: err instanceof Error ? err.message : String(err),
          });
          yield {
            kind: "stream",
            data: {
              kind: "draftingFailed",
              data: {
                streamId,
                reason: "本次待审草稿保存失败，请重试。",
                retriable: true,
              },
            },
          };
          return { hunkCount: 0, docWritten: false };
        }

        state.suggestions.clear();
        state.patchVerdicts.clear();
        clearReviewDiffState(state);
        state.suggestionBaseDoc = clonePmDoc(baseDoc);
        state.suggestionBaseVersion = baseVersion;
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
    const previousDoc = currentPmDoc(state);
    const previousDocVersion = state.docVersion;
    let transactionEffectPersisted = false;
    type PendingAnnotationMapping = {
      mapped: ReturnType<typeof mapAnnotationGroupsThroughSteps>;
      replacedOrigins: string[];
    };
    let transactionAnnotationMapping: PendingAnnotationMapping | null = null;
    let result: Awaited<ReturnType<typeof commitDocumentOp>>;
    try {
      result = await commitDocumentOp(
        {
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
        },
        {
          transactionalEffect: async ({ client, result: committed }) => {
            let nextAnnotationMapping: PendingAnnotationMapping | null = null;
            if (state.annotationGroups.length > 0) {
              const replacedOrigins = [
                ...new Set(state.annotationGroups.map((group) => group.origin)),
              ];
              const mapped = mapAnnotationGroupsThroughSteps(
                state.annotationGroups,
                buildAnnotationMappingSteps(previousDoc, committed.doc),
                committed.doc,
              );
              await persistMappedAnnotationGroups(
                state.docId,
                mapped.groups,
                mapped.survivingAnchorIndexes,
                client,
              );
              nextAnnotationMapping = { mapped, replacedOrigins };
            }
            transactionAnnotationMapping = nextAnnotationMapping;
            transactionEffectPersisted = true;
          },
        },
      );
    } catch (error) {
      const reason = "生成提交关联状态保存失败，本次生成未写入。";
      logger.error("Whole document commit transaction failed", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: error instanceof Error ? error.message : String(error),
      });
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

    advanceLastContentEditedAt(state, result, previousDocVersion);
    state.doc = result.doc;
    state.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
    state.docVersion = result.docVersion;
    state.modelKnownDocVersion = result.docVersion;
    state._directionChangeAskedSinceLastWrite = false;
    requestContext?.set("legacySections", state.legacySections);
    requestContext?.set("doc", result.doc);
    requestContext?.set("directionChangeAskedSinceLastWrite", false);
    let annotationMapping: PendingAnnotationMapping | null = transactionAnnotationMapping;
    if (!transactionEffectPersisted && state.annotationGroups.length > 0) {
      const replacedOrigins = [...new Set(state.annotationGroups.map((group) => group.origin))];
      const mapped = mapAnnotationGroupsThroughSteps(
        state.annotationGroups,
        buildAnnotationMappingSteps(previousDoc, result.doc),
        result.doc,
      );
      await persistMappedAnnotationGroups(
        state.docId,
        mapped.groups,
        mapped.survivingAnchorIndexes,
      );
      annotationMapping = { mapped, replacedOrigins };
    }
    if (annotationMapping) {
      const { mapped, replacedOrigins } = annotationMapping;
      state.annotationGroups = mapped.groups;
      yield {
        kind: "annotationGroupsReady",
        data: { groups: mapped.groups, replacedOrigins },
      };
    }
    const versionDoc = buildDocumentSnapshot(state.legacySections, state.docVersion, result.doc);
    const committedDoc = result.doc;
    if (emitGenerationEvent && generationId) {
      const event = nextDocGenerationEvent(generationId, generationLastSeq, {
          kind: "generation_finished",
          data: {
            doc: committedDoc,
            finalVersion: state.docVersion,
            contentHash: getPmContentHash(committedDoc),
          },
        });
      const frame: BridgeFrame = {
        kind: "docGenerationEvent",
        data: event,
      };
      logger.info("[terminal-document] generated", {
        stage: "generated",
        sessionId: state.sessionId,
        streamId,
        frameSeq: event.data.seq,
        generationId,
        documentVersion: state.docVersion,
        contentHash: getPmContentHash(committedDoc),
        frameBytes: Buffer.byteLength(JSON.stringify(frame), "utf8"),
      });
      yield frame;
    } else {
      yield {
        kind: "documentSnapshotWritten",
        data: { doc: versionDoc },
      };
    }

    const abortSignal = requestContext?.get("abortSignal") as AbortSignal | undefined;
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
    if (abortSignal?.aborted) {
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

    const isFirstSuccessfulDraft = previousDocVersion === 0;
    const nextTitle = state.titlePinned
      ? null
      : isFirstSuccessfulDraft
        ? await generateTitleAfterFirstDraft(state, requestContext)
        : deriveTitleFromSections(state.legacySections);
    if (nextTitle) {
      state.title = nextTitle;
      yield {
        kind: "sessionMeta",
        data: { sessionId: state.sessionId, title: state.title },
      };
    }
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
  await documentDraftRepo.clear(state.docId).catch((err) => {
    logger.warn("Failed to clear discarded pending draft row", {
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

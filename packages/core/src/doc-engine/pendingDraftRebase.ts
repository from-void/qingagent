import type { DiffHunk } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  materializeDraftBlockIds,
  safeParsePmDoc,
  type PmDoc,
} from "@qingagent/pm-schema";
import { documentDraftRepo } from "@qingagent/db";
import { mastra } from "../mastra.js";
import { applyDiffHunks, buildDraftDiff } from "./proposalDiff.js";
import { createSuggestionBatchId } from "./draftReviewSuggestions.js";
import type { SuggestionRecord } from "../session/sessionState.js";

const logger = mastra.getLogger();

export interface DroppedPendingDraftRecord {
  record: SuggestionRecord;
  hunkId?: string;
  reason: string;
}

export type PendingDraftRebaseResult =
  | {
      status: "pending";
      nextDraftDoc: PmDoc;
      hunks: DiffHunk[];
      baseHash: string;
      dropped: DroppedPendingDraftRecord[];
    }
  | { status: "cleared"; dropped: DroppedPendingDraftRecord[] }
  | { status: "conflict"; reason: string; conflict: unknown };

export interface RebaseRemainingPendingDraftInput {
  docId: string;
  threadId: string;
  oldBaseDoc: PmDoc;
  oldDraftDoc: PmDoc;
  committedDoc: PmDoc;
  committedVersion: number;
  remainingRecords: readonly SuggestionRecord[];
  persist?: boolean;
  persistPending?: boolean;
}

function clonePmDoc(doc: PmDoc): PmDoc {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(doc) as PmDoc;
  }
  return JSON.parse(JSON.stringify(doc)) as PmDoc;
}

export async function rebaseRemainingPendingDraft(
  input: RebaseRemainingPendingDraftInput,
): Promise<PendingDraftRebaseResult> {
  void input.oldDraftDoc;

  if (input.remainingRecords.length === 0) {
    if (input.persist !== false) {
      await documentDraftRepo.clear(input.docId);
    }
    return { status: "cleared", dropped: [] };
  }

  let nextDraftDoc = clonePmDoc(input.committedDoc);
  // 一处 AI 改稿在文档里会被拆成多处 hunk 逐处评审。采纳/拒绝其中一处后,余下某处的锚点块
  // 可能已被那次决定移除或改写(典型:整体是"移除"类编辑,拒了第一处后,后面几处指向的块没了)。
  // 此前的实现遇到"某一处锚不到/落点非法"就把【整轮评审】判 conflict 锁死——用户连撤销、提交都点
  // 不动,彻底卡住(线上 225ca665 复现)。正确做法是按用户口径"既然拆了地方,就从当前已提交的
  // 文档地方开始算,不要保留原始整体内容":丢弃那一处无法落点的改动,余下能落点的继续 rebase,
  // 让评审始终可继续,绝不因一处失败而整轮锁死。
  const dropped: DroppedPendingDraftRecord[] = [];
  const recordsWithHunks: Array<{ record: SuggestionRecord; hunk: DiffHunk }> = [];
  for (const record of input.remainingRecords) {
    const hunk = record.diffHunk;
    if (!hunk) {
      dropped.push({ record, reason: "missing diffHunk" });
      continue;
    }
    recordsWithHunks.push({ record, hunk });
  }
  const replayed = applyDiffHunks(
    nextDraftDoc,
    recordsWithHunks.map(({ hunk }) => hunk),
    { oldBaseDoc: input.oldBaseDoc },
  );
  const recordByHunkId = new Map(recordsWithHunks.map(({ record, hunk }) => [hunk.hunkId, record] as const));
  for (const detail of replayed.skippedDetails) {
    const record = recordByHunkId.get(detail.hunk.hunkId);
    if (record) dropped.push({ record, hunkId: detail.hunk.hunkId, reason: detail.reason });
  }
  const parsed = safeParsePmDoc(replayed.doc);
  if (parsed.success) {
    nextDraftDoc = materializeDraftBlockIds(parsed.data as PmDoc, {
      namespace: "draft.rebase",
    });
  } else {
    for (const hunk of replayed.applied) {
      const record = recordByHunkId.get(hunk.hunkId);
      if (record) dropped.push({ record, hunkId: hunk.hunkId, reason: parsed.error.message });
    }
    nextDraftDoc = clonePmDoc(input.committedDoc);
  }
  if (dropped.length > 0) {
    // 不静默丢弃:落点失败的改动本就无法应用(其目标块已被同轮其它决定改掉),记录下来便于排查。
    logger.warn("rebase: dropped un-anchorable hunks to keep review unblocked", {
      docId: input.docId,
      droppedCount: dropped.length,
      dropped: dropped.map((item) => ({
        suggestionId: item.record.suggestion.id,
        hunkId: item.hunkId,
        reason: item.reason,
      })),
    });
  }

  const baseHash = getPmContentHash(input.committedDoc);
  const hunks = buildDraftDiff(input.committedDoc, nextDraftDoc, {
    baseVersion: input.committedVersion,
  });
  if (hunks.length === 0) {
    if (input.persist !== false) {
      await documentDraftRepo.clear(input.docId);
    }
    return { status: "cleared", dropped };
  }

  if (input.persist !== false && input.persistPending !== false) {
    const first = input.remainingRecords[0]?.suggestion;
    await documentDraftRepo.savePending({
      docId: input.docId,
      threadId: input.threadId,
      baseVersion: input.committedVersion,
      baseHash,
      draftPmDoc: nextDraftDoc,
      batchId: createSuggestionBatchId(input.committedVersion, nextDraftDoc),
      reviewBatchId: first?.reviewBatchId ?? null,
      groupMode: first?.groupMode ?? null,
    });
  }

  return {
    status: "pending",
    nextDraftDoc,
    hunks,
    baseHash,
    dropped,
  };
}

import { countDocVisibleChars, countVisibleChars, type PmDoc } from "@qingagent/pm-schema";
import type { Command, ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";
import type { DocDimensions } from "./docDimensions";
import type { AppliedPatch, ToolCallSpec, ViewDocumentSnapshot } from "./protocol";
import type { PatchMeta, PatchMetaChange } from "./patchMeta";
export { canUseDocumentEditing } from "./workspacePageView";

function reviewPatchVisibleChangeChars(patch: ToolCallSpec): number {
  if (patch.body.kind !== "docSuggestion") return 0;
  if (patch.body.data.kind !== "suggestion") return 0;
  const status = patch.status.kind;
  if (status !== "reviewing" && status !== "accepted" && status !== "rejected") return 0;
  const suggestion = patch.body.data.data;
  const before = suggestion.diffHunk?.beforeText ?? suggestion.preview.deleteText;
  const after = suggestion.diffHunk?.afterText ?? suggestion.preview.insertText;
  return countVisibleChars(before ?? "") + countVisibleChars(after ?? "");
}

export function computeWholeDocReviewChangeRatio(input: {
  patches: readonly ToolCallSpec[];
  baseDoc?: PmDoc | null;
  editedDoc?: PmDoc | null;
}): number {
  const changed = input.patches.reduce(
    (sum, patch) => sum + reviewPatchVisibleChangeChars(patch),
    0,
  );
  const total =
    (input.baseDoc ? countDocVisibleChars(input.baseDoc) : 0) +
    (input.editedDoc ? countDocVisibleChars(input.editedDoc) : 0);
  return total > 0 ? changed / total : 0;
}

export function reviewBatchIdFromPatch(patch: ToolCallSpec): string {
  if (patch.body.kind !== "docSuggestion") return patch.id;
  const body = patch.body.data;
  if (body.kind !== "suggestion") return patch.id;
  return body.data.reviewBatchId ?? body.data.diffHunk?.reviewBatchId ?? patch.id;
}

export function buildPatchVerdictCommand(
  patches: readonly ToolCallSpec[],
  patchId: string,
  verdict: "accepted" | "rejected",
): Extract<Command, { kind: "acceptPatch" }> | Extract<Command, { kind: "rejectPatch" }> {
  void patches;
  return verdict === "accepted"
    ? { kind: "acceptPatch", data: { id: patchId } }
    : { kind: "rejectPatch", data: { id: patchId } };
}

export function buildReviewGroupCommitSelection(
  patches: readonly ToolCallSpec[],
): {
  acceptReviewBatchIds: string[];
  rejectReviewBatchIds: string[];
} {
  const canceledByBatch = new Map<string, boolean>();
  for (const patch of patches) {
    const reviewBatchId = reviewBatchIdFromPatch(patch);
    const alreadyCanceled = canceledByBatch.get(reviewBatchId) ?? false;
    canceledByBatch.set(
      reviewBatchId,
      alreadyCanceled || patch.status.kind === "rejected",
    );
  }
  return {
    acceptReviewBatchIds: [...canceledByBatch.entries()]
      .filter(([, canceled]) => !canceled)
      .map(([reviewBatchId]) => reviewBatchId),
    rejectReviewBatchIds: [...canceledByBatch.entries()]
      .filter(([, canceled]) => canceled)
      .map(([reviewBatchId]) => reviewBatchId),
  };
}

/**
 * "放弃全部(剩余)"的判定:
 * - 新逐处数据一处一个 batch,已 accepted 的处必须保留提交;
 * - 旧 atomic 数据可能多处共用 batch,commitReviewGroups 又只能按 batch 表达。
 *   因此只有同 batch 全部 accepted 才可保留;只要混着 reviewing/rejected/泄漏 done 态,
 *   整批按 reject 收口,避免把未审核 hunk 跟着误提交。
 */
function collectAcceptedBatchesForRejectAll(
  patches: readonly ToolCallSpec[],
): Set<string> {
  const byBatch = new Map<string, { hasAccepted: boolean; hasUnsafe: boolean }>();
  for (const patch of patches) {
    const batchId = reviewBatchIdFromPatch(patch);
    const state = byBatch.get(batchId) ?? { hasAccepted: false, hasUnsafe: false };
    if (patch.status.kind === "accepted") state.hasAccepted = true;
    else state.hasUnsafe = true;
    byBatch.set(batchId, state);
  }
  return new Set(
    [...byBatch.entries()]
      .filter(([, state]) => state.hasAccepted && !state.hasUnsafe)
      .map(([batchId]) => batchId),
  );
}

function collectRejectedBatchesForCommit(
  patches: readonly ToolCallSpec[],
): Set<string> {
  const rejected = new Set<string>();
  for (const patch of patches) {
    if (patch.status.kind === "rejected") {
      rejected.add(reviewBatchIdFromPatch(patch));
    }
  }
  return rejected;
}

export function buildReviewGroupRejectSelection(
  patches: readonly ToolCallSpec[],
): {
  acceptReviewBatchIds: string[];
  rejectReviewBatchIds: string[];
} {
  const reviewable = patches.filter((patch) => {
    return (
      patch.body.kind === "docSuggestion" &&
      patch.body.data.kind === "suggestion" &&
      patch.status.kind !== "committed"
    );
  });
  const acceptedBatches = collectAcceptedBatchesForRejectAll(reviewable);
  const batchIds = [...new Set(reviewable.map(reviewBatchIdFromPatch))];
  return {
    acceptReviewBatchIds: batchIds.filter((batchId) => acceptedBatches.has(batchId)),
    rejectReviewBatchIds: batchIds.filter((batchId) => !acceptedBatches.has(batchId)),
  };
}

/** 单处修改在卡片/正文里的摘要上限,过长截断。 */
const REVIEW_OUTCOME_TEXT_CAP = 4000;

function clipReviewText(text: unknown): string {
  const t = typeof text === "string" ? text : "";
  return t.length > REVIEW_OUTCOME_TEXT_CAP ? `${t.slice(0, REVIEW_OUTCOME_TEXT_CAP)}…` : t;
}

/** 缩略摘要(一行)的长度上限:取首行并截到 ~60 字,避免摘要里夹换行/超长。 */
const BLOCK_SUMMARY_CAP = 60;
function clipBlockSummary(text: string): string {
  const firstLine = (text.split("\n")[0] ?? "").trim();
  return firstLine.length > BLOCK_SUMMARY_CAP
    ? `${firstLine.slice(0, BLOCK_SUMMARY_CAP)}…`
    : firstLine;
}

/**
 * 从当前审阅态 patches 归并出本轮审核结果 ReviewOutcome（喂模型 + 渲染缩略卡的同源数据）。
 *
 * verdict 口径与提交语义对齐：新数据一处一个 batch,自然逐 hunk;旧 atomic
 * 同 batch 只要有一处 rejected,后端 commitReviewGroups 会整批拒绝,反馈也必须整批 rejected。
 * `rejectUndecided`（放弃本轮剩余）时口径翻转:只有用户
 * 明确采纳过且同 batch 全部 accepted 的处计 accepted,其余(未表态 reviewing 等)
 * 全部计 rejected——与 buildReviewGroupRejectSelection 的提交口径同源,保证反馈卡与实际落库一致。
 */
export function buildReviewOutcome(
  patches: readonly ToolCallSpec[],
  opts: { rejectUndecided?: boolean } = {},
): ReviewOutcome {
  const keptBatches = opts.rejectUndecided
    ? collectAcceptedBatchesForRejectAll(patches)
    : null;
  const rejectedBatches = opts.rejectUndecided
    ? null
    : collectRejectedBatchesForCommit(patches);
  const hunks: ReviewOutcomeHunk[] = [];
  for (const patch of patches) {
    if (patch.body.kind !== "docSuggestion" || patch.body.data.kind !== "suggestion") {
      continue;
    }
    const sug = patch.body.data.data;
    const batchId = reviewBatchIdFromPatch(patch);
    const verdict: ReviewOutcomeHunk["verdict"] = keptBatches
      ? keptBatches.has(batchId)
        ? "accepted"
        : "rejected"
      : rejectedBatches?.has(batchId) || patch.status.kind === "rejected"
        ? "rejected"
        : "accepted";
    const beforeText = clipReviewText(sug.diffHunk?.beforeText ?? sug.preview?.deleteText ?? "");
    const afterText = clipReviewText(sug.diffHunk?.afterText ?? sug.preview?.insertText ?? "");
    // 缩略摘要优先用能定位到正文的真实文字片段(原文/引用/新增文字),其次才回落模型的笼统
    // summary(常是"替换文本"这类无信息量的标签)。截到一行长度,卡片再靠 CSS 省略号收口。
    const summaryBase =
      (sug.anchor?.quote || "").trim() ||
      beforeText.trim() ||
      afterText.trim() ||
      (sug.diffHunk?.summary || sug.summary || "").trim();
    const blockSummary = clipBlockSummary(summaryBase);
    hunks.push({ verdict, blockSummary, beforeText, afterText });
  }
  return {
    acceptedCount: hunks.filter((h) => h.verdict === "accepted").length,
    rejectedCount: hunks.filter((h) => h.verdict === "rejected").length,
    hunks,
  };
}

/**
 * 审核提交/放弃后,若非全量采纳(有拒绝)则以用户名义回流审核结果,驱动模型追问。
 * 全量采纳(rejectedCount===0)不打扰。校验失败/网络失败仅记日志,不阻塞审核收口主流程。
 */
export function sendReviewOutcomeFollowup(
  stream: { sendCommand: (cmd: Command) => Promise<unknown> },
  sessionId: string,
  outcome: ReviewOutcome,
): void {
  if (outcome.rejectedCount === 0) return;
  const command: Command = { kind: "submitReviewOutcome", data: { sessionId, outcome } };
  try {
    validateCommand(command);
  } catch (e) {
    console.error("[workspace] submitReviewOutcome validation failed", e);
    return;
  }
  void stream.sendCommand(command).catch((e) => {
    console.error("[workspace] submitReviewOutcome failed", e);
  });
}

export function shouldSuppressPresentationRun(input: {
  hasDocDiff: boolean;
  contentKind: DocDimensions["content"]["kind"];
}): boolean {
  return input.hasDocDiff || input.contentKind === "pendingReview";
}

export function shouldRetainPresentationRun(input: {
  reducedMotion: boolean;
  runDocVersion: number;
  currentDocVersion: number | null;
  runSessionId: string | null;
  currentSessionId: string | null;
}): boolean {
  return (
    !input.reducedMotion &&
    input.runDocVersion === input.currentDocVersion &&
    input.runSessionId === input.currentSessionId
  );
}

export function shouldDispatchManualDocSavedForWriteResult(input: {
  isLatestOwnMutation: boolean;
  writeOk: boolean;
  hasLastSentPmDoc: boolean;
  hasQueuedPmDoc: boolean;
}): boolean {
  return (
    input.isLatestOwnMutation &&
    input.writeOk &&
    input.hasLastSentPmDoc &&
    !input.hasQueuedPmDoc
  );
}

export function shouldCloseMaterialPreviewForReview(input: {
  contentKind: DocDimensions["content"]["kind"];
  wholeDocReview: boolean;
}): boolean {
  return input.contentKind === "pendingReview" || input.wholeDocReview;
}

export function deriveReviewRenderMode(input: {
  effectiveReview: boolean;
  editedNewDoc: ViewDocumentSnapshot | null;
  changeRatio: number;
  wholeDocReviewThreshold: number;
  wholeDocument?: boolean;
}): {
  wholeDocReview: boolean;
  awaitingWholeDocReviewMaterial: boolean;
  inlinePatchReview: boolean;
} {
  const wholeDocReview =
    input.effectiveReview &&
    input.editedNewDoc != null &&
    (input.wholeDocument === true ||
      input.changeRatio >= input.wholeDocReviewThreshold);
  return {
    wholeDocReview,
    // docDiffReady 是一次性帧;缺 editedDoc 是老会话/坏帧,不是可等待的后续材料。
    awaitingWholeDocReviewMaterial: false,
    inlinePatchReview: input.effectiveReview && !wholeDocReview,
  };
}

function patchMetaChangeFromApplied(patch: AppliedPatch): PatchMetaChange {
  if (patch.kind === "markAdd" || patch.kind === "markRemove") {
    return {
      kind: "mark",
      op: patch.kind,
      ...(patch.marks ? { marks: patch.marks } : {}),
      ...(patch.label ? { label: patch.label } : {}),
    };
  }
  return {
    kind: "content",
    before: patch.before,
    after: patch.after,
  };
}

export function buildPatchMeta(applied: readonly AppliedPatch[]): Map<string, PatchMeta> {
  const ownChangeById = new Map<string, PatchMetaChange>();
  const changesByReviewBatch = new Map<string, PatchMetaChange[]>();

  for (const patch of applied) {
    const change = patchMetaChangeFromApplied(patch);
    ownChangeById.set(patch.id, change);
    const changes = changesByReviewBatch.get(patch.reviewBatchId) ?? [];
    changes.push(change);
    changesByReviewBatch.set(patch.reviewBatchId, changes);
  }

  const map = new Map<string, PatchMeta>();
  for (const patch of applied) {
    const groupChanges = changesByReviewBatch.get(patch.reviewBatchId) ?? [];
    const hasContent = groupChanges.some((change) => change.kind === "content");
    const hasMark = groupChanges.some((change) => change.kind === "mark");
    const ownChange = ownChangeById.get(patch.id);
    map.set(patch.id, {
      before: patch.before,
      after: patch.after,
      kind: patch.kind,
      ...(patch.marks ? { marks: patch.marks } : {}),
      ...(patch.label ? { label: patch.label } : {}),
      ...(patch.beforePmNodes && patch.beforePmNodes.length > 0 ? { beforePmNodes: patch.beforePmNodes } : {}),
      changes: hasContent && hasMark && groupChanges.length > 1
        ? groupChanges
        : ownChange
          ? [ownChange]
          : [],
      index: patch.index,
    });
  }
  return map;
}

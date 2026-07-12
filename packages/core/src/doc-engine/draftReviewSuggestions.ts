import crypto from "node:crypto";
import type { DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import type { PmStep } from "@qingagent/pm-schema";

function hashSuggestionText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function blockIdFromDiffNode(node: DiffHunk["beforeBlock"] | DiffHunk["afterBlock"]): string | null {
  const attrs = node && "attrs" in node
    ? (node.attrs as { blockId?: unknown })
    : undefined;
  const blockId = attrs && typeof attrs.blockId === "string" ? attrs.blockId : null;
  return blockId && blockId.length > 0 ? blockId : null;
}

export function diffHunkToStep(hunk: DiffHunk, pmFrom: number, pmTo: number): PmStep {
  if (hunk.op === "markAdd" || hunk.op === "markRemove") {
    return {
      stepType: hunk.op === "markAdd" ? "addMark" : "removeMark",
      from: pmFrom,
      to: pmTo,
    };
  }
  if (hunk.op === "insert") {
    return {
      stepType: "replace",
      from: pmFrom,
      to: pmFrom,
      slice: { content: hunk.after ?? [], openStart: 0, openEnd: 0 },
    };
  }
  if (hunk.op === "delete") {
    return { stepType: "replace", from: pmFrom, to: pmTo };
  }
  return {
    stepType: "replace",
    from: pmFrom,
    to: pmTo,
    slice: { content: hunk.after ?? [], openStart: 0, openEnd: 0 },
  };
}

export function createSuggestionFromDiffHunk(input: {
  hunk: DiffHunk;
  docId: string;
  baseVersion: number;
  baseSchemaVersion: number;
}): DocSuggestion {
  const { hunk } = input;
  const pmFrom = hunk.anchor.pmFrom ?? 0;
  const pmTo = hunk.anchor.pmTo ?? pmFrom;
  const quote = hunk.beforeText || hunk.afterText || hunk.summary || hunk.hunkId;
  const blockId =
    hunk.anchor.blockId ??
    blockIdFromDiffNode(hunk.beforeBlock) ??
    blockIdFromDiffNode(hunk.afterBlock) ??
    hunk.hunkId;
  return {
    id: hunk.hunkId,
    docId: input.docId,
    baseVersion: input.baseVersion,
    baseSchemaVersion: input.baseSchemaVersion,
    status: "reviewing",
    anchor: {
      blockId,
      pmFrom,
      pmTo,
      quote,
      textHash: hashSuggestionText(quote),
    },
    patch: { kind: "prosemirror_steps", steps: [diffHunkToStep(hunk, pmFrom, pmTo)] },
    preview: {
      deleteText: hunk.beforeText ?? "",
      insertText: hunk.afterText ?? "",
    },
    reviewBatchId: hunk.reviewBatchId,
    groupMode: hunk.groupMode,
    diffHunk: hunk,
    summary: hunk.summary || "候选草稿差异",
  };
}

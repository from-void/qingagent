import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  normalizePmDoc,
  safeParsePmDoc,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { ViewDocumentSnapshot } from "./protocol";
import { viewDocToPm } from "./viewDocHtml";
import { pmDocHasSubstantiveContent } from "./pageExitSave";

const STORAGE_PREFIX = "qingagent.review_commit_undo.v1";

export interface ReviewCommitUndoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ReviewCommitUndoSnapshot {
  kind: "reviewCommitUndo";
  sessionId: string;
  beforeDoc: PmDoc;
  beforeVersion: number;
  afterVersion: number;
  afterContentHash: string;
  afterHasSubstantiveContent: boolean;
  createdAt: number;
}

const memorySnapshots = new Map<string, ReviewCommitUndoSnapshot>();

function defaultStorage(): ReviewCommitUndoStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}:${sessionId}`;
}

function parseSnapshot(value: unknown): ReviewCommitUndoSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ReviewCommitUndoSnapshot>;
  if (
    candidate.kind !== "reviewCommitUndo" ||
    typeof candidate.sessionId !== "string" ||
    candidate.sessionId.length === 0 ||
    typeof candidate.beforeVersion !== "number" ||
    typeof candidate.afterVersion !== "number" ||
    !Number.isInteger(candidate.beforeVersion) ||
    !Number.isInteger(candidate.afterVersion) ||
    candidate.beforeVersion < 0 ||
    candidate.afterVersion <= candidate.beforeVersion ||
    typeof candidate.afterContentHash !== "string" ||
    candidate.afterContentHash.length === 0 ||
    typeof candidate.afterHasSubstantiveContent !== "boolean" ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }
  const parsedDoc = safeParsePmDoc(candidate.beforeDoc);
  if (!parsedDoc.success) return null;
  return {
    kind: "reviewCommitUndo",
    sessionId: candidate.sessionId,
    beforeDoc: normalizePmDoc(parsedDoc.data),
    beforeVersion: candidate.beforeVersion,
    afterVersion: candidate.afterVersion,
    afterContentHash: candidate.afterContentHash,
    afterHasSubstantiveContent: candidate.afterHasSubstantiveContent,
    createdAt: candidate.createdAt,
  };
}

function latestCommittedDocument(
  frames: readonly BridgeFrame[],
): { doc: PmDoc; version: number } | null {
  const committedVersion = [...frames]
    .reverse()
    .find((frame) => frame.kind === "docCommitted")?.data.version;
  if (committedVersion === undefined) return null;
  const snapshot = [...frames]
    .reverse()
    .find(
      (frame) =>
        frame.kind === "documentSnapshotWritten" &&
        frame.data.doc.version === committedVersion,
    );
  if (!snapshot || snapshot.kind !== "documentSnapshotWritten") return null;
  return {
    doc: normalizePmDoc(snapshot.data.doc.doc),
    version: snapshot.data.doc.version,
  };
}

export function buildReviewCommitUndoSnapshot(input: {
  sessionId: string;
  before: ViewDocumentSnapshot | null;
  frames: readonly BridgeFrame[];
  /** REST 迟到失败、但实时流已确认提交时的权威正文兜底。 */
  after?: ViewDocumentSnapshot | null;
  createdAt?: number;
}): ReviewCommitUndoSnapshot | null {
  if (!input.before) return null;
  let beforeDoc: PmDoc;
  try {
    beforeDoc = normalizePmDoc(viewDocToPm(input.before));
  } catch {
    return null;
  }
  const committed = latestCommittedDocument(input.frames);
  let afterDoc: PmDoc;
  let afterVersion: number;
  try {
    afterDoc = committed?.doc ?? normalizePmDoc(viewDocToPm(input.after!));
    afterVersion = committed?.version ?? input.after!.version;
  } catch {
    return null;
  }
  if (afterVersion <= input.before.version) return null;
  const beforeContentHash = getPmContentHash(beforeDoc);
  const afterContentHash = getPmContentHash(afterDoc);
  if (beforeContentHash === afterContentHash) return null;
  return {
    kind: "reviewCommitUndo",
    sessionId: input.sessionId,
    beforeDoc,
    beforeVersion: input.before.version,
    afterVersion,
    afterContentHash,
    afterHasSubstantiveContent: pmDocHasSubstantiveContent(afterDoc),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function isReviewCommitUndoApplicable(
  snapshot: ReviewCommitUndoSnapshot | null,
  sessionId: string | null,
  doc: ViewDocumentSnapshot | null,
): boolean {
  if (!snapshot || !sessionId || !doc) return false;
  if (
    snapshot.sessionId !== sessionId ||
    snapshot.afterVersion !== doc.version
  ) {
    return false;
  }
  try {
    return getPmContentHash(normalizePmDoc(viewDocToPm(doc))) ===
      snapshot.afterContentHash;
  } catch {
    return false;
  }
}

export function readReviewCommitUndoSnapshot(
  sessionId: string,
  storage: ReviewCommitUndoStorage | null = defaultStorage(),
): ReviewCommitUndoSnapshot | null {
  const remembered = memorySnapshots.get(sessionId);
  if (remembered) return remembered;
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = parseSnapshot(JSON.parse(raw));
    if (!parsed || parsed.sessionId !== sessionId) {
      storage.removeItem(storageKey(sessionId));
      return null;
    }
    memorySnapshots.set(sessionId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeReviewCommitUndoSnapshot(
  snapshot: ReviewCommitUndoSnapshot,
  storage: ReviewCommitUndoStorage | null = defaultStorage(),
): void {
  memorySnapshots.set(snapshot.sessionId, snapshot);
  if (!storage) return;
  try {
    storage.setItem(storageKey(snapshot.sessionId), JSON.stringify(snapshot));
  } catch {
    // 内存副本仍能覆盖当前单页会话；存储配额/隐私模式失败不影响提交本身。
  }
}

export function clearReviewCommitUndoSnapshot(
  sessionId: string,
  storage: ReviewCommitUndoStorage | null = defaultStorage(),
): void {
  memorySnapshots.delete(sessionId);
  if (!storage) return;
  try {
    storage.removeItem(storageKey(sessionId));
  } catch {
    // 清理失败只会留下内容 hash 不匹配、无法启用的旧快照。
  }
}

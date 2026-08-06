import type { BridgeFrame } from "@qingagent/contract-ts";
import { getPmContentHash, type PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { pmDocToViewDocumentSnapshot } from "./protocol";
import {
  buildReviewCommitUndoSnapshot,
  clearReviewCommitUndoSnapshot,
  isReviewCommitUndoApplicable,
  readReviewCommitUndoSnapshot,
  writeReviewCommitUndoSnapshot,
  type ReviewCommitUndoStorage,
} from "./reviewCommitUndo";

function paragraphDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text }],
    }],
  };
}

function memoryStorage(): ReviewCommitUndoStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("reviewCommitUndo", () => {
  it("从提交终态帧保存提交前正文，并只对精确的提交后版本启用", () => {
    const beforeDoc = paragraphDoc("提交前");
    const afterDoc = paragraphDoc("提交后");
    const frames: BridgeFrame[] = [
      {
        kind: "documentSnapshotWritten",
        data: { doc: { version: 2, ts: "t", doc: afterDoc } },
      },
      {
        kind: "docCommitted",
        data: { sessionId: "snapshot-s-1", version: 2, appliedCount: 1 },
      },
    ];
    const snapshot = buildReviewCommitUndoSnapshot({
      sessionId: "snapshot-s-1",
      before: pmDocToViewDocumentSnapshot(beforeDoc, 1),
      frames,
      createdAt: 123,
    });

    expect(snapshot).toMatchObject({
      sessionId: "snapshot-s-1",
      beforeVersion: 1,
      afterVersion: 2,
      afterContentHash: getPmContentHash(afterDoc),
      createdAt: 123,
    });
    expect(isReviewCommitUndoApplicable(
      snapshot,
      "snapshot-s-1",
      pmDocToViewDocumentSnapshot(afterDoc, 2),
    )).toBe(true);
    expect(isReviewCommitUndoApplicable(
      snapshot,
      "snapshot-s-1",
      pmDocToViewDocumentSnapshot(paragraphDoc("后来又改了"), 2),
    )).toBe(false);
  });

  it("跨组件挂载从存储恢复，损坏 JSON 与伪造文档都静默丢弃", () => {
    const storage = memoryStorage();
    const snapshot = buildReviewCommitUndoSnapshot({
      sessionId: "persist-s-1",
      before: pmDocToViewDocumentSnapshot(paragraphDoc("旧文"), 4),
      frames: [{
        kind: "documentSnapshotWritten",
        data: {
          doc: { version: 5, ts: "t", doc: paragraphDoc("新文") },
        },
      }, {
        kind: "docCommitted",
        data: { sessionId: "persist-s-1", version: 5 },
      }],
    })!;
    writeReviewCommitUndoSnapshot(snapshot, storage);
    clearReviewCommitUndoSnapshot("persist-s-1", null);
    expect(readReviewCommitUndoSnapshot("persist-s-1", storage)).toEqual(snapshot);

    storage.setItem(
      "qingagent.review_commit_undo.v1:broken-json",
      "{not json",
    );
    expect(readReviewCommitUndoSnapshot("broken-json", storage)).toBeNull();
    storage.setItem(
      "qingagent.review_commit_undo.v1:broken-doc",
      JSON.stringify({
        ...snapshot,
        sessionId: "broken-doc",
        beforeDoc: { type: "doc", content: [{ type: "unknown-node" }] },
      }),
    );
    expect(readReviewCommitUndoSnapshot("broken-doc", storage)).toBeNull();
  });
});

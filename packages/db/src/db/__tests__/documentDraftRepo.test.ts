import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPmContentHash,
  getStablePmJson,
  materializeDraftBlockIds,
  normalizePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
} from "@qingagent/pm-schema";
import { getDocumentsClient } from "../documentsClient.js";
import {
  documentDraftRepo,
} from "../documentDraftRepo.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let tempDb: TempDocumentsDb;

function text(value: string): PmInlineNode {
  return { type: "text", text: value };
}

function paragraph(blockId: string, value: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: value.length > 0 ? [text(value)] : [],
  };
}

function doc(blocks: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: blocks };
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-document-draft-");
});

afterEach(() => {
  tempDb.cleanup();
});

describe("documentDraftRepo", () => {
  it("保存并读取 pending draft,PM JSON 使用稳定规范化格式,group 字段往返", async () => {
    const base = doc([paragraph("block-a", "旧正文")]);
    const draft = doc([paragraph("block-a", "新正文")]);

    await documentDraftRepo.savePending({
      docId: "doc-1",
      threadId: "thread-1",
      baseVersion: 3,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
      reviewBatchId: "batch-1",
      groupMode: "atomic",
    }, undefined, "2026-01-01T00:00:00.000Z");

    const loaded = await documentDraftRepo.load("doc-1");
    expect(loaded).toMatchObject({
      docId: "doc-1",
      threadId: "thread-1",
      baseVersion: 3,
      baseHash: getPmContentHash(base),
      status: "pending_review",
      reviewBatchId: "batch-1",
      groupMode: "atomic",
    });
    expect(getStablePmJson(loaded!.draftPmDoc)).toBe(getStablePmJson(normalizePmDoc(draft)));

    const raw = await getDocumentsClient().execute({
      sql: "SELECT draft_pm FROM document_drafts WHERE doc_id = ?",
      args: ["doc-1"],
    });
    expect(raw.rows[0]?.draft_pm).toBe(getStablePmJson(normalizePmDoc(draft)));
  });

  it("保存 draft_candidate 首稿并可由 savePending 升级为 pending_review", async () => {
    const draft = doc([paragraph("block-first", "首稿正文")]);
    const baseHash = getPmContentHash(doc([]));

    await documentDraftRepo.saveCandidate({
      docId: "doc-candidate",
      threadId: "thread-candidate",
      baseVersion: 0,
      baseHash,
      draftPmDoc: draft,
      sourceStreamId: "stream-candidate",
      sourceToolCallId: "tool-candidate",
    }, undefined, "2026-01-01T00:00:00.000Z");

    const candidate = await documentDraftRepo.load("doc-candidate");
    expect(candidate).toMatchObject({
      docId: "doc-candidate",
      threadId: "thread-candidate",
      baseVersion: 0,
      baseHash,
      status: "draft_candidate",
      sourceStreamId: "stream-candidate",
      sourceToolCallId: "tool-candidate",
    });
    expect(getStablePmJson(candidate!.draftPmDoc)).toBe(getStablePmJson(normalizePmDoc(draft)));

    await documentDraftRepo.savePending({
      docId: "doc-candidate",
      threadId: "thread-candidate",
      baseVersion: 1,
      baseHash: getPmContentHash(draft),
      draftPmDoc: doc([paragraph("block-second", "待审正文")]),
      reviewBatchId: "batch-upgraded",
      groupMode: "independent",
    }, undefined, "2026-01-01T00:00:01.000Z");

    const upgraded = await documentDraftRepo.load("doc-candidate");
    expect(upgraded).toMatchObject({
      status: "pending_review",
      baseVersion: 1,
      reviewBatchId: "batch-upgraded",
      groupMode: "independent",
      sourceStreamId: null,
      sourceToolCallId: null,
    });
  });

  it("upsert 会推进 updatedAt", async () => {
    const base = doc([paragraph("block-a", "旧正文")]);

    await documentDraftRepo.savePending({
      docId: "doc-upsert",
      threadId: "thread-upsert",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: doc([paragraph("block-a", "第一版")]),
    }, undefined, "2026-01-01T00:00:00.000Z");
    await documentDraftRepo.savePending({
      docId: "doc-upsert",
      threadId: "thread-upsert",
      baseVersion: 2,
      baseHash: getPmContentHash(base),
      draftPmDoc: doc([paragraph("block-a", "第二版")]),
    }, undefined, "2026-01-01T00:00:01.000Z");

    const loaded = await documentDraftRepo.load("doc-upsert");
    expect(loaded?.baseVersion).toBe(2);
    expect(loaded?.updatedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("clear 删除草稿 row", async () => {
    const base = doc([paragraph("block-a", "旧正文")]);
    await documentDraftRepo.savePending({
      docId: "doc-clear",
      threadId: "thread-clear",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: doc([paragraph("block-a", "新正文")]),
    });

    await documentDraftRepo.clear("doc-clear");

    await expect(documentDraftRepo.load("doc-clear")).resolves.toBeNull();
  });

  it("坏 draft_pm 会抛错,不会回退成正文覆盖路径", async () => {
    const base = doc([paragraph("block-a", "旧正文")]);
    await documentDraftRepo.savePending({
      docId: "doc-bad-json",
      threadId: "thread-bad-json",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: doc([paragraph("block-a", "新正文")]),
    });
    await getDocumentsClient().execute({
      sql: "UPDATE document_drafts SET draft_pm = ? WHERE doc_id = ?",
      args: ["{bad-json", "doc-bad-json"],
    });

    await expect(documentDraftRepo.load("doc-bad-json")).rejects.toThrow();
  });

  it("markConflict 写入 conflict 状态和 JSON", async () => {
    const base = doc([paragraph("block-a", "旧正文")]);
    await documentDraftRepo.savePending({
      docId: "doc-conflict",
      threadId: "thread-conflict",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: doc([paragraph("block-a", "新正文")]),
    });

    await documentDraftRepo.markConflict({
      docId: "doc-conflict",
      conflict: { kind: "base_hash_mismatch" },
    });

    const loaded = await documentDraftRepo.load("doc-conflict");
    expect(loaded?.status).toBe("conflict");
    expect(loaded?.conflict).toEqual({ kind: "base_hash_mismatch" });
  });

  it("相同空段落落盘后再读取会逐字保留 blockId", async () => {
    const draft = materializeDraftBlockIds(
      doc([
        paragraph("block-empty-a", ""),
        paragraph("block-empty-b", ""),
      ]),
      { namespace: "draft.test" },
    );
    const idsBefore = draft.content.map((block) => block.attrs.blockId);

    await documentDraftRepo.savePending({
      docId: "doc-id-persist",
      threadId: "thread-id-persist",
      baseVersion: 1,
      baseHash: getPmContentHash(doc([paragraph("block-base", "正文")])),
      draftPmDoc: draft,
    });

    const loaded = await documentDraftRepo.load("doc-id-persist");
    expect(loaded?.draftPmDoc.content.map((block) => block.attrs.blockId)).toEqual(idsBefore);
  });
});

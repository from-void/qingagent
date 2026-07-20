import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentWriteBlockedError,
  documentRepo,
} from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const { memory, logger } = vi.hoisted(() => ({
  memory: {
    deleteThread: vi.fn(async () => undefined),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

describe("session document deletion fence", () => {
  let db: TempDocumentsDb;

  beforeEach(async () => {
    db = prepareTempDocumentsDb("qa-session-document-fence-");
    vi.clearAllMocks();
    const { __resetSessionPersistenceForTest } = await import(
      "../session/threadPersistence.js"
    );
    __resetSessionPersistenceForTest();
  });

  afterEach(async () => {
    const { __resetSessionPersistenceForTest } = await import(
      "../session/threadPersistence.js"
    );
    __resetSessionPersistenceForTest();
    db.cleanup();
  });

  it("删除完成后拒绝迟到 upsert，documents 行不会重建", async () => {
    const sessionId = "late-write-session";
    const docId = "late-write-doc";
    const input = documentInput(docId, { threadId: sessionId });
    const {
      deleteSessionThread,
      markSessionDeleted,
      resolveSessionDocumentId,
      unmarkSessionDeleted,
    } = await import("../session/threadPersistence.js");
    const { commitDocumentOp } = await import("../doc-engine/commitDocumentOp.js");
    await documentRepo.save(input);

    await expect(resolveSessionDocumentId(sessionId)).resolves.toBe(docId);
    markSessionDeleted(sessionId, docId);
    await deleteSessionThread(sessionId);

    await expect(documentRepo.save(input)).rejects.toBeInstanceOf(
      DocumentWriteBlockedError,
    );
    await expect(commitDocumentOp({
      docId,
      threadId: sessionId,
      resourceId: "qingagent-user",
      expectedDocumentSnapshot: 0,
      opId: "late-commit",
      opKind: "replace_doc",
      actorType: "agent",
      createIfMissing: {
        title: "迟到提交",
        docState: "editing",
        lastSyncedVersion: 0,
      },
      apply: () => ({ nextDoc: input.pmDoc }),
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentRepo.load(docId)).resolves.toBeNull();
    expect(memory.deleteThread).toHaveBeenCalledWith(sessionId);

    unmarkSessionDeleted(sessionId);
    await expect(documentRepo.save(input)).resolves.toBeUndefined();
    await expect(documentRepo.load(docId)).resolves.toBeNull();
  });
});

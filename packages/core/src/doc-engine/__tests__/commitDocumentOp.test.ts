import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash, type PmDoc } from "@qingagent/pm-schema";
import {
  beginSessionDeletion,
  createDerivativeDoc,
  DocumentRecoveryRequiredError,
  DocumentWriteBlockedError,
  findOpByIdempotencyKey,
  listDerivativesByThread,
  stampGenerated,
} from "@qingagent/db";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
} from "@qingagent/db";
import { documentRepo } from "@qingagent/db";
import {
  getVersionSnapshot,
  insertVersion,
  listVersions,
} from "@qingagent/db";
import {
  documentInput,
  pmDocFromText,
  prepareTempDocumentsDb,
  section,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import {
  advanceLastContentEditedAt,
  commitDocumentOp,
  type CommitDocumentOpInput,
} from "../commitDocumentOp.js";
import { __resetDocCommitQueueForTest } from "../docCommitQueue.js";

let tempDb: TempDocumentsDb;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-commit-document-op-");
  __resetDocCommitQueueForTest();
});

afterEach(() => {
  __resetDocCommitQueueForTest();
  tempDb.cleanup();
});

function commitInput(
  overrides: Partial<CommitDocumentOpInput> = {},
): CommitDocumentOpInput {
  return {
    docId: "doc-commit",
    threadId: "thread-doc-commit",
    resourceId: "qingagent-user",
    expectedDocumentSnapshot: 1,
    opKind: "replace_doc",
    actorType: "user",
    clientMutationId: "client-commit",
    apply: () => ({ nextDoc: pmDocFromText("after commit") }),
    ...overrides,
  } as CommitDocumentOpInput;
}

async function seedDocument(
  id = "doc-commit",
  text = "before commit",
  docVersion = 1,
): Promise<void> {
  await documentRepo.save(
    documentInput(id, {
      threadId: `thread-${id}`,
      docVersion,
      legacySections: [section(text)],
      pmDoc: pmDocFromText(text),
    }),
  );
}

async function seedDocumentVersion(
  docId: string,
  docVersion: number,
  text: string,
  parentVersion: number | null,
  createdAt: string,
  actorType: "user" | "agent" = "agent",
): Promise<void> {
  const snapshotPm = pmDocFromText(text);
  await insertVersion({
    versionId: `version-${docId}-${docVersion}`,
    docId,
    docVersion,
    contentHash: getPmContentHash(snapshotPm),
    schemaVersion: snapshotPm.attrs.schemaVersion,
    actorType,
    summary: `v${docVersion}`,
    snapshotPm,
    parentVersion,
    createdAt,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectCommittedVersion(
  result: Awaited<ReturnType<typeof commitDocumentOp>>,
  docVersion: number,
): Promise<Extract<Awaited<ReturnType<typeof commitDocumentOp>>, { status: "committed" }>> {
  expect(result).toMatchObject({ status: "committed", docVersion });
  if (result.status !== "committed") {
    throw new Error(`expected committed result, got ${result.status}`);
  }
  return result;
}

describe("commitDocumentOp", () => {
  it("0025 检出的正文覆盖文档在主提交链 fail-closed，并明确要求从 pre-0023 备份恢复", async () => {
    await seedDocument();
    await getDocumentsClient().execute({
      sql: `INSERT INTO document_write_blocks (
        doc_id, reason, source_doc_id, source_thread_id, version_id
      ) VALUES (
        'doc-commit', 'quarantine_0002_foreign_snapshot',
        'foreign-doc', 'thread-doc-commit', 'foreign-version'
      )`,
    });

    await expect(commitDocumentOp(commitInput()))
      .rejects.toBeInstanceOf(DocumentRecoveryRequiredError);
    await expect(commitDocumentOp(commitInput()))
      .rejects.toThrow("从运行 0023 前的数据库备份恢复并核验");
    await expect(documentRepo.load("doc-commit")).resolves.toMatchObject({
      docVersion: 1,
      legacySections: [section("before commit")],
    });
  });

  it("serializes raw withTransaction calls without relying on the commit queue", async () => {
    await seedDocument("doc-raw-collision", "base", 1);

    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = withTransaction(async (txnClient) => {
      await txnClient.execute({
        sql: "UPDATE documents SET title = ? WHERE id = ?",
        args: ["raw-first", "doc-raw-collision"],
      });
      markFirstStarted();
      await firstCanFinish;
      return commitTransaction(null);
    });

    await firstStarted;
    const second = withTransaction(async (txnClient) => {
      await txnClient.execute({
        sql: "UPDATE documents SET title = ? WHERE id = ?",
        args: ["raw-second", "doc-raw-collision"],
      });
      return commitTransaction(null);
    });
    releaseFirst();
    await Promise.all([first, second]);

    const loaded = await documentRepo.load("doc-raw-collision");
    expect(loaded?.title).toBe("raw-second");
  });

  it("serializes concurrent commits for the same docId so no write is dropped", async () => {
    await seedDocument("doc-serial-same", "base", 1);

    const [first, second] = await Promise.all([
      commitDocumentOp(
        commitInput({
          docId: "doc-serial-same",
          threadId: "thread-doc-serial-same",
          expectedDocumentSnapshot: 1,
          clientMutationId: "client-serial-same-1",
          apply: () => ({ nextDoc: pmDocFromText("same first") }),
        }),
        {
          hooks: {
            afterDocumentUpdate: () => delay(25),
          },
        },
      ),
      commitDocumentOp(
        commitInput({
          docId: "doc-serial-same",
          threadId: "thread-doc-serial-same",
          expectedDocumentSnapshot: 2,
          clientMutationId: "client-serial-same-2",
          apply: () => ({ nextDoc: pmDocFromText("same second") }),
        }),
      ),
    ]);

    await expectCommittedVersion(first, 2);
    const committedSecond = await expectCommittedVersion(second, 3);
    expect(committedSecond.doc).toEqual(pmDocFromText("same second"));
    const loaded = await documentRepo.load("doc-serial-same");
    expect(loaded?.docVersion).toBe(3);
    expect(loaded?.pmDoc).toEqual(pmDocFromText("same second"));
    const versions = await listVersions("doc-serial-same");
    expect(versions.map((version) => version.docVersion)).toEqual([3, 2]);
  });

  it("serializes concurrent commits across docIds because the DB connection is shared", async () => {
    await seedDocument("doc-serial-a", "a base", 1);
    await seedDocument("doc-serial-b", "b base", 1);

    const [first, second] = await Promise.all([
      commitDocumentOp(
        commitInput({
          docId: "doc-serial-a",
          threadId: "thread-doc-serial-a",
          expectedDocumentSnapshot: 1,
          clientMutationId: "client-serial-a",
          apply: () => ({ nextDoc: pmDocFromText("a next") }),
        }),
        {
          hooks: {
            afterDocumentUpdate: () => delay(25),
          },
        },
      ),
      commitDocumentOp(
        commitInput({
          docId: "doc-serial-b",
          threadId: "thread-doc-serial-b",
          expectedDocumentSnapshot: 1,
          clientMutationId: "client-serial-b",
          apply: () => ({ nextDoc: pmDocFromText("b next") }),
        }),
      ),
    ]);

    await expectCommittedVersion(first, 2);
    await expectCommittedVersion(second, 2);
    await expect(documentRepo.load("doc-serial-a")).resolves.toMatchObject({
      docVersion: 2,
      pmDoc: pmDocFromText("a next"),
    });
    await expect(documentRepo.load("doc-serial-b")).resolves.toMatchObject({
      docVersion: 2,
      pmDoc: pmDocFromText("b next"),
    });
    await expect(listVersions("doc-serial-a")).resolves.toHaveLength(1);
    await expect(listVersions("doc-serial-b")).resolves.toHaveLength(1);
  });

  it("同一 clientMutationId 可在不同文档各自独立提交", async () => {
    await seedDocument("doc-mutation-a", "a base", 1);
    await seedDocument("doc-mutation-b", "b base", 1);

    const [first, second] = await Promise.all([
      commitDocumentOp(commitInput({
        docId: "doc-mutation-a",
        threadId: "thread-doc-mutation-a",
        clientMutationId: "shared-client-mutation",
        apply: () => ({ nextDoc: pmDocFromText("a committed") }),
      })),
      commitDocumentOp(commitInput({
        docId: "doc-mutation-b",
        threadId: "thread-doc-mutation-b",
        clientMutationId: "shared-client-mutation",
        apply: () => ({ nextDoc: pmDocFromText("b committed") }),
      })),
    ]);

    await expectCommittedVersion(first, 2);
    await expectCommittedVersion(second, 2);
    await expect(documentRepo.load("doc-mutation-a")).resolves.toMatchObject({
      pmDoc: pmDocFromText("a committed"),
    });
    await expect(documentRepo.load("doc-mutation-b")).resolves.toMatchObject({
      pmDoc: pmDocFromText("b committed"),
    });
    const firstOp = await findOpByIdempotencyKey({
      docId: "doc-mutation-a",
      clientMutationId: "shared-client-mutation",
    });
    const secondOp = await findOpByIdempotencyKey({
      docId: "doc-mutation-b",
      clientMutationId: "shared-client-mutation",
    });
    expect(firstOp?.opId).not.toBe(secondOp?.opId);
  });

  it("keeps the commit queue usable after a critical-section error", async () => {
    await seedDocument("doc-queue-after-error", "base", 1);

    await expect(
      commitDocumentOp(
        commitInput({
          docId: "doc-queue-after-error",
          threadId: "thread-doc-queue-after-error",
          expectedDocumentSnapshot: 1,
          clientMutationId: "client-queue-fail",
          apply: () => ({ nextDoc: pmDocFromText("should rollback") }),
        }),
        {
          hooks: {
            afterDocumentUpdate: () => {
              throw new Error("forced commit failure");
            },
          },
        },
      ),
    ).rejects.toThrow("forced commit failure");

    const retry = await commitDocumentOp(
      commitInput({
        docId: "doc-queue-after-error",
        threadId: "thread-doc-queue-after-error",
        expectedDocumentSnapshot: 1,
        clientMutationId: "client-queue-retry",
        apply: () => ({ nextDoc: pmDocFromText("after failure") }),
      }),
    );

    await expectCommittedVersion(retry, 2);
    const loaded = await documentRepo.load("doc-queue-after-error");
    expect(loaded?.pmDoc).toEqual(pmDocFromText("after failure"));
  });

  it("commits documents, version snapshots, and op rows in one transaction", async () => {
    await seedDocument();
    const fakeSession = {
      doc: pmDocFromText("before commit"),
      docVersion: 1,
    };
    const frames: string[] = [];

    const result = await commitDocumentOp(commitInput(), {
      now: () => "2026-01-02T00:00:00.000Z",
      hooks: {
        afterDocumentUpdate: () => {
          expect(fakeSession.docVersion).toBe(1);
          expect(fakeSession.doc).toEqual(pmDocFromText("before commit"));
          expect(frames).toEqual([]);
        },
      },
    });

    expect(result).toMatchObject({
      status: "committed",
      docVersion: 2,
      doc: pmDocFromText("after commit"),
      createdNewVersion: true,
      committedAt: "2026-01-02T00:00:00.000Z",
    });
    if (result.status === "committed") {
      fakeSession.doc = result.doc;
      fakeSession.docVersion = result.docVersion;
      frames.push("documentSnapshotWritten");
    }

    const loaded = await documentRepo.load("doc-commit");
    expect(loaded?.docVersion).toBe(2);
    expect(loaded?.pmDoc).toEqual(pmDocFromText("after commit"));
    expect(loaded?.legacySections).toEqual([section("after commit")]);

    const versions = await listVersions("doc-commit");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      docId: "doc-commit",
      docVersion: 2,
      actorType: "user",
      parentVersion: 1,
      summary: null,
    });
    expect(versions[0]?.snapshotPm).toEqual(pmDocFromText("after commit"));

    const op = await findOpByIdempotencyKey({
      docId: "doc-commit",
      clientMutationId: "client-commit",
    });
    expect(op).toMatchObject({
      opId: expect.any(String),
      docId: "doc-commit",
      opKind: "replace_doc",
      clientMutationId: "client-commit",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(fakeSession.docVersion).toBe(2);
    expect(frames).toEqual(["documentSnapshotWritten"]);
  });

  it("等值用户保存直接确认 canonical 版本，不涨版本或误标衍生稿 stale；后续真实改动仍正常提交", async () => {
    const docId = "doc-user-noop";
    const threadId = "thread-doc-user-noop";
    const originalDoc = pmDocFromText("未修改正文");
    await seedDocument(docId, "未修改正文", 4);
    await seedDocumentVersion(
      docId,
      4,
      "未修改正文",
      3,
      "2026-07-23T08:00:00.000Z",
      "user",
    );
    const derivative = await createDerivativeDoc({
      threadId,
      sourceDocId: docId,
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "",
    });
    await stampGenerated(derivative.docId, 4);

    const noOp = await commitDocumentOp(
      commitInput({
        docId,
        threadId,
        expectedDocumentSnapshot: 4,
        baseContentHash: getPmContentHash(originalDoc),
        clientMutationId: "client-noop",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: originalDoc }),
      }),
      { now: () => "2026-07-23T08:00:30.000Z" },
    );

    expect(noOp).toMatchObject({
      status: "committed",
      docVersion: 4,
      contentHash: getPmContentHash(originalDoc),
      doc: originalDoc,
      versionId: `version-${docId}-4`,
      createdNewVersion: false,
      committedAt: "2026-07-23T08:00:00.000Z",
    });
    await expect(documentRepo.load(docId)).resolves.toMatchObject({
      docVersion: 4,
      pmDoc: originalDoc,
    });
    expect((await listVersions(docId)).map((version) => version.docVersion)).toEqual([4]);
    await expect(findOpByIdempotencyKey({
      docId,
      clientMutationId: "client-noop",
    })).resolves.toBeNull();
    await expect(listDerivativesByThread(threadId)).resolves.toEqual([
      expect.objectContaining({
        docId: derivative.docId,
        sourceVersion: 4,
        currentSourceVersion: 4,
        stale: false,
      }),
    ]);

    const changedDoc = pmDocFromText("确有修改正文");
    const changed = await commitDocumentOp(
      commitInput({
        docId,
        threadId,
        expectedDocumentSnapshot: 4,
        baseContentHash: getPmContentHash(originalDoc),
        clientMutationId: "client-real-change",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: changedDoc }),
      }),
      { now: () => "2026-07-23T08:00:40.000Z" },
    );

    expect(changed).toMatchObject({
      status: "committed",
      docVersion: 5,
      contentHash: getPmContentHash(changedDoc),
      doc: changedDoc,
      createdNewVersion: true,
    });
    await expect(documentRepo.load(docId)).resolves.toMatchObject({
      docVersion: 5,
      pmDoc: changedDoc,
    });
    expect((await listVersions(docId)).map((version) => version.docVersion)).toEqual([5]);
    await expect(listDerivativesByThread(threadId)).resolves.toEqual([
      expect.objectContaining({
        docId: derivative.docId,
        sourceVersion: 4,
        currentSourceVersion: 5,
        stale: true,
      }),
    ]);

    const staleSameContent = await commitDocumentOp(commitInput({
      docId,
      threadId,
      expectedDocumentSnapshot: 4,
      baseContentHash: getPmContentHash(originalDoc),
      clientMutationId: "client-stale-same-content",
      apply: () => ({ nextDoc: changedDoc }),
    }));
    expect(staleSameContent).toEqual({
      status: "conflict",
      currentVersion: 5,
      currentHash: getPmContentHash(changedDoc),
    });
    await expect(documentRepo.load(docId)).resolves.toMatchObject({
      docVersion: 5,
      pmDoc: changedDoc,
    });
  });

  it("单标签快速连续手打在 coalesce 窗口内仍合并，并持久化撤销/重做", async () => {
    await seedDocument("doc-coalesce", "before", 1);

    const first = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce",
        threadId: "thread-doc-coalesce",
        clientMutationId: "client-coalesce-1",
        summary: "第一笔用户保存",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("A") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    expect(first).toMatchObject({ status: "committed", docVersion: 2 });
    if (first.status !== "committed") return;

    const [openedWindow] = await listVersions("doc-coalesce");
    expect(openedWindow).toMatchObject({
      versionId: first.versionId,
      docVersion: 2,
      parentVersion: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      summary: "第一笔用户保存",
    });

    const second = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce",
        threadId: "thread-doc-coalesce",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-coalesce-2",
        summary: "第二笔用户保存",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("B") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    expect(second).toMatchObject({
      status: "committed",
      docVersion: 3,
      versionId: first.versionId,
      doc: pmDocFromText("B"),
      createdNewVersion: true,
      committedAt: "2026-01-02T00:00:30.000Z",
    });

    const undo = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce",
        threadId: "thread-doc-coalesce",
        expectedDocumentSnapshot: 3,
        clientMutationId: "client-coalesce-undo",
        summary: "撤销回 A",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("A") }),
      }),
      { now: () => "2026-01-02T00:00:40.000Z" },
    );
    expect(undo).toMatchObject({
      status: "committed",
      docVersion: 4,
      doc: pmDocFromText("A"),
      createdNewVersion: true,
    });
    await expect(documentRepo.load("doc-coalesce")).resolves.toMatchObject({
      docVersion: 4,
      pmDoc: pmDocFromText("A"),
    });
    const versionsAfterUndo = await listVersions("doc-coalesce");
    expect(versionsAfterUndo).toHaveLength(1);
    expect(versionsAfterUndo[0]).toMatchObject({
      versionId: first.versionId,
      docVersion: 4,
      contentHash: getPmContentHash(pmDocFromText("A")),
      parentVersion: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      summary: "第一笔用户保存",
    });
    expect(versionsAfterUndo[0]?.snapshotPm).toEqual(pmDocFromText("A"));
    const rawOps = await getDocumentsClient().execute({
      sql: `SELECT op_id, client_mutation_id, from_version, to_version
        FROM document_ops WHERE doc_id = ? ORDER BY to_version ASC`,
      args: ["doc-coalesce"],
    });
    expect(rawOps.rows.map((row) => [row.client_mutation_id, row.from_version, row.to_version])).toEqual([
      ["client-coalesce-1", 1, 2],
      ["client-coalesce-2", 2, 3],
      ["client-coalesce-undo", 3, 4],
    ]);
    expect(new Set(rawOps.rows.map((row) => String(row.op_id))).size).toBe(3);

    const redo = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce",
        threadId: "thread-doc-coalesce",
        expectedDocumentSnapshot: 4,
        clientMutationId: "client-coalesce-redo",
        summary: "重做回 B",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("B") }),
      }),
      { now: () => "2026-01-02T00:00:50.000Z" },
    );
    expect(redo).toMatchObject({
      status: "committed",
      docVersion: 5,
      doc: pmDocFromText("B"),
      createdNewVersion: true,
    });
    await expect(documentRepo.load("doc-coalesce")).resolves.toMatchObject({
      docVersion: 5,
      pmDoc: pmDocFromText("B"),
    });

    const emptyDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [],
    };
    await documentRepo.save(documentInput("doc-coalesce-empty", {
      threadId: "thread-doc-coalesce-empty",
      docVersion: 1,
      legacySections: [],
      pmDoc: emptyDoc,
    }));
    await commitDocumentOp(commitInput({
      docId: "doc-coalesce-empty",
      threadId: "thread-doc-coalesce-empty",
      clientMutationId: "client-empty-type",
      coalesce: { windowMs: 60_000 },
      apply: () => ({ nextDoc: pmDocFromText("临时输入") }),
    }), { now: () => "2026-01-02T00:00:00.000Z" });
    const undoToEmpty = await commitDocumentOp(commitInput({
      docId: "doc-coalesce-empty",
      threadId: "thread-doc-coalesce-empty",
      expectedDocumentSnapshot: 2,
      clientMutationId: "client-empty-undo",
      coalesce: { windowMs: 60_000 },
      apply: () => ({ nextDoc: emptyDoc }),
    }), { now: () => "2026-01-02T00:00:10.000Z" });
    expect(undoToEmpty).toMatchObject({
      status: "committed",
      docVersion: 3,
      doc: emptyDoc,
      createdNewVersion: true,
    });
    await expect(documentRepo.load("doc-coalesce-empty")).resolves.toMatchObject({
      docVersion: 3,
      pmDoc: emptyDoc,
    });
  });

  it("coalesce 窗口内两份同基线并发整篇写入时，后写冲突且不覆盖先写", async () => {
    await seedDocument("doc-coalesce-concurrent", "共同基线", 1);

    const first = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-concurrent",
        threadId: "thread-doc-coalesce-concurrent",
        clientMutationId: "tab-1-write",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("标签一独有内容") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    const second = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-concurrent",
        threadId: "thread-doc-coalesce-concurrent",
        expectedDocumentSnapshot: 1,
        clientMutationId: "tab-2-write",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("标签二旧基线整篇覆盖") }),
      }),
      { now: () => "2026-01-02T00:00:10.000Z" },
    );

    expect(first).toMatchObject({ status: "committed", docVersion: 2 });
    expect(second).toMatchObject({ status: "conflict", currentVersion: 2 });
    await expect(documentRepo.load("doc-coalesce-concurrent")).resolves.toMatchObject({
      docVersion: 2,
      pmDoc: pmDocFromText("标签一独有内容"),
    });
    await expect(listVersions("doc-coalesce-concurrent")).resolves.toMatchObject([
      { docVersion: 2, snapshotPm: pmDocFromText("标签一独有内容") },
    ]);
    await expect(findOpByIdempotencyKey({
      docId: "doc-coalesce-concurrent",
      clientMutationId: "tab-2-write",
    })).resolves.toBeNull();
  });

  it("inserts a new user version when the coalesce window has expired", async () => {
    await seedDocument("doc-coalesce-expired", "before", 1);

    const first = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-expired",
        threadId: "thread-doc-coalesce-expired",
        clientMutationId: "client-expired-1",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    expect(first).toMatchObject({ status: "committed", docVersion: 2 });

    const second = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-expired",
        threadId: "thread-doc-coalesce-expired",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-expired-2",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("second edit") }),
      }),
      { now: () => "2026-01-02T00:01:00.000Z" },
    );

    expect(second).toMatchObject({ status: "committed", docVersion: 3 });
    const versions = await listVersions("doc-coalesce-expired");
    expect(versions.map((version) => version.docVersion)).toEqual([3, 2]);
    expect(versions[0]).toMatchObject({ parentVersion: 2 });
  });

  it("系统时钟回拨时开启新版本窗口，不把后续编辑错误折叠进未来版本", async () => {
    await seedDocument("doc-coalesce-clock-rollback", "before", 1);

    const first = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-clock-rollback",
        threadId: "thread-doc-coalesce-clock-rollback",
        clientMutationId: "client-clock-rollback-1",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
      { now: () => "2026-01-02T00:01:00.000Z" },
    );
    expect(first).toMatchObject({ status: "committed", docVersion: 2 });

    const second = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-clock-rollback",
        threadId: "thread-doc-coalesce-clock-rollback",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-clock-rollback-2",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("second edit after rollback") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    expect(second).toMatchObject({ status: "committed", docVersion: 3 });
    const versions = await listVersions("doc-coalesce-clock-rollback");
    expect(versions.map((version) => version.docVersion)).toEqual([3, 2]);
    expect(versions[0]).toMatchObject({
      parentVersion: 2,
      createdAt: "2026-01-02T00:00:30.000Z",
    });
    expect(versions[1]).toMatchObject({
      docVersion: 2,
      createdAt: "2026-01-02T00:01:00.000Z",
    });
  });

  it("starts a new user coalesce window after an agent version", async () => {
    await seedDocument("doc-coalesce-agent", "before", 1);

    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-agent",
        threadId: "thread-doc-coalesce-agent",
        clientMutationId: "client-agent-user-1",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("user edit") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-agent",
        threadId: "thread-doc-coalesce-agent",
        expectedDocumentSnapshot: 2,
        actorType: "agent",
        opId: "op-agent-separator",
        clientMutationId: undefined,
        summary: "Agent 写入",
        apply: () => ({ nextDoc: pmDocFromText("agent edit") }),
      }),
      { now: () => "2026-01-02T00:00:10.000Z" },
    );
    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-agent",
        threadId: "thread-doc-coalesce-agent",
        expectedDocumentSnapshot: 3,
        clientMutationId: "client-agent-user-2",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("user edit after agent") }),
      }),
      { now: () => "2026-01-02T00:00:20.000Z" },
    );

    const versions = await listVersions("doc-coalesce-agent");
    expect(versions.map((version) => [version.docVersion, version.actorType])).toEqual([
      [4, "user"],
      [3, "agent"],
      [2, "user"],
    ]);
    expect(versions[0]).toMatchObject({ parentVersion: 3 });
  });

  it("keeps existing behavior when coalesce is not provided", async () => {
    await seedDocument("doc-no-coalesce", "before", 1);

    await commitDocumentOp(
      commitInput({
        docId: "doc-no-coalesce",
        threadId: "thread-doc-no-coalesce",
        clientMutationId: "client-no-coalesce-1",
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    await commitDocumentOp(
      commitInput({
        docId: "doc-no-coalesce",
        threadId: "thread-doc-no-coalesce",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-no-coalesce-2",
        apply: () => ({ nextDoc: pmDocFromText("second edit") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    const versions = await listVersions("doc-no-coalesce");
    expect(versions.map((version) => version.docVersion)).toEqual([3, 2]);
  });

  it("returns committed for an idempotent replay whose version row was coalesced away", async () => {
    await seedDocument("doc-coalesce-replay", "before", 1);

    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-replay",
        threadId: "thread-doc-coalesce-replay",
        clientMutationId: "client-replay-1",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-replay",
        threadId: "thread-doc-coalesce-replay",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-replay-2",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("second edit") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    const replay = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-replay",
        threadId: "thread-doc-coalesce-replay",
        clientMutationId: "client-replay-1",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
    );

    expect(replay).toMatchObject({
      status: "committed",
      docVersion: 3,
      doc: pmDocFromText("second edit"),
      createdNewVersion: false,
      committedAt: "2026-01-02T00:00:00.000Z",
    });
    if (replay.status === "committed") {
      const staleState = { lastContentEditedAt: "2025-12-31T00:00:00.000Z" };
      expect(advanceLastContentEditedAt(staleState, replay, 1)).toBe(false);
      expect(staleState.lastContentEditedAt).toBe("2025-12-31T00:00:00.000Z");
    }
    await expect(listVersions("doc-coalesce-replay")).resolves.toHaveLength(1);
  });

  it("does not coalesce when windowMs is zero", async () => {
    await seedDocument("doc-coalesce-zero", "before", 1);

    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-zero",
        threadId: "thread-doc-coalesce-zero",
        clientMutationId: "client-zero-1",
        coalesce: { windowMs: 0 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );
    await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce-zero",
        threadId: "thread-doc-coalesce-zero",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-zero-2",
        coalesce: { windowMs: 0 },
        apply: () => ({ nextDoc: pmDocFromText("second edit") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    const versions = await listVersions("doc-coalesce-zero");
    expect(versions.map((version) => version.docVersion)).toEqual([3, 2]);
  });

  it("returns conflict for stale doc_version", async () => {
    await seedDocument("doc-conflict", "current", 3);
    const current = await documentRepo.load("doc-conflict");

    const stale = await commitDocumentOp(
      commitInput({
        docId: "doc-conflict",
        threadId: "thread-doc-conflict",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-stale",
      }),
    );
    expect(stale).toEqual({
      status: "conflict",
      currentVersion: 3,
      currentHash: current?.contentHash,
    });
  });

  it("同版本号但 baseContentHash 对应不同正文时拒绝 conflict", async () => {
    await seedDocument("doc-same-version-hash-conflict", "current", 3);
    const current = await documentRepo.load("doc-same-version-hash-conflict");

    const hashConflict = await commitDocumentOp(
      commitInput({
        docId: "doc-same-version-hash-conflict",
        threadId: "thread-doc-same-version-hash-conflict",
        expectedDocumentSnapshot: 3,
        baseContentHash: getPmContentHash(pmDocFromText("different baseline")),
        clientMutationId: "client-hash",
      }),
    );
    expect(hashConflict).toEqual({
      status: "conflict",
      currentVersion: 3,
      currentHash: current?.contentHash,
    });
  });

  it("同版本号且 baseContentHash 匹配时正常提交", async () => {
    await seedDocument("doc-matching-base-hash", "current", 3);
    const current = await documentRepo.load("doc-matching-base-hash");
    if (!current) throw new Error("missing seeded document");
    const nextDoc = pmDocFromText("saved normally");

    const result = await commitDocumentOp(
      commitInput({
        docId: "doc-matching-base-hash",
        threadId: "thread-doc-matching-base-hash",
        expectedDocumentSnapshot: 3,
        baseContentHash: current.contentHash,
        clientMutationId: "client-matching-hash",
        apply: () => ({ nextDoc }),
      }),
    );

    expect(result).toMatchObject({
      status: "committed",
      docVersion: 4,
      doc: nextDoc,
    });
  });

  it("returns not_found without creating version or op rows", async () => {
    const result = await commitDocumentOp(commitInput({ docId: "missing" }));
    expect(result).toEqual({ status: "not_found" });
    expect(await listVersions("missing")).toEqual([]);
    expect(await findOpByIdempotencyKey({
      docId: "missing",
      clientMutationId: "client-commit",
    })).toBeNull();
  });

  it("creates the first document row through commitDocumentOp when createIfMissing is explicit", async () => {
    const result = await commitDocumentOp(
      commitInput({
        docId: "doc-first-store",
        threadId: "thread-doc-first-store",
        expectedDocumentSnapshot: 0,
        opId: "generation-first-store",
        clientMutationId: undefined,
        createIfMissing: {
          title: "首篇文档",
          docState: "editing",
          lastSyncedVersion: 0,
        },
        apply: () => ({ nextDoc: pmDocFromText("first content") }),
      }),
      { now: () => "2026-01-02T00:00:00.000Z" },
    );

    expect(result).toMatchObject({
      status: "committed",
      docVersion: 1,
      doc: pmDocFromText("first content"),
    });
    const loaded = await documentRepo.load("doc-first-store");
    expect(loaded).toMatchObject({
      id: "doc-first-store",
      threadId: "thread-doc-first-store",
      docVersion: 1,
      title: "首篇文档",
      docState: "editing",
    });
    expect(loaded?.pmDoc).toEqual(pmDocFromText("first content"));
    const versions = await listVersions("doc-first-store");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      docId: "doc-first-store",
      docVersion: 1,
      parentVersion: 0,
    });
    expect(await findOpByIdempotencyKey({
      docId: "doc-first-store",
      opId: "generation-first-store",
    })).toMatchObject({
      docId: "doc-first-store",
      fromVersion: 0,
      toVersion: 1,
    });
  });

  it("持久化墓碑阻止 createIfMissing 绕过 guard 复建 documents", async () => {
    await beginSessionDeletion("thread-first-store-fenced");

    await expect(commitDocumentOp(
      commitInput({
        docId: "doc-first-store-fenced",
        threadId: "thread-first-store-fenced",
        expectedDocumentSnapshot: 0,
        opId: "generation-first-store-fenced",
        clientMutationId: undefined,
        createIfMissing: {
          title: "不应复建",
          docState: "editing",
          lastSyncedVersion: 0,
        },
        apply: () => ({ nextDoc: pmDocFromText("blocked content") }),
      }),
    )).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentRepo.load("doc-first-store-fenced")).resolves.toBeNull();
  });

  it("prioritizes repeated clientMutationId while preserving opId-only replay", async () => {
    await seedDocument();
    const first = await commitDocumentOp(
      commitInput({ opId: "op-explicit" }),
      { now: () => "2026-01-03T04:05:06.000Z" },
    );
    expect(first.status).toBe("committed");

    const byClientMutationId = await commitDocumentOp(
      commitInput({
        opId: "op-ignored-on-retry",
        clientMutationId: "client-commit",
      }),
    );
    expect(byClientMutationId).toMatchObject({
      status: "committed",
      docVersion: 2,
      createdNewVersion: false,
      committedAt: "2026-01-03T04:05:06.000Z",
    });

    const mismatchedMutation = await commitDocumentOp(
      commitInput({
        opId: "op-explicit",
        clientMutationId: "client-other",
      }),
    );
    expect(mismatchedMutation).toMatchObject({
      status: "conflict",
      currentVersion: 2,
    });

    const loaded = await documentRepo.load("doc-commit");
    expect(loaded?.docVersion).toBe(2);
    expect(await listVersions("doc-commit")).toHaveLength(1);

    await seedDocument("doc-op-only", "before", 1);
    const opOnlyInput = commitInput({
      docId: "doc-op-only",
      threadId: "thread-doc-op-only",
      opId: "op-only",
      clientMutationId: undefined,
    });
    const opOnlyFirst = await commitDocumentOp(opOnlyInput);
    const opOnlyReplay = await commitDocumentOp(opOnlyInput);
    expect(opOnlyFirst).toMatchObject({ status: "committed", createdNewVersion: true });
    expect(opOnlyReplay).toMatchObject({
      status: "committed",
      docVersion: 2,
      createdNewVersion: false,
    });
    await expect(listVersions("doc-op-only")).resolves.toHaveLength(1);
  });

  it("derives a stable opId when runtime input has no idempotency key", async () => {
    await seedDocument("doc-derived", "before", 1);
    const noKeyInput = {
      docId: "doc-derived",
      threadId: "thread-doc-derived",
      resourceId: "qingagent-user",
      expectedDocumentSnapshot: 1,
      opKind: "replace_doc",
      actorType: "system",
      apply: () => ({ nextDoc: pmDocFromText("derived") }),
    } as unknown as CommitDocumentOpInput;

    const first = await commitDocumentOp(noKeyInput);
    const second = await commitDocumentOp(noKeyInput);
    expect(first).toMatchObject({ status: "committed", docVersion: 2 });
    expect(first).toMatchObject({ createdNewVersion: true });
    expect(second).toMatchObject({
      status: "committed",
      docVersion: 2,
      createdNewVersion: false,
    });
    const versions = await listVersions("doc-derived");
    expect(versions).toHaveLength(1);
    const rawOps = await getDocumentsClient().execute({
      sql: "SELECT op_id, to_version FROM document_ops WHERE doc_id = ?",
      args: ["doc-derived"],
    });
    expect(rawOps.rows).toHaveLength(1);
    expect(String(rawOps.rows[0]?.op_id)).toMatch(/^op-/);
    expect(rawOps.rows[0]?.to_version).toBe(2);
  });

  it("keeps the type-level idempotency key contract strict", () => {
    // @ts-expect-error CommitDocumentOpInput 至少需要 clientMutationId 或 opId。
    const missingKey: CommitDocumentOpInput = {
      docId: "doc-type",
      threadId: "thread-doc-type",
      resourceId: "qingagent-user",
      expectedDocumentSnapshot: 1,
      opKind: "replace_doc",
      actorType: "user",
      apply: () => ({ nextDoc: pmDocFromText("type") }),
    };
    expect(missingKey.docId).toBe("doc-type");
  });

  it("returns validation_error and leaves DB unchanged for invalid next PM", async () => {
    await seedDocument("doc-invalid", "before", 1);
    const result = await commitDocumentOp(
      commitInput({
        docId: "doc-invalid",
        threadId: "thread-doc-invalid",
        clientMutationId: "client-invalid",
        apply: () => ({
          nextDoc: {
            type: "doc",
            attrs: { schemaVersion: 1 },
            content: [
              {
                type: "image",
                attrs: { blockId: "img-1", src: "blob:local" },
              },
            ],
          } as never,
        }),
      }),
    );

    expect(result.status).toBe("validation_error");
    const loaded = await documentRepo.load("doc-invalid");
    expect(loaded?.docVersion).toBe(1);
    expect(loaded?.pmDoc).toEqual(pmDocFromText("before"));
    expect(await listVersions("doc-invalid")).toEqual([]);
    expect(await findOpByIdempotencyKey({
      docId: "doc-invalid",
      clientMutationId: "client-invalid",
    })).toBeNull();
  });

  it.each([
    ["afterDocumentUpdate" as const],
    ["afterVersionInsert" as const],
    ["afterOpInsert" as const],
  ])("rolls back when %s fails and caller state remains unchanged", async (hookName) => {
    await seedDocument(`doc-${hookName}`, "before", 1);
    const fakeSession = {
      doc: pmDocFromText("before"),
      docVersion: 1,
    };
    const frames: string[] = [];

    await expect(
      commitDocumentOp(
        commitInput({
          docId: `doc-${hookName}`,
          threadId: `thread-doc-${hookName}`,
          clientMutationId: `client-${hookName}`,
        }),
        {
          hooks: {
            [hookName]: () => {
              throw new Error(`fail ${hookName}`);
            },
          },
        },
      ),
    ).rejects.toThrow(`fail ${hookName}`);

    const loaded = await documentRepo.load(`doc-${hookName}`);
    expect(loaded?.docVersion).toBe(1);
    expect(loaded?.pmDoc).toEqual(pmDocFromText("before"));
    expect(await listVersions(`doc-${hookName}`)).toEqual([]);
    expect(await findOpByIdempotencyKey({
      docId: `doc-${hookName}`,
      clientMutationId: `client-${hookName}`,
    })).toBeNull();
    expect(fakeSession).toEqual({
      doc: pmDocFromText("before"),
      docVersion: 1,
    });
    expect(frames).toEqual([]);
  });

  it("事务扩展写失败时回滚正文、版本和操作记录", async () => {
    await seedDocument("doc-transactional-effect", "before", 1);

    await expect(
      commitDocumentOp(
        commitInput({
          docId: "doc-transactional-effect",
          threadId: "thread-doc-transactional-effect",
          clientMutationId: "client-transactional-effect",
        }),
        {
          transactionalEffect: () => {
            throw new Error("fail transactional effect");
          },
        },
      ),
    ).rejects.toThrow("fail transactional effect");

    const loaded = await documentRepo.load("doc-transactional-effect");
    expect(loaded?.docVersion).toBe(1);
    expect(loaded?.pmDoc).toEqual(pmDocFromText("before"));
    expect(await listVersions("doc-transactional-effect")).toEqual([]);
    expect(await findOpByIdempotencyKey({
      docId: "doc-transactional-effect",
      clientMutationId: "client-transactional-effect",
    })).toBeNull();
  });

  it("loads committed idempotent results from the real snapshot table", async () => {
    await seedDocument("doc-snapshot", "before", 1);
    const committed = await commitDocumentOp(
      commitInput({
        docId: "doc-snapshot",
        threadId: "thread-doc-snapshot",
        opId: "op-snapshot",
        clientMutationId: "client-snapshot",
        summary: "snapshot summary",
      }),
    );
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;

    const snapshot = await getVersionSnapshot(committed.versionId);
    expect(snapshot?.summary).toBe("snapshot summary");
    expect(snapshot?.snapshotPm).toEqual(committed.doc);

    const retry = await commitDocumentOp(
      commitInput({
        docId: "doc-snapshot",
        threadId: "thread-doc-snapshot",
        opId: "op-snapshot",
        clientMutationId: "client-snapshot",
      }),
    );
    expect(retry).toMatchObject({
      status: "committed",
      versionId: committed.versionId,
      contentHash: committed.contentHash,
      docVersion: committed.docVersion,
      createdNewVersion: false,
      committedAt: committed.committedAt,
    });
  });

  it("conflicts when document_versions high water is ahead of documents.doc_version", async () => {
    await seedDocument("doc-desync", "visible v2", 2);
    await seedDocumentVersion(
      "doc-desync",
      3,
      "snapshot v3",
      2,
      "2026-01-02T00:00:00.000Z",
    );
    await seedDocumentVersion(
      "doc-desync",
      4,
      "snapshot v4",
      3,
      "2026-01-03T00:00:00.000Z",
    );

    const result = await commitDocumentOp(
      commitInput({
        docId: "doc-desync",
        threadId: "thread-doc-desync",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-desync",
        apply: () => ({ nextDoc: pmDocFromText("user link edit") }),
      }),
      { now: () => "2026-01-04T00:00:00.000Z" },
    );

    expect(result).toMatchObject({
      status: "conflict",
      currentVersion: 4,
    });
    const rawDoc = await getDocumentsClient().execute({
      sql: "SELECT doc_version FROM documents WHERE id = ?",
      args: ["doc-desync"],
    });
    expect(rawDoc.rows[0]?.doc_version).toBe(2);

    const versions = await listVersions("doc-desync");
    expect(versions.map((version) => version.docVersion)).toEqual([4, 3]);
    expect(await findOpByIdempotencyKey({
      docId: "doc-desync",
      clientMutationId: "client-desync",
    })).toBeNull();
  });

  it("does not create a new version from stale document content when high water is ahead", async () => {
    await seedDocument("doc-desync-regression", "visible v2", 2);
    await seedDocumentVersion(
      "doc-desync-regression",
      3,
      "authoritative v3",
      2,
      "2026-01-02T00:00:00.000Z",
    );
    await seedDocumentVersion(
      "doc-desync-regression",
      4,
      "authoritative v4",
      3,
      "2026-01-03T00:00:00.000Z",
    );

    const result = await commitDocumentOp(
      commitInput({
        docId: "doc-desync-regression",
        threadId: "thread-doc-desync-regression",
        expectedDocumentSnapshot: 2,
        clientMutationId: "client-desync-regression",
        apply: () => ({ nextDoc: pmDocFromText("stale overwrite") }),
      }),
      { now: () => "2026-01-04T00:00:00.000Z" },
    );

    expect(result).toMatchObject({
      status: "conflict",
      currentVersion: 4,
    });
    const rawDoc = await getDocumentsClient().execute({
      sql: "SELECT doc_version FROM documents WHERE id = ?",
      args: ["doc-desync-regression"],
    });
    expect(rawDoc.rows[0]?.doc_version).toBe(2);

    const versions = await listVersions("doc-desync-regression");
    expect(versions.map((version) => version.docVersion)).toEqual([4, 3]);
    expect(versions.map((version) => version.snapshotPm)).not.toContainEqual(
      pmDocFromText("stale overwrite"),
    );
    expect(
      await findOpByIdempotencyKey({
        docId: "doc-desync-regression",
        clientMutationId: "client-desync-regression",
      }),
    ).toBeNull();
  });
});

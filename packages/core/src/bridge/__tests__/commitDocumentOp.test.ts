import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash } from "@qingagent/pm-schema";
import {
  findOpByIdempotencyKey,
} from "../../db/documentOpsRepo.js";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
} from "../../db/documentsClient.js";
import { documentRepo } from "../../db/documentRepo.js";
import {
  getVersionSnapshot,
  insertVersion,
  listVersions,
} from "../../db/documentVersionRepo.js";
import {
  documentInput,
  pmDocFromText,
  prepareTempDocumentsDb,
  section,
  type TempDocumentsDb,
} from "../../db/__tests__/dbTestUtils.js";
import {
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
  };
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
): Promise<void> {
  const snapshotPm = pmDocFromText(text);
  await insertVersion({
    versionId: `version-${docId}-${docVersion}`,
    docId,
    docVersion,
    contentHash: getPmContentHash(snapshotPm),
    schemaVersion: snapshotPm.attrs.schemaVersion,
    actorType: "agent",
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

    const op = await findOpByIdempotencyKey({ clientMutationId: "client-commit" });
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

  it("coalesces user replace_doc versions inside the configured window", async () => {
    await seedDocument("doc-coalesce", "before", 1);

    const first = await commitDocumentOp(
      commitInput({
        docId: "doc-coalesce",
        threadId: "thread-doc-coalesce",
        clientMutationId: "client-coalesce-1",
        summary: "第一笔用户保存",
        coalesce: { windowMs: 60_000 },
        apply: () => ({ nextDoc: pmDocFromText("first edit") }),
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
        apply: () => ({ nextDoc: pmDocFromText("second edit") }),
      }),
      { now: () => "2026-01-02T00:00:30.000Z" },
    );

    expect(second).toMatchObject({
      status: "committed",
      docVersion: 3,
      versionId: first.versionId,
      doc: pmDocFromText("second edit"),
    });
    const versions = await listVersions("doc-coalesce");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionId: first.versionId,
      docVersion: 3,
      contentHash: getPmContentHash(pmDocFromText("second edit")),
      parentVersion: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      summary: "第一笔用户保存",
    });
    expect(versions[0]?.snapshotPm).toEqual(pmDocFromText("second edit"));
    const rawOps = await getDocumentsClient().execute({
      sql: "SELECT from_version, to_version FROM document_ops WHERE doc_id = ? ORDER BY to_version ASC",
      args: ["doc-coalesce"],
    });
    expect(rawOps.rows.map((row) => [row.from_version, row.to_version])).toEqual([
      [1, 2],
      [2, 3],
    ]);
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
    });
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

  it("returns conflict for stale doc_version or mismatched baseContentHash", async () => {
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

    const hashConflict = await commitDocumentOp(
      commitInput({
        docId: "doc-conflict",
        threadId: "thread-doc-conflict",
        expectedDocumentSnapshot: 3,
        baseContentHash: "pmv1-wrong",
        clientMutationId: "client-hash",
      }),
    );
    expect(hashConflict).toEqual({
      status: "conflict",
      currentVersion: 3,
      currentHash: current?.contentHash,
    });
  });

  it("returns not_found without creating version or op rows", async () => {
    const result = await commitDocumentOp(commitInput({ docId: "missing" }));
    expect(result).toEqual({ status: "not_found" });
    expect(await listVersions("missing")).toEqual([]);
    expect(await findOpByIdempotencyKey({ clientMutationId: "client-commit" })).toBeNull();
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
    expect(await findOpByIdempotencyKey({ opId: "generation-first-store" })).toMatchObject({
      docId: "doc-first-store",
      fromVersion: 0,
      toVersion: 1,
    });
  });

  it("short-circuits repeated clientMutationId and opId without bumping", async () => {
    await seedDocument();
    const first = await commitDocumentOp(commitInput({ opId: "op-explicit" }));
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
    });

    const byOpId = await commitDocumentOp(
      commitInput({
        opId: "op-explicit",
        clientMutationId: "client-other",
      }),
    );
    expect(byOpId).toMatchObject({
      status: "committed",
      docVersion: 2,
    });

    const loaded = await documentRepo.load("doc-commit");
    expect(loaded?.docVersion).toBe(2);
    expect(await listVersions("doc-commit")).toHaveLength(1);
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
    expect(second).toMatchObject({ status: "committed", docVersion: 2 });
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
    expect(await findOpByIdempotencyKey({ clientMutationId: "client-invalid" })).toBeNull();
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
    expect(await findOpByIdempotencyKey({ clientMutationId: `client-${hookName}` })).toBeNull();
    expect(fakeSession).toEqual({
      doc: pmDocFromText("before"),
      docVersion: 1,
    });
    expect(frames).toEqual([]);
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
    expect(await findOpByIdempotencyKey({ clientMutationId: "client-desync" })).toBeNull();
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
      await findOpByIdempotencyKey({ clientMutationId: "client-desync-regression" }),
    ).toBeNull();
  });
});

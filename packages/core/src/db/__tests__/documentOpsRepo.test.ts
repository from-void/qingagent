import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findOpByIdempotencyKey,
  insertOp,
} from "../documentOpsRepo.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let tempDb: TempDocumentsDb;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-document-ops-");
});

afterEach(() => {
  tempDb.cleanup();
});

describe("documentOpsRepo", () => {
  it("inserts ops and finds them by opId or clientMutationId", async () => {
    await insertOp({
      opId: "op-1",
      docId: "doc-ops",
      opKind: "replace_doc",
      clientMutationId: "client-1",
      steps: [{ stepType: "replace", from: 1, to: 2 }],
      fromVersion: 1,
      toVersion: 2,
      actorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const byOpId = await findOpByIdempotencyKey({ opId: "op-1" });
    expect(byOpId).toMatchObject({
      opId: "op-1",
      docId: "doc-ops",
      opKind: "replace_doc",
      clientMutationId: "client-1",
      fromVersion: 1,
      toVersion: 2,
      actorType: "user",
    });
    expect(byOpId?.steps).toEqual([{ stepType: "replace", from: 1, to: 2 }]);

    const byClientMutationId = await findOpByIdempotencyKey({
      clientMutationId: "client-1",
    });
    expect(byClientMutationId?.opId).toBe("op-1");

    expect(await findOpByIdempotencyKey({})).toBeNull();
  });

  it("enforces unique opId and clientMutationId", async () => {
    await insertOp({
      opId: "op-unique",
      docId: "doc-ops",
      opKind: "replace_doc",
      clientMutationId: "client-unique",
      fromVersion: 1,
      toVersion: 2,
      actorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      insertOp({
        opId: "op-unique",
        docId: "doc-ops",
        opKind: "replace_doc",
        fromVersion: 2,
        toVersion: 3,
        actorType: "agent",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toThrow();

    await expect(
      insertOp({
        opId: "op-other",
        docId: "doc-ops",
        opKind: "replace_doc",
        clientMutationId: "client-unique",
        fromVersion: 2,
        toVersion: 3,
        actorType: "agent",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toThrow();
  });
});

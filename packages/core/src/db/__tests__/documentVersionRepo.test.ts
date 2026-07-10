import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash } from "@qingagent/pm-schema";
import {
  getLatestVersionSnapshot,
  getMaxDocumentSnapshotVersion,
  getMinDocumentSnapshotVersion,
  getVersionSnapshot,
  insertVersion,
  listVersions,
} from "../documentVersionRepo.js";
import {
  pmDocFromText,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let tempDb: TempDocumentsDb;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-document-versions-");
});

afterEach(() => {
  tempDb.cleanup();
});

describe("documentVersionRepo", () => {
  it("inserts, lists, and loads PM snapshots from document_versions", async () => {
    const firstDoc = pmDocFromText("第一版");
    const secondDoc = pmDocFromText("第二版");

    await insertVersion({
      versionId: "version-1",
      docId: "doc-versions",
      docVersion: 1,
      contentHash: getPmContentHash(firstDoc),
      schemaVersion: firstDoc.attrs.schemaVersion,
      actorType: "user",
      summary: "first",
      snapshotPm: firstDoc,
      parentVersion: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await insertVersion({
      versionId: "version-2",
      docId: "doc-versions",
      docVersion: 2,
      contentHash: getPmContentHash(secondDoc),
      schemaVersion: secondDoc.attrs.schemaVersion,
      actorType: "agent",
      summary: null,
      snapshotPm: secondDoc,
      parentVersion: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const versions = await listVersions("doc-versions");
    expect(versions.map((row) => row.versionId)).toEqual(["version-2", "version-1"]);
    expect(versions[0]).toMatchObject({
      docId: "doc-versions",
      docVersion: 2,
      actorType: "agent",
      parentVersion: 1,
      summary: null,
    });
    expect(versions[0]?.snapshotPm).toEqual(secondDoc);

    const snapshot = await getVersionSnapshot("version-1");
    expect(snapshot?.snapshotPm).toEqual(firstDoc);
    expect(snapshot?.contentHash).toBe(getPmContentHash(firstDoc));
    expect(await getVersionSnapshot("missing")).toBeNull();
    expect(await getMaxDocumentSnapshotVersion("doc-versions")).toBe(2);
    expect(await getMaxDocumentSnapshotVersion("missing")).toBeNull();
    expect(await getMinDocumentSnapshotVersion("doc-versions")).toBe(1);
    expect(await getMinDocumentSnapshotVersion("missing")).toBeNull();
    expect(await getLatestVersionSnapshot("doc-versions")).toMatchObject({
      versionId: "version-2",
      docVersion: 2,
      contentHash: getPmContentHash(secondDoc),
    });
    expect(await getLatestVersionSnapshot("missing")).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRepo = vi.hoisted(() => ({
  listVersions: vi.fn(),
  getVersionSnapshot: vi.fn(),
}));

vi.mock("@qingagent/core", () => mockRepo);

async function loadApp() {
  const { Hono } = await import("hono");
  const { historyRoutes } = await import("../routes/history");
  const app = new Hono();
  app.route("/api/v1", historyRoutes);
  return app;
}

const pmDoc = {
  type: "doc" as const,
  attrs: { schemaVersion: 1 as const },
  content: [
    {
      type: "paragraph" as const,
      attrs: { blockId: "block-p" },
      content: [{ type: "text" as const, text: "历史正文" }],
    },
  ],
};

describe("history routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists document_versions for the requested session", async () => {
    mockRepo.listVersions.mockResolvedValue([
      {
        versionId: "version-2",
        docId: "session-1",
        docVersion: 2,
        contentHash: "hash-2",
        schemaVersion: 1,
        actorType: "user",
        summary: "用户编辑保存",
        snapshotPm: pmDoc,
        parentVersion: 1,
        createdAt: "2026-06-06T01:00:00.000Z",
      },
    ]);
    const app = await loadApp();

    const res = await app.request("/api/v1/history?sessionId=session-1");

    expect(res.status).toBe(200);
    expect(mockRepo.listVersions).toHaveBeenCalledWith("session-1");
    expect(await res.json()).toEqual({
      entries: [
        {
          version_id: "version-2",
          session_id: "session-1",
          doc_id: "session-1",
          docVersion: 2,
          content_hash: "hash-2",
          schemaVersion: 1,
          actor_type: "user",
          summary: "用户编辑保存",
          created_at: "2026-06-06T01:00:00.000Z",
        },
      ],
    });
  });

  it("returns a PM snapshot by version id", async () => {
    mockRepo.getVersionSnapshot.mockResolvedValue({
      versionId: "version-2",
      docId: "session-1",
      docVersion: 2,
      contentHash: "hash-2",
      schemaVersion: 1,
      actorType: "user",
      summary: "用户编辑保存",
      snapshotPm: pmDoc,
      parentVersion: 1,
      createdAt: "2026-06-06T01:00:00.000Z",
    });
    const app = await loadApp();

    const res = await app.request("/api/v1/history/version-2?sessionId=session-1");

    expect(res.status).toBe(200);
    expect(mockRepo.getVersionSnapshot).toHaveBeenCalledWith("version-2");
    expect(await res.json()).toEqual({
      version_id: "version-2",
      doc: pmDoc,
      docVersion: 2,
    });
  });

  it("rejects a snapshot when the version belongs to another session", async () => {
    mockRepo.getVersionSnapshot.mockResolvedValue({
      versionId: "version-2",
      docId: "session-b",
      docVersion: 2,
      contentHash: "hash-2",
      schemaVersion: 1,
      actorType: "user",
      summary: "用户编辑保存",
      snapshotPm: pmDoc,
      parentVersion: 1,
      createdAt: "2026-06-06T01:00:00.000Z",
    });
    const app = await loadApp();

    const res = await app.request("/api/v1/history/version-2?sessionId=session-a");

    expect(res.status).toBe(404);
    expect(mockRepo.getVersionSnapshot).toHaveBeenCalledWith("version-2");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

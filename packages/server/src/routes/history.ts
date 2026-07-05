import { Hono } from "hono";
import type { HistoryList, HistorySnapshot } from "@qingagent/contract-ts";
import { getVersionSnapshot, listVersions } from "@qingagent/core";

export const historyRoutes = new Hono();

historyRoutes.get("/history", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ entries: [] } satisfies HistoryList);
  }

  const rows = await listVersions(sessionId);
  const list: HistoryList = {
    entries: rows.map((row) => ({
      version_id: row.versionId,
      session_id: row.docId,
      doc_id: row.docId,
      docVersion: row.docVersion,
      content_hash: row.contentHash,
      schemaVersion: row.schemaVersion,
      actor_type: row.actorType,
      summary: row.summary ?? versionSummary(row.actorType),
      created_at: row.createdAt,
    })),
  };
  return c.json(list);
});

historyRoutes.get("/history/:versionId", async (c) => {
  const versionId = c.req.param("versionId");
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "not found" }, 404);

  const row = await getVersionSnapshot(versionId);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.docId !== sessionId) return c.json({ error: "not found" }, 404);

  const snapshot: HistorySnapshot = {
    version_id: row.versionId,
    doc: row.snapshotPm,
    docVersion: row.docVersion,
  };
  return c.json(snapshot);
});

function versionSummary(actorType: "user" | "agent" | "system"): string {
  switch (actorType) {
    case "user":
      return "你编辑保存";
    case "agent":
      return "助手写入";
    case "system":
      return "系统写入";
  }
}

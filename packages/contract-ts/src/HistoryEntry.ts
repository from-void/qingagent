
export type HistoryEntry = {
  version_id: string,
  session_id: string,
  doc_id: string,
  docVersion: number,
  content_hash: string,
  schemaVersion: number,
  actor_type: "user" | "agent" | "system",
  summary: string,
  created_at: string,
};

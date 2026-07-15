import type { Client } from "@libsql/client";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  await client.execute(
    "ALTER TABLE document_suggestions ADD COLUMN severity TEXT CHECK(severity IS NULL OR severity IN ('error','warn','info'))",
  );
  await client.execute(`CREATE TABLE review_dismissal_signals (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    summary TEXT NOT NULL,
    quote TEXT NOT NULL,
    ts TEXT NOT NULL
  )`);
  await client.execute(
    "CREATE INDEX idx_review_dismissal_signals_doc_ts ON review_dismissal_signals(doc_id, ts DESC)",
  );

  const now = new Date().toISOString();
  for (const seed of REVIEW_TEMPLATE_PROMPT_SEEDS) {
    await client.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?)
        ON CONFLICT(id) DO UPDATE SET
          type=excluded.type,name=excluded.name,prompt=excluded.prompt,updated_at=excluded.updated_at
        WHERE review_templates.builtin=1`,
      args: [seed.id, seed.type, seed.name, seed.prompt, now, now],
    });
  }

  for (const [type, templateId] of [
    ["consistency", "review-consistency-default"],
    ["privacy", "review-privacy-default"],
    ["format", "review-format-default"],
    ["custom", "review-custom-legal"],
  ] as const) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO review_template_selections(type,template_id,updated_at)
        VALUES(?,?,?)`,
      args: [type, templateId, now],
    });
  }
}

export const migration0013ReviewTypesAndSignals: Migration = {
  id: 13,
  name: "review_types_and_signals",
  up,
};

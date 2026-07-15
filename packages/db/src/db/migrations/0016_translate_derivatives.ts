import type { Client } from "@libsql/client";
import { DTYPE_WRITING_TEMPLATE_SEEDS } from "../../seeds/dtypeTemplatePrompts.js";
import type { Migration } from "./types.js";

async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
}

async function up(client: Client): Promise<void> {
  if (!await hasColumn(client, "document_derivatives", "target_lang")) {
    await client.execute("ALTER TABLE document_derivatives ADD COLUMN target_lang TEXT NULL");
  }
  const now = new Date().toISOString();
  for (const seed of DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype === "translate")) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO skill_resources (id,kind,name,meta_json,created_at,updated_at)
        VALUES (?, 'style-template', ?, '{}', ?, ?)`,
      args: [seed.id, seed.name, now, now],
    });
    await client.execute({
      sql: `INSERT OR IGNORE INTO style_templates
        (resource_id,dtype,slot,name,detail,prompt,builtin) VALUES (?,?,?,?,?,?,1)`,
      args: [seed.id, seed.dtype, seed.slot, seed.name, seed.detail, seed.prompt],
    });
  }
}

export const migration0016TranslateDerivatives: Migration = {
  id: 16,
  name: "translate_derivatives",
  up,
};

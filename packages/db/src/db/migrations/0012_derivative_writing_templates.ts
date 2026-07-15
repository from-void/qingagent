import type { Client } from "@libsql/client";
import { DTYPE_WRITING_TEMPLATE_SEEDS } from "../../seeds/dtypeTemplatePrompts.js";
import type { Migration } from "./types.js";

const RETIRED_BUILTIN_REPLACEMENTS = [
  ["gzh-deep", "gzh-opinion"],
  ["gzh-news", "gzh-tutorial"],
  ["xhs-seed", "xhs-recommend"],
  ["xhs-list", "xhs-checklist"],
] as const;

async function up(client: Client): Promise<void> {
  const now = new Date().toISOString();
  for (const seed of DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype !== "translate")) {
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

  for (const [retiredId, replacementId] of RETIRED_BUILTIN_REPLACEMENTS) {
    await client.execute({
      sql: `UPDATE document_derivatives SET template_id = ?
        WHERE template_id = ? AND EXISTS (
          SELECT 1 FROM style_templates WHERE resource_id = ? AND builtin = 1
        )`,
      args: [replacementId, retiredId, retiredId],
    });
    await client.execute({
      sql: `DELETE FROM skill_resources WHERE id = ? AND kind = 'style-template'
        AND EXISTS (
          SELECT 1 FROM style_templates WHERE resource_id = ? AND builtin = 1
        )`,
      args: [retiredId, retiredId],
    });
  }
}

export const migration0012DerivativeWritingTemplates: Migration = {
  id: 12,
  name: "derivative_writing_templates",
  up,
};

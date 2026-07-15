import type { Client } from "@libsql/client";
import { DTYPE_WRITING_TEMPLATE_SEEDS } from "../../seeds/dtypeTemplatePrompts.js";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  const now = new Date().toISOString();
  for (const seed of REVIEW_TEMPLATE_PROMPT_SEEDS) {
    await client.execute({
      sql: `UPDATE review_templates
        SET prompt=?,updated_at=?
        WHERE id=? AND builtin=1`,
      args: [seed.prompt, now, seed.id],
    });
  }

  for (const seed of DTYPE_WRITING_TEMPLATE_SEEDS) {
    await client.execute({
      sql: `UPDATE style_templates
        SET prompt=?
        WHERE resource_id=? AND builtin=1`,
      args: [seed.prompt, seed.id],
    });
  }
}

export const migration0014RefreshBuiltinPromptSeeds: Migration = {
  id: 14,
  name: "refresh_builtin_prompt_seeds",
  up,
};

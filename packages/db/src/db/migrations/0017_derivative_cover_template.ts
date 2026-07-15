import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
}

async function up(client: Client): Promise<void> {
  if (!await hasColumn(client, "document_derivatives", "cover_template")) {
    await client.execute("ALTER TABLE document_derivatives ADD COLUMN cover_template TEXT NOT NULL DEFAULT 'poster'");
  }
}

export const migration0017DerivativeCoverTemplate: Migration = {
  id: 17,
  name: "derivative_cover_template",
  up,
};

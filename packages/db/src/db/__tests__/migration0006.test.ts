import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0006DocumentDerivatives } from "../migrations/0006_document_derivatives.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0006-"); });
afterEach(() => db.cleanup());

describe("0006 document derivatives", () => {
  it("保留旧数据、回填 main，并放开同会话衍生稿", async () => {
    await runMigrations(MIGRATIONS.slice(0, 5));
    const client = getDocumentsClient();
    const now = "2026-07-12T00:00:00.000Z";
    await client.execute({ sql: `INSERT INTO documents (id,thread_id,resource_id,title,doc_state,doc_pm,created_at,updated_at)
      VALUES ('main','thread','resource','主文','editing',?, ?, ?)`, args: [JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [] }), now, now] });
    await migration0006DocumentDerivatives.up(client);
    await migration0006DocumentDerivatives.up(client);
    const row = (await client.execute("SELECT title, role FROM documents WHERE id='main'")).rows[0];
    expect(row).toMatchObject({ title: "主文", role: "main" });
    await client.execute({ sql: `INSERT INTO documents (id,thread_id,resource_id,title,doc_state,doc_pm,created_at,updated_at,role)
      VALUES ('d1','thread','resource','衍生1','editing',?, ?, ?,'derivative'),('d2','thread','resource','衍生2','editing',?, ?, ?,'derivative')`, args: [JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [] }), now, now, JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [] }), now, now] });
    await expect(client.execute({ sql: `INSERT INTO documents (id,thread_id,resource_id,title,doc_state,doc_pm,created_at,updated_at,role) VALUES ('main2','thread','resource','','editing',?, ?, ?,'main')`, args: [JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [] }), now, now] })).rejects.toThrow();
  });
});

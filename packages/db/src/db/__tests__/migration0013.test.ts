import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0013ReviewTypesAndSignals } from "../migrations/0013_review_types_and_signals.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0013-"); });
afterEach(() => db.cleanup());

describe("0013 review types and signals", () => {
  it("原样装配七条提示词种子并建立四类默认选择", async () => {
    await runMigrations(MIGRATIONS.slice(0, 12));
    const client = getDocumentsClient();
    await migration0013ReviewTypesAndSignals.up(client);

    const result = await client.execute(
      "SELECT id,type,name,prompt,builtin FROM review_templates WHERE id LIKE 'review-%' ORDER BY id",
    );
    for (const seed of REVIEW_TEMPLATE_PROMPT_SEEDS) {
      expect(result.rows.find((row) => row.id === seed.id)).toMatchObject({
        type: seed.type,
        name: seed.name,
        prompt: seed.prompt,
        builtin: 1,
      });
    }
    const selected = await client.execute(
      "SELECT type,template_id FROM review_template_selections WHERE type IN ('consistency','privacy','format','custom') ORDER BY type",
    );
    expect(selected.rows).toMatchObject([
      { type: "consistency", template_id: "review-consistency-default" },
      { type: "custom", template_id: "review-custom-legal" },
      { type: "format", template_id: "review-format-default" },
      { type: "privacy", template_id: "review-privacy-default" },
    ]);
  });

  it("批注表增加可选严重度并创建忽略沉淀信号表", async () => {
    await runMigrations(MIGRATIONS.slice(0, 12));
    const client = getDocumentsClient();
    await migration0013ReviewTypesAndSignals.up(client);

    const columns = await client.execute("PRAGMA table_info(document_suggestions)");
    expect(columns.rows.some((row) => row.name === "severity")).toBe(true);
    const signalColumns = await client.execute("PRAGMA table_info(review_dismissal_signals)");
    expect(signalColumns.rows.map((row) => row.name)).toEqual(["id", "doc_id", "origin", "summary", "quote", "ts"]);
  });
});

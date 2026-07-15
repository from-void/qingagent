import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTYPE_WRITING_TEMPLATE_SEEDS } from "../../seeds/dtypeTemplatePrompts.js";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0014RefreshBuiltinPromptSeeds } from "../migrations/0014_refresh_builtin_prompt_seeds.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0014-"); });
afterEach(() => db.cleanup());

describe("0014 refresh builtin prompt seeds", () => {
  it("刷新已入库的内置提示词，同时保留用户模板", async () => {
    await runMigrations(MIGRATIONS.slice(0, 13));
    const client = getDocumentsClient();
    await client.execute("UPDATE review_templates SET prompt='旧审查提示' WHERE id='review-consistency-default'");
    await client.execute("UPDATE review_templates SET prompt='旧敏感词提示' WHERE id='review-sensitive-default'");
    await client.execute("UPDATE style_templates SET prompt='旧写作提示' WHERE resource_id='gzh-story'");
    await client.execute("UPDATE style_templates SET prompt='用户提示',builtin=0 WHERE resource_id='xhs-experience'");

    await migration0014RefreshBuiltinPromptSeeds.up(client);

    const reviewSeed = REVIEW_TEMPLATE_PROMPT_SEEDS.find((seed) => seed.id === "review-consistency-default")!;
    const sensitiveSeed = REVIEW_TEMPLATE_PROMPT_SEEDS.find((seed) => seed.id === "review-sensitive-default")!;
    const storySeed = DTYPE_WRITING_TEMPLATE_SEEDS.find((seed) => seed.id === "gzh-story")!;
    expect((await client.execute("SELECT prompt FROM review_templates WHERE id='review-consistency-default'")).rows[0]?.prompt).toBe(reviewSeed.prompt);
    expect((await client.execute("SELECT prompt FROM review_templates WHERE id='review-sensitive-default'")).rows[0]?.prompt).toBe(sensitiveSeed.prompt);
    expect(sensitiveSeed.prompt).toContain("不得因语境、专有名词或引用而自行豁免");
    expect(sensitiveSeed.prompt).toContain("severity=info");
    expect((await client.execute("SELECT prompt FROM style_templates WHERE resource_id='gzh-story'")).rows[0]?.prompt).toBe(storySeed.prompt);
    expect((await client.execute("SELECT prompt,builtin FROM style_templates WHERE resource_id='xhs-experience'")).rows[0]).toMatchObject({
      prompt: "用户提示",
      builtin: 0,
    });
  });
});

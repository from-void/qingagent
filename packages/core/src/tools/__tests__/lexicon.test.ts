import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEnabledLexicons } from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { sensitiveScanTool } from "../lexicon.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-sensitive-scan-selection-");
});

afterEach(() => {
  db.cleanup();
});

describe("sensitiveScanTool", () => {
  it("只扫描持久层启用词库，即使调用参数混入已关闭词库", async () => {
    await setEnabledLexicons(["lexicon-advertising-superlatives"]);
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "paragraph-1" },
        content: [{ type: "text", text: "这是唯一方案，可以根治问题。" }],
      }],
    };

    const result = await sensitiveScanTool.execute!({
      resourceIds: [
        "lexicon-advertising-superlatives",
        "lexicon-medical-health-claims",
      ],
    }, {
      requestContext: { get: (key: string) => key === "doc" ? doc : undefined },
    } as never) as { hits: Array<{ word: string }> };

    expect(result.hits.map((hit) => hit.word)).toContain("唯一");
    expect(result.hits.map((hit) => hit.word)).not.toContain("根治");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markdownToPm } from "../markdown/markdownToPm";
import { canonicalJson } from "./__fixtures__/markdown-to-pm/canonicalJson";
import { MARKDOWN_TO_PM_CORPUS } from "./__fixtures__/markdown-to-pm/corpus";

const golden = readFileSync(
  new URL("./__fixtures__/markdown-to-pm/markdown-to-pm.golden.json", import.meta.url),
  "utf8",
);

describe("markdownToPm frozen oracle", () => {
  it("命名 corpus 的 canonical JSON 与重写前 golden 逐字节一致", () => {
    const actual = Object.fromEntries(
      MARKDOWN_TO_PM_CORPUS.map(({ name, markdown }) => [name, markdownToPm(markdown)]),
    );

    expect(`${canonicalJson(actual)}\n`).toBe(golden);
  });
});

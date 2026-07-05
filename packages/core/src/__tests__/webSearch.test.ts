import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDdgHtml } from "../search/parseDuckDuckGo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("DuckDuckGo HTML parser", () => {
  it("extracts results and unwraps DDG redirect URLs", async () => {
    const fixture = await readFile(join(__dirname, "fixtures", "ddg-results.html"), "utf8");
    const results = parseDdgHtml(fixture, 10);

    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results.every((result) => result.title.length > 0)).toBe(true);
    expect(results[0]?.title.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toEqual(expect.any(String));

    const firstUrl = new URL(results[0]!.url);
    expect(["http:", "https:"]).toContain(firstUrl.protocol);
    expect(results[0]?.url).toBe("https://example.com/qingagent/overview");
    expect(results.some((result) => result.url.includes("duckduckgo.com/l/"))).toBe(false);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDdgHtml("")).toEqual([]);
  });
});

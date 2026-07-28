import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBingSerp } from "./parseBing.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(here, "../__tests__/fixtures/bing-results.html"),
  "utf-8",
);

describe("parseBingSerp", () => {
  it("剔除广告(li.b_ad),只取 organic(li.b_algo),字段齐全", () => {
    const out = parseBingSerp(fixture, 10);
    expect(out).toHaveLength(2);
    // 广告 URL 不应出现
    expect(out.some((r) => r.url.includes("ad.example.com") || r.url.includes("ad2.example.com"))).toBe(false);
    expect(out[0]).toMatchObject({
      title: "杭州 - 维基百科",
      url: "https://zh.wikipedia.org/wiki/%E6%9D%AD%E5%B7%9E",
    });
    expect(out[0]!.snippet).toContain("浙江省省会");
    expect(out[1]!.title).toBe("杭州市人民政府");
    // 所有 URL 均为 http(s)
    for (const r of out) expect(/^https?:\/\//.test(r.url)).toBe(true);
  });

  it("尊重 limit", () => {
    expect(parseBingSerp(fixture, 1)).toHaveLength(1);
  });

  it("空/异常输入 → []", () => {
    expect(parseBingSerp("", 5)).toEqual([]);
    expect(parseBingSerp("<html><body>no results</body></html>", 5)).toEqual([]);
    expect(parseBingSerp(fixture, 0)).toEqual([]);
  });

  it("严格解析区分有效空结果与无效 HTML", () => {
    expect(parseBingSerp("<ol id=\"b_results\"></ol>", 5, { strict: true })).toEqual([]);
    expect(() => parseBingSerp("<html><body>blocked</body></html>", 5, {
      strict: true,
    })).toThrow("invalid HTML");
  });
});

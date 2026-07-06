import { describe, expect, it } from "vitest";
import type { SearchResult } from "../search/provider.js";
import {
  filterByRelevance,
  scoreRelevance,
} from "../search/relevanceGate.js";

function result(title: string, snippet = ""): SearchResult {
  return { title, snippet, url: `https://example.com/${encodeURIComponent(title)}` };
}

describe("relevanceGate", () => {
  it("保留相关中文结果并统计 dropped", () => {
    const a = result("特斯拉发布 Q4 财报,营收创新高", "电动车业务毛利改善");
    const b = result("特_新华字典", "汉字释义与组词");

    const out = filterByRelevance([a, b], "特斯拉 Q4 财报");

    expect(out).toEqual({ kept: [a], dropped: 1 });
    expect(scoreRelevance(a, "特斯拉 Q4 财报")).toBeGreaterThanOrEqual(0.25);
    expect(scoreRelevance(b, "特斯拉 Q4 财报")).toBeLessThan(0.25);
  });

  it("keywords 为空时直通且 dropped=0", () => {
    const items = [result("任意标题"), result("另一个标题")];

    expect(filterByRelevance(items, "   ")).toEqual({ kept: items, dropped: 0 });
  });

  it("英文按宽松词边界命中,避免命中词内子串", () => {
    const matched = result("Tesla Q4 earnings report", "Revenue reached a new high");
    const notMatched = result("Cartography quarterly note", "irrelevant update");

    expect(scoreRelevance(matched, "Tesla revenue")).toBe(1);
    expect(scoreRelevance(notMatched, "car")).toBe(0);
    expect(filterByRelevance([matched, notMatched], "Tesla revenue")).toEqual({
      kept: [matched],
      dropped: 1,
    });
  });
});

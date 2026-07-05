import { describe, expect, it } from "vitest";
import { parseDeepseekWebSearchResult } from "../search/deepseekWebSearch.js";

// 防御性解析:DeepSeek web_search 响应不可信,枚举真实脏形态确保不抛、字段缺失安全跳过。
describe("parseDeepseekWebSearchResult — DeepSeek web_search 响应解析(脏路径)", () => {
  it("正常:抽出综合答案 + 来源(title/url)", () => {
    const data = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "server_tool_use", name: "web_search", input: { query: "x" } },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", title: "T1", url: "https://a.com", encrypted_content: "xx" },
            { type: "web_search_result", title: "T2", url: "https://b.com" },
          ],
        },
        { type: "text", text: "综合答案。" },
      ],
    };
    const r = parseDeepseekWebSearchResult(data, 8);
    expect(r.answer).toBe("综合答案。");
    expect(r.sources).toEqual([
      { title: "T1", url: "https://a.com", snippet: "" },
      { title: "T2", url: "https://b.com", snippet: "" },
    ]);
  });

  it("缺 content / content 非数组 / null / 非对象 → 空结果不抛", () => {
    expect(parseDeepseekWebSearchResult(null)).toEqual({ answer: "", sources: [] });
    expect(parseDeepseekWebSearchResult(undefined)).toEqual({ answer: "", sources: [] });
    expect(parseDeepseekWebSearchResult({})).toEqual({ answer: "", sources: [] });
    expect(parseDeepseekWebSearchResult({ content: "x" })).toEqual({ answer: "", sources: [] });
    expect(parseDeepseekWebSearchResult("plain string")).toEqual({ answer: "", sources: [] });
  });

  it("result 无 url 跳过 / 无 title 用 url 兜底 / 非 web_search_result 跳过 / null 项跳过", () => {
    const data = {
      content: [
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", title: "有title", url: "https://a.com" },
            { type: "web_search_result", url: "https://b.com" }, // 无 title → 用 url
            { type: "web_search_result", title: "无url" }, // 无 url → 跳过
            { type: "other", url: "https://c.com" }, // 非 result → 跳过
            null, // 脏项 → 跳过
          ],
        },
      ],
    };
    const r = parseDeepseekWebSearchResult(data);
    expect(r.sources).toEqual([
      { title: "有title", url: "https://a.com", snippet: "" },
      { title: "https://b.com", url: "https://b.com", snippet: "" },
    ]);
  });

  it("多个 text 块拼接 + trim;maxResults 截断来源", () => {
    const data = {
      content: [
        { type: "text", text: "答案A" },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", title: "T1", url: "https://a.com" },
            { type: "web_search_result", title: "T2", url: "https://b.com" },
            { type: "web_search_result", title: "T3", url: "https://c.com" },
          ],
        },
        { type: "text", text: "答案B  " },
      ],
    };
    const r = parseDeepseekWebSearchResult(data, 2);
    expect(r.answer).toBe("答案A答案B");
    expect(r.sources).toHaveLength(2);
  });
});

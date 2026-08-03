import { aiBlocksToQingml, qingmlParse } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import {
  capXhsTopicTags,
  resolveXhsTopicTagLimit,
} from "./xhsTopicTags.js";

function capQingml(qingml: string, prompt: string): string {
  const parsed = qingmlParse(qingml);
  capXhsTopicTags(parsed.blocks, resolveXhsTopicTagLimit(prompt));
  return aiBlocksToQingml(parsed.blocks);
}

describe("小红书话题标签数量保护", () => {
  it.each([
    ["结尾给出 3 到 5 个相关话题标签", 5],
    ["文末只保留 3 个话题标签", 3],
    ["话题标签最多四个", 4],
  ])("识别模拟请求：%s", (prompt, expected) => {
    expect(resolveXhsTopicTagLimit(prompt)).toBe(expected);
  });

  it("没有显式数量时按默认 3-5 个执行上限 5", () => {
    expect(resolveXhsTopicTagLimit("语气自然一点")).toBe(5);
  });

  it("不把最低数量误判为上限", () => {
    expect(resolveXhsTopicTagLimit("至少 3 个话题标签，最多 6 个")).toBe(6);
    expect(resolveXhsTopicTagLimit("话题标签 3 个以上")).toBe(5);
  });

  it("不把单个标签字数误判为标签总数，并允许显式要求零个标签", () => {
    expect(resolveXhsTopicTagLimit("每个话题标签最多 3 个字")).toBe(5);
    expect(resolveXhsTopicTagLimit("结尾给出 0 个话题标签")).toBe(0);
    expect(capQingml("<p>正文。</p><p>#一 #二</p>", "0 个话题标签"))
      .not.toMatch(/#[一二]/u);
  });

  it("超出显式上限时机械保留前 N 个，正文与标签顺序不变", () => {
    const result = capQingml(
      "<h1>标题</h1><p>正文里的 #重点 仍按顺序计数。</p><p>#一 #二 #三 #四 #五 #六</p>",
      "最多 4 个话题标签",
    );
    expect(result).toContain("正文里的 #重点 仍按顺序计数");
    expect(result).toContain("#一 #二 #三");
    expect(result).not.toContain("#四");
    expect(result).not.toContain("#五");
    expect(result).not.toContain("#六");
  });

  it("标签跨行内 marks 时仍能裁剪，不处理代码块、图表源码或脚注两侧假标签", () => {
    const parsed = qingmlParse(
      "<p>#保留 #跨<b>标记</b> #删除</p>" +
      "<p>#<footnote id=\"note_1\">来源</footnote>断开</p>" +
      "<pre>#代码不算</pre><mermaid>graph TD; A[#图表不算]--&gt;B</mermaid>",
    );
    const summary = capXhsTopicTags(parsed.blocks, 2);
    const result = aiBlocksToQingml(parsed.blocks);
    expect(summary).toEqual({ topicCount: 3, removedCount: 1 });
    expect(result).toContain("#保留 #跨<b>标记</b>");
    expect(result).not.toContain("#删除");
    expect(result).toContain("#<footnote");
    expect(result).toContain("#代码不算");
    expect(result).toContain("#图表不算");
  });

  it("正文含括号、转义引号和尾随收尾话时只裁标签", () => {
    const result = capQingml(
      "开场话<p>正文含 ]、} 与 &quot;引号&quot;。</p><p>#一 #二 #三 #四</p>收尾话",
      "话题标签总数：二个",
    );
    expect(result).toContain('正文含 ]、} 与 "引号"。');
    expect(result).toContain("#一 #二");
    expect(result).not.toContain("#三");
    expect(result).not.toContain("#四");
  });
});

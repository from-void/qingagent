import { describe, it, expect } from "vitest";
import { extractThinkingMarqueeSentences, hasChinese } from "./chatThinkingMarquee";

describe("hasChinese", () => {
  it("detects CJK", () => {
    expect(hasChinese("用户想")).toBe(true);
    expect(hasChinese("DeepSeek-V4")).toBe(false);
    expect(hasChinese("DeepSeek-V4的最新模型")).toBe(true); // 中英混杂
  });
});

describe("extractThinkingMarqueeSentences", () => {
  it("空/纯空白 → []", () => {
    expect(extractThinkingMarqueeSentences("")).toEqual([]);
    expect(extractThinkingMarqueeSentences("   \n\n  ")).toEqual([]);
  });

  it("取每段首句(到首个句号),含标点", () => {
    const text =
      "用户想让我查找最新的AI领域新闻,然后撰写一份1500字的新闻稿。用户已经给出了比较明确的意图——AI新闻。\n\n" +
      "不过,我先搜索一下AI领域的最新新闻,这样可以结合搜索结果。但先按流程。";
    expect(extractThinkingMarqueeSentences(text)).toEqual([
      "用户想让我查找最新的AI领域新闻,然后撰写一份1500字的新闻稿。",
      "不过,我先搜索一下AI领域的最新新闻,这样可以结合搜索结果。",
    ]);
  });

  it("段内逗号/冒号/分号不算句末,只到句号", () => {
    const text = "等等,实际上用户已经比较明确了:1. 文体是新闻稿;2. 主题是AI;3. 字数约1500字。后面还有。";
    expect(extractThinkingMarqueeSentences(text)).toEqual([
      "等等,实际上用户已经比较明确了:1. 文体是新闻稿;2. 主题是AI;3. 字数约1500字。",
    ]);
  });

  it("单换行也按段切", () => {
    const text = "第一段想法。\n第二段想法。\n第三段。";
    expect(extractThinkingMarqueeSentences(text)).toEqual([
      "第一段想法。",
      "第二段想法。",
      "第三段。",
    ]);
  });

  it("末段还没出完整一句(无句末标点)→ 跳过(流式中)", () => {
    const text = "已经成形的一句话。\n正在打字还没有句号的半句";
    expect(extractThinkingMarqueeSentences(text)).toEqual(["已经成形的一句话。"]);
  });

  it("纯英文段丢弃,中英混杂保留", () => {
    const text =
      "Let me think about this first.\n" +
      "DeepSeek-V4的最新模型采用MoE结构。\n" +
      "OK, done.";
    expect(extractThinkingMarqueeSentences(text)).toEqual([
      "DeepSeek-V4的最新模型采用MoE结构。",
    ]);
  });

  it("中文问号/叹号也断句", () => {
    const text = "这是问句吗?接着想。\n太好了!继续。";
    expect(extractThinkingMarqueeSentences(text)).toEqual(["这是问句吗?", "太好了!"]);
  });

  it("碎片(去标点后 < 2 字)丢弃", () => {
    const text = "好。\n嗯。\n这是一句正常的话。";
    expect(extractThinkingMarqueeSentences(text)).toEqual(["这是一句正常的话。"]);
  });

  it("稳定前缀:文本增长时,已完成段的首句不变", () => {
    const partial = "第一句已完成。\n第二句正在";
    const grown = "第一句已完成。\n第二句正在写并且写完了。\n第三句。";
    const a = extractThinkingMarqueeSentences(partial);
    const b = extractThinkingMarqueeSentences(grown);
    expect(a).toEqual(["第一句已完成。"]);
    expect(b.slice(0, a.length)).toEqual(a); // 前缀稳定
    expect(b).toEqual(["第一句已完成。", "第二句正在写并且写完了。", "第三句。"]);
  });
});

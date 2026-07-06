import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mockFetchArticleDeps = vi.hoisted(() => ({
  extractArticleContent: vi.fn(),
  scrapeWithBrowserImpl: vi.fn(),
}));

vi.mock("../browser/extractor.js", async () => {
  const actual = await vi.importActual<typeof import("../browser/extractor.js")>(
    "../browser/extractor.js",
  );
  return {
    ...actual,
    extractArticleContent: mockFetchArticleDeps.extractArticleContent,
  };
});

vi.mock("../browser/scrapePage.js", () => ({
  scrapeWithBrowserImpl: mockFetchArticleDeps.scrapeWithBrowserImpl,
}));

import { fetchArticleTool, shouldFallbackToBrowser } from "../tools/fetchArticle.js";
import { isUnsupportedForHtmlExtraction, resolveSiteAdapter } from "../browser/extractor.js";

function wordCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

describe("resolveSiteAdapter 反爬站适配(移动子域+移动UA)", () => {
  const ua = (a: ReturnType<typeof resolveSiteAdapter>) => a?.headers?.["User-Agent"] ?? "";
  it("百度百科 → wapbaike 移动端", () => {
    const a = resolveSiteAdapter(new URL("https://baike.baidu.com/item/X/123"));
    expect(a).not.toBeNull();
    expect(a!.rewriteUrl!(new URL("https://baike.baidu.com/item/X/123")).hostname).toBe(
      "wapbaike.baidu.com",
    );
    expect(ua(a)).toMatch(/iPhone/);
  });
  it("什么值得买 post → post.m 移动端", () => {
    const a = resolveSiteAdapter(new URL("https://post.smzdm.com/p/abc/"));
    expect(a).not.toBeNull();
    expect(a!.rewriteUrl!(new URL("https://post.smzdm.com/p/abc/")).hostname).toBe(
      "post.m.smzdm.com",
    );
  });
  it("普通站不命中适配器", () => {
    expect(resolveSiteAdapter(new URL("https://zh.wikipedia.org/wiki/X"))).toBeNull();
    expect(resolveSiteAdapter(new URL("https://example.com/a"))).toBeNull();
  });
});

describe("isUnsupportedForHtmlExtraction", () => {
  it("拦截非 HTML 二进制/下载型(PDF/octet-stream/图片/附件)", () => {
    expect(isUnsupportedForHtmlExtraction("application/pdf")).toBe(true);
    expect(isUnsupportedForHtmlExtraction("application/octet-stream")).toBe(true);
    expect(isUnsupportedForHtmlExtraction("image/jpeg")).toBe(true);
    expect(isUnsupportedForHtmlExtraction("application/zip")).toBe(true);
    // text/html 但带下载附件头 → 也判不支持
    expect(isUnsupportedForHtmlExtraction("text/html", "attachment; filename=a.pdf")).toBe(true);
  });

  it("放行 HTML/XML/text 与缺失 Content-Type", () => {
    expect(isUnsupportedForHtmlExtraction("text/html; charset=utf-8")).toBe(false);
    expect(isUnsupportedForHtmlExtraction("application/xhtml+xml")).toBe(false);
    expect(isUnsupportedForHtmlExtraction("text/plain")).toBe(false);
    expect(isUnsupportedForHtmlExtraction("")).toBe(false);
    expect(isUnsupportedForHtmlExtraction(null)).toBe(false);
  });
});

describe("fetchArticle fallback signal", () => {
  beforeEach(() => {
    mockFetchArticleDeps.extractArticleContent.mockReset();
    mockFetchArticleDeps.scrapeWithBrowserImpl.mockReset();
  });

  it("exposes via in the output schema", () => {
    const outputSchema = fetchArticleTool.outputSchema as z.ZodType;
    expect(() =>
      outputSchema.parse({
        title: "标题",
        text: "这是一段足够长的正文，用于验证输出结构中包含浏览器降级信号字段。",
        wordCount: 42,
        images: [],
        screenshotSrc: null,
        ogImageUrl: null,
        sourceUrl: "https://example.com/article",
        materialId: "mat-123",
        via: "static",
      }),
    ).not.toThrow();
  });

  it("classifies thin bodies as needing browser fallback", () => {
    expect(shouldFallbackToBrowser("太短")).toBe(true);
    // 短而无实质(过了旧 <40 门槛但剔除控件后仍不足)的正文也应升级浏览器再试。
    expect(
      shouldFallbackToBrowser(
        "这是一段内容完整的正文，字数已经超过静态提取的最低阈值。",
      ),
    ).toBe(true);
    // 真实长文(>140 实质字)不需要浏览器降级。
    expect(
      shouldFallbackToBrowser(
        "宋代点茶是中国茶文化的高峰，文人以斗茶为乐，比拼茶汤颜色与咬盏持久度。" +
          "蔡襄《茶录》与宋徽宗《大观茶论》对点茶技艺有详尽记载，反映出当时茶事的精致" +
          "与审美追求。茶筅击拂使茶汤表面浮起细腻的白色乳花，乳花越白、咬盏越久者为胜。" +
          "这一时期的茶器、茶礼与茶诗共同构成了独具特色的宋代茶文化体系，影响深远。",
      ),
    ).toBe(false);
  });

  it("classifies JS-render shells (loading placeholder / nav noise) as needing browser fallback", () => {
    // 线上真实失败样本(CCTV JS 渲染页):静态抓只拿到 364 字的页面外壳,
    // 字数过了旧 <40 门槛,但正文是"原标题：正在加载"——必须升级浏览器重抓。
    const cctvShell =
      "新闻 新闻频道 > 科技新闻 超300款AI产品将全球首发 2026世界人工智能大会抢先看 " +
      "来源：央视新闻 | 2026年06月17日 22:25:04 原标题： 正在加载 编辑：钱景童 责任编辑：刘亮 " +
      "点击收起全文 返回央视网首页 返回新闻频道 分享：扫一扫 分享到微信 返回顶部 最新推荐 " +
      "加载更多 精彩图集 首页|全站地图 京ICP备10003349号-1 中央广播电视总台央视网版权所有 正在阅读";
    expect(cctvShell.replace(/\s+/g, "").length).toBeGreaterThan(40); // 过了旧门槛
    expect(shouldFallbackToBrowser(cctvShell)).toBe(true); // 新门槛能识别为壳

    // 纯导航壳(无加载占位,但噪声密集)也应升级
    const navShell = "返回首页 返回顶部 版权所有 ICP备 扫一扫 下载App 请登录 最新推荐 全站地图";
    expect(shouldFallbackToBrowser(navShell)).toBe(true);
  });

  it("does not false-positive on real long articles that mention loading words", () => {
    // 真实长文(>1000 字)即便偶然提到"加载",也不该被判为壳。
    // 用带句读的真实句子重复(而非无标点的"正文内容"堆叠)——真实正文必然句读密集,
    // 结构信号按长度缩放也能轻松满足。
    const realLong =
      "在前端工程实践中，懒加载是常见的性能优化手段。当页面正在加载时，可以先展示骨架屏。" +
      "合理的资源调度能显著降低首屏时间，从而改善用户体验。".repeat(40);
    expect(realLong.replace(/\s+/g, "").length).toBeGreaterThan(1000);
    expect(shouldFallbackToBrowser(realLong)).toBe(false);
  });

  it("静态不足时内部走浏览器并采纳更好的浏览器结果", async () => {
    const staticText = "正在加载... 返回首页 分享到微信";
    const browserText =
      "浏览器渲染后得到的完整正文，包含事件经过、关键数据、来源背景和后续影响。".repeat(12);
    mockFetchArticleDeps.extractArticleContent.mockResolvedValueOnce({
      title: "静态壳",
      body: staticText,
      images: [],
      screenshot: null,
      ogImageUrl: null,
    });
    mockFetchArticleDeps.scrapeWithBrowserImpl.mockResolvedValueOnce({
      ok: true,
      error: null,
      title: "浏览器正文",
      text: browserText,
      wordCount: wordCount(browserText),
      images: [{ src: "https://example.com/a.jpg", alt: null }],
      screenshotSrc: "/api/v1/files/shot/screenshot.jpg",
      ogImageUrl: "https://example.com/og.jpg",
    });

    const execute = fetchArticleTool.execute as unknown as (
      input: { url: string },
      context: unknown,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ url: "https://example.com/article" }, {});

    expect(mockFetchArticleDeps.scrapeWithBrowserImpl).toHaveBeenCalledWith(
      "https://example.com/article",
      { waitForSelector: undefined },
    );
    expect(result.title).toBe("浏览器正文");
    expect(result.text).toBe(browserText);
    expect(result.wordCount).toBe(wordCount(browserText));
    expect(result.screenshotSrc).toBe("/api/v1/files/shot/screenshot.jpg");
    expect(result.via).toBe("browser");
  });

  it("returns via=static on fetch failure instead of rejecting", async () => {
    mockFetchArticleDeps.extractArticleContent.mockRejectedValueOnce(new Error("blocked"));
    const execute = fetchArticleTool.execute as unknown as (
      input: { url: string },
      context: unknown,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ url: "https://example.com/article" }, {});
    expect(result.title).toBe("抓取失败");
    expect(result.via).toBe("static");
    expect(result.text).toMatch(/^\[Error]/);
  });
});

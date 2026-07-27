import { createTool } from "@mastra/core/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import { extractArticleContent, UNSUPPORTED_CONTENT_ERROR_PREFIX } from "@qingagent/doc-render/browser";
import { isSubstantiveContent } from "@qingagent/doc-render/browser";
import { scrapeWithBrowserImpl, type ScrapeResult } from "@qingagent/doc-render/browser";
import { persistScreenshot } from "@qingagent/doc-render/browser";
import { startToolHeartbeat } from "./toolHeartbeat.js";

const MIN_EXTRACTED_TEXT_LENGTH = 40;
// JS 内容未渲染时的占位标记(短正文里出现 → 抓到的是壳而非正文)。
const LOADING_PLACEHOLDER = /正在加载|加载中\.{0,3}|loading\s*\.{0,3}|请稍候/i;
// 导航 / 页脚 / 控件噪声(短正文里密集出现 → 抓到的是页面外壳)。
const NAV_NOISE = [
  "返回首页", "返回顶部", "返回新闻", "返回央视", "版权所有", "ICP备", "扫一扫",
  "责任编辑", "点击收起", "点击展开", "最新推荐", "全站地图", "下载App",
  "开启App", "请登录", "登录后", "精彩图集", "分享到微信",
];

/**
 * 判断静态抓取的正文是否"不可信、需升级到浏览器重抓"。
 * 不只看长度——JS 渲染页常返回带"正在加载"占位的页面外壳(几百字导航/页脚),
 * 字数过了旧的 <40 门槛却毫无正文价值(线上 CCTV 364 字壳即此类)。
 */
export function shouldFallbackToBrowser(extractedBody: string): boolean {
  const clean = extractedBody.replace(/\s+/g, "");
  if (clean.length < MIN_EXTRACTED_TEXT_LENGTH) return true;
  // 短正文(<1000 字)里出现加载占位 → 内容没渲染出来。
  if (clean.length < 1000 && LOADING_PLACEHOLDER.test(extractedBody)) return true;
  // 短正文(<600 字)且导航/页脚噪声密集(≥3 处)→ 抓到的是外壳。
  if (clean.length < 600 && NAV_NOISE.filter((m) => extractedBody.includes(m)).length >= 3) {
    return true;
  }
  // 兜底:静态抓到的正文"无实质内容"(剔除导航/分享控件后仍过短)→ 升级浏览器再试一次。
  // 动态渲染页静态常只拿到标题+控件壳,浏览器渲染 JS 后可能恢复真正文;即便恢复不了,
  // 也由浏览器结果校验/落库门按解析失败兜住,不会把空洞壳当正文存下。
  if (!isSubstantiveContent(extractedBody)) return true;
  return false;
}

type FetchArticleResult = {
  ok: true;
  error: null;
  title: string;
  text: string;
  wordCount: number;
  images: { src: string; alt: string | null }[];
  screenshotSrc: string | null;
  ogImageUrl: string | null;
  sourceUrl: string;
  materialId: string;
  via: "static" | "browser";
};

function fetchArticleFailure(
  sourceUrl: string,
  materialId: string,
  error: string,
  unsupported = false,
) {
  return {
    ok: false,
    error,
    title: unsupported ? "不支持的内容类型" : "抓取失败",
    text: unsupported ? `[Unsupported] ${error}` : `[Error] ${error}`,
    wordCount: 0,
    images: [],
    screenshotSrc: null,
    ogImageUrl: null,
    sourceUrl,
    materialId,
    via: "static" as const,
  };
}

function shouldUseBrowserResult(browserResult: ScrapeResult): boolean {
  return browserResult.ok && isSubstantiveContent(browserResult.text);
}

export const fetchArticleTool = createTool({
  id: "fetchArticle",
  description:
    "从 URL 抓取文章内容（支持微信公众号、小红书等平台）。自动提取标题、正文、图片，清理平台导航/广告等无关内容。抓取后应调用 storeMaterial 存储。",
  inputSchema: z.object({
    url: z.string().url().describe("要抓取的文章 URL"),
    waitForSelector: z.string().optional().describe("等待特定 CSS 选择器出现后再提取（可选）"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    title: z.string(),
    text: z.string(),
    wordCount: z.number(),
    images: z.array(z.object({ src: z.string(), alt: z.string().nullable() })),
    screenshotSrc: z.string().nullable(),
    ogImageUrl: z.string().nullable(),
    sourceUrl: z.string(),
    materialId: z.string(),
    via: z.enum(["static", "browser"]),
  }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "fetchArticle" });
    const materialId = "mat-" + createHash("sha256").update(input.url).digest("hex").slice(0, 12);
    const signal = context?.abortSignal;

    try {
      signal?.throwIfAborted();
      const result = await extractArticleContent(input.url, input.waitForSelector, signal);
      signal?.throwIfAborted();
      const wordCount = result.body.replace(/\s+/g, "").length;
      const screenshotSrc = result.screenshot
        ? await persistScreenshot(result.screenshot, signal)
        : null;
      signal?.throwIfAborted();

      let selected: FetchArticleResult = {
        ok: true,
        error: null,
        title: result.title,
        text: result.body,
        wordCount,
        images: result.images,
        screenshotSrc,
        ogImageUrl: result.ogImageUrl,
        sourceUrl: input.url,
        materialId,
        via: "static",
      };

      if (shouldFallbackToBrowser(result.body)) {
        let fallbackError: string | null = null;
        try {
          const browserResult = await scrapeWithBrowserImpl(input.url, {
            waitForSelector: input.waitForSelector,
            signal,
          });
          signal?.throwIfAborted();
          if (shouldUseBrowserResult(browserResult)) {
            selected = {
              ok: true,
              error: null,
              title: browserResult.title,
              text: browserResult.text,
              wordCount: browserResult.wordCount,
              images: browserResult.images,
              screenshotSrc: browserResult.screenshotSrc,
              ogImageUrl: browserResult.ogImageUrl,
              sourceUrl: input.url,
              materialId,
              via: "browser",
            };
          } else if (!isSubstantiveContent(selected.text)) {
            fallbackError =
              browserResult.error?.trim() || "浏览器降级未提取到有效正文";
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!isSubstantiveContent(selected.text)) {
            fallbackError = error instanceof Error ? error.message : String(error);
          }
          // 浏览器降级失败时仍保留可用的静态最佳结果。
        }
        if (fallbackError) {
          return fetchArticleFailure(input.url, materialId, fallbackError);
        }
      }

      return selected;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // 二进制/下载型链接(PDF/附件等):浏览器降级也只会触发下载、救不回正文 → 不升级浏览器,
      // 直接判为不支持(文本前缀 [Unsupported] 会被落库门当解析失败,不写入素材)。
      const isUnsupported = message.startsWith(UNSUPPORTED_CONTENT_ERROR_PREFIX);
      // 静态抓取抛错(反爬 403 / 连接失败等,非"不支持类型")时仍尝试无头浏览器降级——
      // stealth 浏览器常能过静态被挡的反爬。等价合并前 needsBrowserFallback=!isUnsupported 的契约:
      // extractor 对 403/非 2xx 是 throw(非返回空壳),故这条降级必须覆盖"静态抛错",
      // 否则反爬站(静态 403、浏览器可过)在 fetchArticle 直调与 webSearch 里都丢掉浏览器恢复路。
      let finalError = message;
      if (!isUnsupported) {
        try {
          const browserResult = await scrapeWithBrowserImpl(input.url, {
            waitForSelector: input.waitForSelector,
            signal,
          });
          signal?.throwIfAborted();
          if (browserResult.ok && isSubstantiveContent(browserResult.text)) {
            return {
              ok: true,
              error: null,
              title: browserResult.title,
              text: browserResult.text,
              wordCount: browserResult.wordCount,
              images: browserResult.images,
              screenshotSrc: browserResult.screenshotSrc,
              ogImageUrl: browserResult.ogImageUrl,
              sourceUrl: input.url,
              materialId,
              via: "browser" as const,
            };
          }
          finalError =
            browserResult.error?.trim() || "浏览器降级未提取到有效正文";
        } catch (browserError) {
          if (signal?.aborted) throw browserError;
          finalError =
            browserError instanceof Error ? browserError.message : String(browserError);
          // 浏览器也失败 → 落到下方 [Error] 返回,保持原有失败语义。
        }
      }
      const failureReason = isUnsupported
        ? message.slice(UNSUPPORTED_CONTENT_ERROR_PREFIX.length).trim()
        : finalError;
      return fetchArticleFailure(input.url, materialId, failureReason, isUnsupported);
    } finally {
      stop();
    }
  },
});

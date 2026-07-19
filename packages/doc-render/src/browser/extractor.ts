import { Buffer } from "node:buffer";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { loadPdfParseConstructor } from "./pdfParse.js";
import { extractWechatArticle, isWechatArticleUrl } from "./wechatArticle.js";
import {
  createPinnedLookup,
  parseFetchUrl,
  validateAndPinFetchUrl,
  validateFetchUrl,
  type PinnedFetchUrl,
} from "./fetchUrlPolicy.js";

export { validateFetchUrl };

export interface ExtractedArticleContent {
  title: string;
  body: string;
  images: Array<{ src: string; alt: string | null }>;
  screenshot: Buffer | null;
  ogImageUrl: string | null;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 移动端 UA:不少站(百度百科/什么值得买等)对 PC 抓取做安全验证/WAF,却对移动端直接吐 SSR 全文。
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// 站点适配器:对已知"PC 反爬、移动端可抓"的站,改写到移动子域 + 移动 UA + 追加站点正文选择器。
// 原则(用户):被搜索引擎收录=必可抓,403/空壳是姿势不对。每个适配器都有真机验证来源（专项验证）。
interface SiteAdapter {
  test: (host: string) => boolean;
  rewriteUrl?: (u: URL) => URL;
  headers?: Record<string, string>;
  extraSelectors?: string[];
  // 该站正文只在"移动端上下文"渲染(桌面渲染只出壳)——浏览器降级时用移动 emulation。
  mobileBrowser?: boolean;
}
const SITE_ADAPTERS: SiteAdapter[] = [
  {
    // 百度百科:PC 触发"百度安全验证"(403),移动端 wapbaike 同路径直出 SSR 正文。
    test: (h) => /(^|\.)baike\.baidu\.com$/.test(h),
    rewriteUrl: (u) => {
      const n = new URL(u.toString());
      n.hostname = "wapbaike.baidu.com";
      return n;
    },
    headers: { "User-Agent": MOBILE_UA, Referer: "https://www.baidu.com/" },
    extraSelectors: [".BK-main-content", ".summary-content", ".lemma-title"],
  },
  {
    // 敦煌石窟:www HTTPS 入口连接重置、证书链不完整(证书 CN *.dha.ac.cn),改 http 静态抓;正文 .v_news_content(已覆盖)。
    test: (h) => /(^|\.)dunhuangcaves\.org$/.test(h),
    rewriteUrl: (u) => {
      const n = new URL(u.toString());
      n.protocol = "http:";
      return n;
    },
  },
  {
    // 太平洋电脑网:正文 JS 渲染,且只在移动端上下文出正文(桌面浏览器渲染只得壳)。
    test: (h) => /(^|\.)pconline\.com\.cn$/.test(h),
    mobileBrowser: true,
    extraSelectors: [".content", ".articleCon", ".art-content", ".cont"],
  },
  {
    // 医脉通:news-cdn 子域有防盗链(403 denied by Referer ACL),改抓 canonical news 子域 + 带来源 Referer。
    test: (h) => /(^|\.)medlive\.cn$/.test(h),
    rewriteUrl: (u) => {
      const n = new URL(u.toString());
      n.hostname = n.hostname.replace(/^news-cdn\./, "news.");
      return n;
    },
    headers: { Referer: "https://news.medlive.cn/" },
    extraSelectors: [".article_cont"],
  },
  {
    // 什么值得买:PC 命中 WAF 探针页,移动端 post.m 直出 SSR 正文。
    test: (h) => /(^|\.)smzdm\.com$/.test(h),
    rewriteUrl: (u) => {
      const n = new URL(u.toString());
      if (n.hostname === "post.smzdm.com") n.hostname = "post.m.smzdm.com";
      else if (/^(www\.)?smzdm\.com$/.test(n.hostname)) n.hostname = "m.smzdm.com";
      return n;
    },
    headers: { "User-Agent": MOBILE_UA },
    extraSelectors: [".detail-article", "article.J_article"],
  },
];
export function resolveSiteAdapter(u: URL): SiteAdapter | null {
  return SITE_ADAPTERS.find((a) => a.test(u.hostname)) ?? null;
}

// PDF 上限:超大 PDF 解析慢,避免拖死整条抓取(论文类一般几 MB)。
const MAX_PDF_BYTES = 30 * 1024 * 1024;
// HTML/XML 上限独立于 PDF；静态正文通常远小于 10MiB，超限更可能是误投二进制或异常页面。
const MAX_HTML_BYTES = 10 * 1024 * 1024;

/** 从 PDF 字节提取纯文本(复用 pdf-parse,与 parseFile 工具同款)。 */
async function extractPdfText(
  buffer: Buffer,
): Promise<{ text: string; pages: number; title: string | null }> {
  const PDFParse = await loadPdfParseConstructor();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const textResult = await parser.getText();
    let title: string | null = null;
    try {
      const info = await parser.getInfo();
      title = info.info?.Title ?? null;
    } catch {
      /* info 取不到不影响正文 */
    }
    return { text: textResult.text ?? "", pages: textResult.total ?? 0, title };
  } finally {
    await parser.destroy();
  }
}

// 非 HTML 二进制/下载型链接的错误前缀:调用方(fetchArticle)据此判定"浏览器降级也无意义",
// 不再升级浏览器(下载型链浏览器只会触发下载,救不回正文)。
export const UNSUPPORTED_CONTENT_ERROR_PREFIX = "[unsupported-content]";

/**
 * 该响应是否"非 HTML 内容、不该按网页正文解析"(PDF/下载附件/图片/压缩包等)。
 * 把二进制喂给 cheerio.load 会爆栈(线上 .pdf 下载链 Maximum call stack);浏览器降级也只触发下载。
 * Content-Type 缺失时按宽松放行(部分服务端不带);text/* 与 html/xml 视为可解析。
 */
export function isUnsupportedForHtmlExtraction(
  contentType: string | null | undefined,
  contentDisposition?: string | null,
): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const isHtmlish = ct === "" || ct.startsWith("text/") || ct.includes("html") || ct.includes("xml");
  const isAttachment = /attachment/i.test(contentDisposition ?? "");
  return !isHtmlish || isAttachment;
}

const MAX_REDIRECTS = 5;
const MIN_EXTRACTED_TEXT_LENGTH = 40;
const MAX_FETCH_ATTEMPTS = 3;
const MAX_TIMEOUT_FETCH_ATTEMPTS = 2;
// 单次静态抓取超时 6s(原 12s 太长):慢/挂的站快速失败,交给浏览器降级或直接放弃。
const FETCH_TIMEOUT_MS = 6_000;
const FETCH_RETRY_BASE_DELAY_MS = 400;
// 静态抓取总预算硬上限 9s(用户要求外部抓取≤15s,静态留 ~9s、浏览器降级再 ~13s 内,绝不死等)。
const FETCH_TOTAL_TIMEOUT_MS = 9_000;

interface FetchRetryState {
  timeoutErrors: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fetchTimeoutError(): DOMException {
  return new DOMException(
    `Static article fetch timed out after ${FETCH_TOTAL_TIMEOUT_MS}ms`,
    "TimeoutError",
  );
}

function remainingFetchBudget(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function sleepWithinFetchBudget(
  ms: number,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const remainingMs = remainingFetchBudget(deadlineMs);
  if (remainingMs <= 0) {
    throw fetchTimeoutError();
  }
  await sleep(Math.min(ms, remainingMs), signal);
}

function isFetchTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }

  return false;
}

function isRetryableFetchError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    isFetchTimeoutError(error) ||
    error instanceof TypeError ||
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(code) ||
    /fetch failed|network|timeout|timed out|socket hang up|connection reset|econnreset|etimedout/i.test(
      message,
    )
  );
}

type PinnedFetchInit = Pick<RequestInit, "headers" | "method" | "signal">;
type PinnedFetch = (target: PinnedFetchUrl, init: PinnedFetchInit) => Promise<Response>;

function decodedResponseStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
  const decoded =
    encoding === "gzip" || encoding === "x-gzip"
      ? response.pipe(createGunzip())
      : encoding === "deflate"
        ? response.pipe(createInflate())
        : encoding === "br"
          ? response.pipe(createBrotliDecompress())
          : response;

  if (decoded !== response) {
    // Web ReadableStream 被限额逻辑 cancel 时同步拆掉上游 socket，避免后台继续下载。
    decoded.once("close", () => {
      if (!response.destroyed) response.destroy();
    });
  }
  return decoded;
}

/**
 * 使用 node:http(s) 的自定义 lookup 发起请求：URL/Host/SNI 仍保留原域名，TCP 连接只会使用
 * validateAndPinFetchUrl 已校验的地址，因此校验后不会发生第二次 DNS 解析。
 */
async function requestPinnedUrl(
  target: PinnedFetchUrl,
  init: PinnedFetchInit,
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers);
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });

    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(
      target.url,
      {
        method: init.method ?? "GET",
        headers: requestHeaders,
        lookup: createPinnedLookup(target),
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name && value !== undefined) responseHeaders.append(name, value);
          }
          const status = incoming.statusCode ?? 500;
          const hasBody = init.method !== "HEAD" && status !== 204 && status !== 304;
          const body = hasBody
            ? (Readable.toWeb(decodedResponseStream(incoming)) as unknown as BodyInit)
            : null;
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.once("error", reject);
    request.end();
  });
}

let activePinnedFetch: PinnedFetch = requestPinnedUrl;

/** 仅供 extractor 单测注入确定性响应；生产传 null 恢复固定连接实现。 */
export function __setPinnedFetchForTest(fetchImpl: PinnedFetch | null): void {
  activePinnedFetch = fetchImpl ?? requestPinnedUrl;
}

async function fetchWithRetry(
  target: PinnedFetchUrl,
  deadlineMs: number,
  retryState: FetchRetryState,
  headersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      throwIfAborted(signal);
      const remainingMs = remainingFetchBudget(deadlineMs);
      if (remainingMs <= 0) {
        throw fetchTimeoutError();
      }
      const response = await activePinnedFetch(target, {
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
            ])
          : AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...headersOverride,
        },
      });

      if (response.status >= 500 && attempt < MAX_FETCH_ATTEMPTS) {
        await response.body?.cancel().catch(() => undefined);
        await sleepWithinFetchBudget(
          FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          deadlineMs,
          signal,
        );
        continue;
      }

      return response;
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      const timeoutError = isFetchTimeoutError(error);
      if (timeoutError) {
        retryState.timeoutErrors += 1;
      }
      if (
        !isRetryableFetchError(error) ||
        attempt >= MAX_FETCH_ATTEMPTS ||
        (timeoutError && retryState.timeoutErrors >= MAX_TIMEOUT_FETCH_ATTEMPTS)
      ) {
        throw error;
      }
      await sleepWithinFetchBudget(
        FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        deadlineMs,
        signal,
      );
    }
  }

  throw lastError;
}

async function fetchWithSsrfGuard(
  url: URL,
  headersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ url: URL; response: Response }> {
  let currentUrl = url;
  const deadlineMs = Date.now() + FETCH_TOTAL_TIMEOUT_MS;
  const retryState: FetchRetryState = { timeoutErrors: 0 };
  // 跨跳维持 cookie:不少站(医脉通 CAS 网关、各类 WAF/防盗链)首跳 Set-Cookie、次跳要带 Cookie 才放行,
  // 手动重定向默认会丢 cookie → 二跳 403/连接重置。在重定向链里累积 name=value 回传。
  const cookieJar = new Map<string, string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(signal);
    const target = await validateAndPinFetchUrl(currentUrl.toString());
    throwIfAborted(signal);
    currentUrl = target.url;
    const cookieHeader = Array.from(cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const response = await fetchWithRetry(
      target,
      deadlineMs,
      retryState,
      {
        ...headersOverride,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal,
    );
    if (signal?.aborted) {
      await response.body?.cancel().catch(() => undefined);
      signal.throwIfAborted();
    }

    const setCookies =
      (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const pair = sc.split(";", 1)[0]?.trim();
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response missing Location header for ${currentUrl.toString()}`);
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    return { url: currentUrl, response };
  }

  throw new Error(`Too many redirects fetching ${url.toString()}`);
}

function contentTooLargeError(kind: "HTML" | "PDF", receivedBytes: number): Error {
  return new Error(
    `${UNSUPPORTED_CONTENT_ERROR_PREFIX} ${kind} 过大(${Math.ceil(receivedBytes / 1048576)}MB),跳过解析`,
  );
}

/** 先按 Content-Length 快拒，再边读边计数；reader.cancel 会立即拆掉底层请求。 */
async function readResponseBodyLimited(
  response: Response,
  maxBytes: number,
  kind: "HTML" | "PDF",
): Promise<Buffer> {
  const contentLengthText = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(contentLengthText)) {
    const contentLength = Number(contentLengthText);
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw contentTooLargeError(kind, contentLength);
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw contentTooLargeError(kind, totalBytes);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, totalBytes);
}

/** 放弃读取响应时主动释放底层流，避免连接长期占用。 */
async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function charsetFromContentType(contentType: string | null): string | null {
  const match = contentType?.match(/charset\s*=\s*"?([^";\s]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function charsetFromHtml(buffer: Buffer): string | null {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("latin1");
  const charsetMatch = head.match(/<meta[^>]+charset=["']?\s*([^"'\s/>]+)/i);
  if (charsetMatch?.[1]) return charsetMatch[1].toLowerCase();

  const httpEquivMatch = head.match(
    /<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([^"'\s;]+)/i,
  );
  return httpEquivMatch?.[1]?.toLowerCase() ?? null;
}

function normalizeCharset(charset: string | null): string {
  const normalized = charset?.trim().toLowerCase();
  if (!normalized || normalized === "utf8") return "utf-8";
  if (normalized === "gb2312" || normalized === "gbk" || normalized === "gb18030") {
    return "gb18030";
  }
  return normalized;
}

export function decodeHtml(buffer: Buffer, contentType: string | null): string {
  const charset = normalizeCharset(charsetFromContentType(contentType) ?? charsetFromHtml(buffer));
  if (!iconv.encodingExists(charset)) {
    return iconv.decode(buffer, "utf-8");
  }
  return iconv.decode(buffer, charset);
}

export function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metaContent($: cheerio.CheerioAPI, selector: string): string | null {
  const value = $(selector).first().attr("content")?.trim();
  return value && value.length > 0 ? value : null;
}

function resolveUrl(value: string | undefined, baseUrl: URL): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

// cheerio .text() 直接拼接所有文本节点,块级元素之间零分隔——抓出来的正文段落
// 全部糊成一坨(素材预览里表现为"没有排版堆在一起")。克隆后 br→换行、
// 块级元素尾部补换行再取文本,保住段落结构;cleanText 会把 3+ 连续换行收敛成空行。
const BLOCK_LEVEL_SELECTOR =
  "p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre,section,article,figcaption,dt,dd";

// 可靠噪声:任何情况下都删(脚本/样式/导航/页脚/表单控件/广告/分享/登录等)。
// 注意 <form> 不在此列:大量 ASP.NET WebForms / VSB CMS(.gov.cn/.edu.cn 常见)把整列正文
// 裹在服务端 <form> 里,删 form 会把正文连根删掉、只剩导航壳——只删表单"控件",保留 form 内正文。
const HARD_BOILERPLATE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "input",
  "select",
  "textarea",
  "button",
  "iframe",
  "[role=navigation]",
  "[role=banner]",
  ".nav",
  ".navbar",
  ".menu",
  ".sidebar",
  ".side-bar",
  ".header",
  ".footer",
  ".foot",
  ".top-bar",
  ".breadcrumb",
  ".comment",
  ".comments",
  ".ad",
  ".ads",
  ".advertisement",
  ".share",
  ".social",
  ".subscribe",
  ".login",
  ".copyright",
  ".tags",
  ".tag-list",
].join(",");

// 高风险"区块"选择器:可能本身就是正文容器、或裹着正文。class 是精确 token 匹配——
// class="article hot" 会被 .hot 命中;也有站点把整列正文放在 <aside> / [role=complementary] 里。
// 这些只在"自身与后代都不含任何正文容器"时才删,否则会把正文连根删掉(与 <form> 同类 footgun)。
const SOFT_BOILERPLATE_SELECTORS = [
  "aside",
  "[role=complementary]",
  ".related",
  ".recommend",
  ".recommendation",
  ".hot",
  ".rank",
];

/**
 * 剥离样板噪声但护住正文:硬噪声直接删;高风险区块只在"不裹正文容器"时才删。
 * 防 aside/.hot/.related 这类选择器把"恰好挂了该 class 的正文 wrapper"或"以 aside 作正文列"
 * 的真正文连根删掉(线上多类 .edu.cn/资讯站结构)。静态(cheerio)与浏览器(DOM)两路同构。
 */
function stripBoilerplate($: cheerio.CheerioAPI): void {
  $(HARD_BOILERPLATE_SELECTOR).remove();
  const contentSelector = BODY_SELECTOR_GROUPS.join(",");
  for (const sel of SOFT_BOILERPLATE_SELECTORS) {
    $(sel).each((_, element) => {
      const $el = $(element);
      if ($el.is(contentSelector) || $el.find(contentSelector).length > 0) return; // 裹着正文 → 保留
      $el.remove();
    });
  }
}

const BODY_SELECTOR_GROUPS = [
  "#js_content",
  ".rich_media_content",
  ".note-content",
  "#detail-desc",
  ".origin_content", // 富途牛牛 futunn
  ".article_cont", // 医脉通 medlive
  ".RichText", // 知乎专栏
  "#news_content", // 电子报(epaper.xkb 等)
  "article",
  "main",
  "[role=main]",
  ".content",
  ".post-body",
  ".article-content",
  ".article",
  ".post-content",
  ".entry-content",
  ".main-content",
  ".cont-main",
  "[itemprop=articleBody]",
  ".lemma-summary",
  ".para",
  ".show_text",
  ".text",
  ".detail",
  ".article-detail",
  ".content-article",
  ".TRS_Editor",
  ".TRS_PreAppend",
  // VSB(维斯比)CMS:大量 .edu.cn / .gov.cn 站点用它,正文恒在 #vsb_content / .v_news_content,
  // 不加这两个选择器会落到 body 抓成导航壳(线上 library.xhcom.edu.cn 真实漏网样本)。
  "#vsb_content",
  ".v_news_content",
  ".article_text",
  ".article-text",
  ".article-body",
  ".article-main",
  "#article_content",
  "#articleContent",
  "#zoom",
  ".zoom",
];

const LEADING_NAV_MARKERS = [
  "Home",
  "首页",
  "首頁",
  "全部导航",
  "全部導航",
  "网页",
  "新聞",
  "新闻",
  "频道",
  "頻道",
  "导航",
  "導航",
  "登录",
  "登入",
  "注册",
  "ENGLISH",
  "產業新聞",
  "主题快搜",
  "主題快搜",
  "新闻总览",
  "新聞總覽",
];

const CONTROL_LINE_MARKERS = [
  "登录",
  "注册",
  "登入",
  "注销",
  "退出",
  "首页",
  "搜索",
  "菜单",
  "导航",
  "当前位置",
  "您好",
  "欢迎来到",
  "资源分类",
  "分类",
  "点赞",
  "评论",
  "收藏",
  "分享",
  "关注",
  "下载App",
  "打开App",
  "App下载",
  "扫一扫",
  "返回",
  "上一页",
  "下一页",
  "更多",
  "设置",
  "充值",
  "收藏夹",
  "个人中心",
  "无障碍阅读",
  "原版阅读",
  "下载图书",
  "生成引文",
  "中文摘要",
];

const TRAILING_CONTROL_LINE_MARKERS = [
  ...CONTROL_LINE_MARKERS,
  "热门文章",
  "相关推荐",
  "相关文章",
  "推荐阅读",
  "阅读排行",
  "版权",
  "版权所有",
  "备案",
  "ICP备案",
  "ICP",
  "客户端",
  "App",
  "点击展开",
  "举报",
  "纠错",
  "相关阅读",
  "数据加载中",
  "查看全部评论",
  "本内容来自",
  "观点和立场",
  "阅读体验更佳",
  "相关图书",
  "引文",
  "复制",
  "×",
];

export function textWithBlockBreaks(
  $: cheerio.CheerioAPI,
  element: Parameters<cheerio.CheerioAPI>[0],
): string {
  const $clone = $(element).clone();
  $clone.find("br").replaceWith("\n");
  $clone.find(BLOCK_LEVEL_SELECTOR).each((_, node) => {
    $(node).append("\n");
  });
  return $clone.text();
}

function isLikelyLeadingNavLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized || normalized.length > 280) return false;

  const markerHits = LEADING_NAV_MARKERS.filter((marker) => normalized.includes(marker)).length;
  const separatorCount = normalized.match(/[|｜>/]/g)?.length ?? 0;
  const shortTokenCount = normalized
    .split(/[\s|｜>/]+/)
    .map((token) => token.replace(/[^\w\u4e00-\u9fff]/g, ""))
    .filter((token) => token.length > 0 && token.length <= 6).length;

  return markerHits >= 2 && (separatorCount >= 2 || shortTokenCount >= 6);
}

function trimLeadingNavigationLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length - 1 && start < 8 && isLikelyLeadingNavLine(lines[start] ?? "")) {
    start += 1;
  }
  return start > 0 ? lines.slice(start).join("\n").trim() : text;
}

function compactLine(line: string): string {
  return line.replace(/\s+/g, "");
}

function visibleLength(line: string): number {
  return Array.from(compactLine(line)).length;
}

function hasSentencePunctuation(line: string): boolean {
  return /[。！？!?；;]/.test(line);
}

function markerStats(line: string, markers: string[]): { hits: number; coverage: number } {
  const compact = compactLine(line);
  let hitLength = 0;
  let hits = 0;

  for (const marker of markers) {
    if (compact.includes(marker)) {
      hits += 1;
      hitLength += Array.from(marker).length;
    }
  }

  return {
    hits,
    coverage: compact.length > 0 ? hitLength / Array.from(compact).length : 0,
  };
}

function isLikelyControlLine(line: string, markers: string[], trailing: boolean): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  if (
    trailing &&
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized)
  ) {
    return true;
  }

  const length = visibleLength(normalized);
  if (length === 0 || length > (trailing ? 32 : 40)) return false;

  const { hits, coverage } = markerStats(normalized, markers);
  if (hits === 0) return false;

  const separatorCount = normalized.match(/[|｜>/／/·•,，、]/g)?.length ?? 0;
  const manyShortControls = hits >= 2 && (coverage >= 0.28 || separatorCount >= 1);
  const singleShortControl = length <= 18 && coverage >= 0.45 && !hasSentencePunctuation(normalized);
  const shortTrailingCommentPrompt = trailing && length <= 12 && normalized.includes("评论");

  return manyShortControls || singleShortControl || shortTrailingCommentPrompt;
}

function isBodyLikeLine(line: string): boolean {
  return visibleLength(line) >= 28 && hasSentencePunctuation(line);
}

function isLikelyLeadingIndexLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  const length = visibleLength(normalized);
  return length <= 120 && !hasSentencePunctuation(normalized);
}

function trimInlineLeadingControlPrefix(line: string): string {
  const segments = line.split(/\s*\/\s*/);
  if (segments.length <= 1) return line;

  const firstBodySegment = segments.findIndex((segment) => isBodyLikeLine(segment));
  if (firstBodySegment <= 0) return line;

  return segments.slice(firstBodySegment).join(" / ").trim();
}

function isProtectedRemovedLine(line: string): boolean {
  return visibleLength(line) >= 30 && hasSentencePunctuation(line);
}

function shouldKeepTrimmedText(original: string, trimmed: string, removedLines: string[]): boolean {
  const originalLength = compactLine(original).length;
  const trimmedLength = compactLine(trimmed).length;
  if (originalLength > 0 && trimmedLength < originalLength * 0.3) return false;
  return !removedLines.some(isProtectedRemovedLine);
}

export function trimArticleBoilerplateLines(text: string): string {
  const original = cleanText(text);
  if (!original) return original;

  const lines = original.split("\n");
  let start = 0;
  const removed: string[] = [];
  let controlPrefixStarted = false;

  while (
    start < lines.length - 1 &&
    start < 360 &&
    (isLikelyControlLine(lines[start] ?? "", CONTROL_LINE_MARKERS, false) ||
      (controlPrefixStarted &&
        isLikelyLeadingIndexLine(lines[start] ?? "") &&
        !isBodyLikeLine(lines[start] ?? "")))
  ) {
    if (isLikelyControlLine(lines[start] ?? "", CONTROL_LINE_MARKERS, false)) {
      controlPrefixStarted = true;
    }
    removed.push(lines[start] ?? "");
    start += 1;
  }

  let end = lines.length;
  while (
    end > start + 1 &&
    lines.length - end < 24 &&
    isLikelyControlLine(lines[end - 1] ?? "", TRAILING_CONTROL_LINE_MARKERS, true)
  ) {
    removed.push(lines[end - 1] ?? "");
    end -= 1;
  }

  const outputLines = lines.slice(start, end);
  if (controlPrefixStarted && outputLines[0]) {
    outputLines[0] = trimInlineLeadingControlPrefix(outputLines[0]);
  }

  if (start === 0 && end === lines.length && outputLines[0] === lines[0]) return original;

  const trimmed = cleanText(outputLines.join("\n"));
  return shouldKeepTrimmedText(original, trimmed, removed) ? trimmed : original;
}

function trimBodyFallbackPrefix($: cheerio.CheerioAPI, bodyText: string): string {
  const headings = $("h1")
    .toArray()
    .map((element) => cleanText(textWithBlockBreaks($, element)))
    .filter((text) => text.replace(/\s+/g, "").length >= 8)
    .sort((a, b) => b.length - a.length);

  for (const heading of headings) {
    const start = bodyText.indexOf(heading);
    if (start > 0 && start < 6000) {
      const trimmedFromHeading = bodyText.slice(start).trim();
      if (compactLine(trimmedFromHeading).length >= compactLine(bodyText).length * 0.3) {
        return trimArticleBoilerplateLines(trimmedFromHeading);
      }
    }
  }

  return trimArticleBoilerplateLines(trimLeadingNavigationLines(bodyText));
}

export function selectBodyText(
  $: cheerio.CheerioAPI,
  waitForSelector?: string,
  extraSelectors?: string[],
): string {
  const $extract = cheerio.load($.root().html() ?? "");
  stripBoilerplate($extract);
  const selectorGroups = [
    waitForSelector,
    ...(extraSelectors ?? []),
    ...BODY_SELECTOR_GROUPS,
  ].filter((selector): selector is string => Boolean(selector));

  const candidates = selectorGroups
    .flatMap((selector) =>
      $extract(selector)
        .toArray()
        .map((element) =>
          trimBodyFallbackPrefix($extract, cleanText(textWithBlockBreaks($extract, element))),
        ),
    )
    .filter((text) => text.length > 0);

  if (candidates.length > 0) {
    return candidates.sort((a, b) => b.length - a.length)[0] ?? "";
  }

  return trimBodyFallbackPrefix($extract, cleanText(textWithBlockBreaks($extract, "body")));
}

/**
 * PubMed Central(PMC)正文页 HTML 命中 Google reCAPTCHA 拿不到正文,但 NCBI 官方 EFetch
 * 接口返回完整 JATS XML 全文(公开、稳定)。从 URL 抽 PMCID 走 EFetch + cheerio xmlMode 解析。
 */
async function tryExtractPmc(
  parsedUrl: URL,
  signal?: AbortSignal,
): Promise<ExtractedArticleContent | null> {
  if (!/(^|\.)ncbi\.nlm\.nih\.gov$/.test(parsedUrl.hostname)) return null;
  const m = parsedUrl.pathname.match(/\/articles\/PMC(\d+)/i);
  if (!m) return null;
  try {
    const efetchUrl = parseFetchUrl(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${m[1]}&rettype=xml&retmode=xml`,
    );
    const { response } = await fetchWithSsrfGuard(efetchUrl, undefined, signal);
    if (!response.ok) {
      await cancelResponseBody(response);
      return null;
    }
    const xml = (await readResponseBodyLimited(response, MAX_HTML_BYTES, "HTML")).toString("utf-8");
    const $x = cheerio.load(xml, { xmlMode: true });
    const title = cleanText($x("article-title").first().text());
    const paras = $x("abstract p, body p")
      .toArray()
      .map((el) => cleanText($x(el).text()))
      .filter((t) => t.length > 0);
    const body = paras.join("\n\n");
    if (body.replace(/\s+/g, "").length < MIN_EXTRACTED_TEXT_LENGTH) return null;
    return { title: title || parsedUrl.hostname, body, images: [], screenshot: null, ogImageUrl: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null; // EFetch 失败则回落到常规抓取
  }
}

export async function extractArticleContent(
  url: string,
  waitForSelector?: string,
  signal?: AbortSignal,
): Promise<ExtractedArticleContent> {
  throwIfAborted(signal);
  const parsedUrl = parseFetchUrl(url);
  // PMC 走官方 EFetch JATS XML(HTML 页有 reCAPTCHA)。命中则直接返回全文。
  const pmc = await tryExtractPmc(parsedUrl, signal);
  throwIfAborted(signal);
  if (pmc) return pmc;
  // 站点适配器:已知"PC 反爬、移动端可抓"的站(百度百科/什么值得买等),改写到移动子域 + 移动 UA,
  // 并追加站点正文选择器,从根上把 403/空壳变成可抓的 SSR 正文。
  const adapter = resolveSiteAdapter(parsedUrl);
  const initialUrl = adapter?.rewriteUrl ? adapter.rewriteUrl(parsedUrl) : parsedUrl;
  const { url: finalUrl, response } = await fetchWithSsrfGuard(
    initialUrl,
    adapter?.headers,
    signal,
  );
  if (signal?.aborted) {
    await cancelResponseBody(response);
    signal.throwIfAborted();
  }

  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`Failed to fetch ${finalUrl.toString()}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  const ctLower = (contentType ?? "").toLowerCase();
  // PDF 是可解析的(有文本)——路由到 pdf-parse 提取正文,而不是当"不支持"拒掉
  //(目标:搜索链路 100% 解析率。论文/报告类结果常是 PDF)。按 Content-Type 或 .pdf 路径判定。
  const isPdf = ctLower.includes("pdf") || /\.pdf(\?|#|$)/i.test(finalUrl.pathname);
  if (isPdf) {
    const buf = await readResponseBodyLimited(response, MAX_PDF_BYTES, "PDF");
    throwIfAborted(signal);
    const { text, title: pdfTitle } = await extractPdfText(buf);
    throwIfAborted(signal);
    const body = trimArticleBoilerplateLines(cleanText(text.replace(/\f/g, "\n\n")));
    if (body.replace(/\s+/g, "").length < MIN_EXTRACTED_TEXT_LENGTH) {
      // 文本过少:多为扫描件/图片型 PDF(无文本层),按解析失败处理。
      throw new Error(
        "PDF 解析出的正文过少(疑似扫描件/图片型 PDF,无文本层),无法提取正文。",
      );
    }
    return {
      title: cleanText(pdfTitle ?? "") || finalUrl.hostname,
      body,
      images: [],
      screenshot: null,
      ogImageUrl: null,
    };
  }
  // 其它非 HTML 二进制(下载附件 / 图片 / 压缩包等)不能喂给 cheerio——会爆栈,浏览器降级也救不了。
  if (isUnsupportedForHtmlExtraction(contentType, response.headers.get("content-disposition"))) {
    await cancelResponseBody(response);
    throw new Error(
      `${UNSUPPORTED_CONTENT_ERROR_PREFIX} 非 HTML 内容(${contentType || "下载附件"}),无法按网页正文解析`,
    );
  }
  const bodyBuffer = await readResponseBodyLimited(response, MAX_HTML_BYTES, "HTML");
  throwIfAborted(signal);
  const html = decodeHtml(bodyBuffer, contentType);
  const $ = cheerio.load(html);

  if (isWechatArticleUrl(finalUrl.toString())) {
    try {
      const wechatArticle = extractWechatArticle(html, finalUrl.toString());
      if (wechatArticle.markdown.length >= MIN_EXTRACTED_TEXT_LENGTH) {
        const fallbackTitle =
          cleanText($("title").first().text()) ||
          metaContent($, 'meta[property="og:title"]') ||
          metaContent($, 'meta[name="og:title"]') ||
          finalUrl.hostname;
        return {
          title: wechatArticle.title || fallbackTitle,
          body: wechatArticle.markdown,
          images: wechatArticle.images,
          screenshot: null,
          ogImageUrl: resolveUrl(
            metaContent($, 'meta[property="og:image"]') ??
              metaContent($, 'meta[name="og:image"]') ??
              metaContent($, 'meta[property="twitter:image"]') ??
              metaContent($, 'meta[name="twitter:image"]') ??
              undefined,
            finalUrl,
          ),
        };
      }
    } catch {
      // 微信专用清洗失败时回落通用抽取,避免单站适配 bug 吞掉可用正文。
    }
  }

  $("script, style, noscript, nav, footer, header").remove();

  const title =
    cleanText($("title").first().text()) ||
    metaContent($, 'meta[property="og:title"]') ||
    metaContent($, 'meta[name="og:title"]') ||
    finalUrl.hostname;

  const body = selectBodyText($, waitForSelector, adapter?.extraSelectors);
  if (body.length < MIN_EXTRACTED_TEXT_LENGTH) {
    throw new Error(
      "Could not extract enough article text from static HTML. This page may require JavaScript rendering; please copy-paste the content manually.",
    );
  }

  const images = $("img[src]")
    .toArray()
    .map((img) => {
      const src = resolveUrl($(img).attr("src"), finalUrl);
      if (!src) return null;
      return { src, alt: $(img).attr("alt") ?? null };
    })
    .filter((item): item is { src: string; alt: string | null } => item !== null);

  const ogImageUrl = resolveUrl(
    metaContent($, 'meta[property="og:image"]') ??
      metaContent($, 'meta[name="og:image"]') ??
      metaContent($, 'meta[property="twitter:image"]') ??
      metaContent($, 'meta[name="twitter:image"]') ??
      undefined,
    finalUrl,
  );

  return {
    title,
    body,
    images,
    screenshot: null,
    ogImageUrl,
  };
}

import {
  resolveSiteAdapter,
  trimArticleBoilerplateLines,
  validateFetchUrl,
} from "./extractor.js";
import { isSubstantiveContent } from "./contentQuality.js";
import { extractWechatArticle, isWechatArticleUrl } from "./wechatArticle.js";
import { getBrowser, proxyFromEnv, withBrowserContextSlot } from "./pool.js";
import {
  browserErrorMessage,
  formatBrowserUnavailableError,
  isBrowserAvailabilityError,
} from "./browserErrors.js";
import { persistScreenshot } from "./persistScreenshot.js";
import {
  BROWSER_SECURITY_CONTEXT_OPTIONS,
  installBrowserRequestPolicy,
} from "./browserSecurity.js";

const MIN_TEXT = 40;
// 30s:慢/重页面(政务、大列表、富媒体资讯)20s 到不了 domcontentloaded 会超时丢失;
// 调用方工具心跳会覆盖 idle 看门狗。仍有总预算上限,不会无限等。
const DEFAULT_NAVIGATION_TIMEOUT_MS = 18_000;

export type ScrapeResult = {
  ok: boolean;
  error: string | null;
  title: string;
  text: string;
  wordCount: number;
  images: { src: string; alt: string | null }[];
  screenshotSrc: string | null;
  ogImageUrl: string | null;
};

export async function scrapeWithBrowserImpl(
  url: string,
  opts?: { waitForSelector?: string; signal?: AbortSignal },
): Promise<ScrapeResult> {
  const fail = (error: string): ScrapeResult => {
    // 关键:浏览器启动/导航失败的真因往往被吞进返回值(模型能看到、但 stdout 看不到),
    // 排查时只能靠猜。这里把 fail 原因打到 stdout,客户端日志可直接定位。
    console.warn(`[scrapeWithBrowser] 抓取失败 url=${url} 原因=${error}`);
    return {
      ok: false,
      error,
      title: "抓取失败",
      text: `[Error] ${error}`,
      wordCount: 0,
      images: [],
      screenshotSrc: null,
      ogImageUrl: null,
    };
  };

  let finalUrl: URL;
  try {
    opts?.signal?.throwIfAborted();
    finalUrl = await validateFetchUrl(url);
    opts?.signal?.throwIfAborted();
  } catch (error) {
    if (opts?.signal?.aborted) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }

  return withBrowserContextSlot(async () => {
    let context: import("playwright").BrowserContext | null = null;
    const closeOnAbort = () => {
      void context?.close().catch(() => undefined);
    };
    opts?.signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      opts?.signal?.throwIfAborted();
      const browser = await getBrowser();
      opts?.signal?.throwIfAborted();
      // UA 与 sec-ch-ua 客户端提示必须一致、且不能暴露 "HeadlessChrome"——否则知乎等会据此判机器人
      //(实测:headless 默认带 sec-ch-ua: "...HeadlessChrome...",知乎 302 到 account/unhuman;
      // 仅把 sec-ch-ua 改成 "Google Chrome" 就放行、拿到 .RichText 全文。这是通用反检测,非只为知乎)。
      const chromeVersion = browser.version() || "120.0.0.0";
      const chromeMajor = chromeVersion.split(".")[0] || "120";
      // 部分站(太平洋电脑网等)正文只在移动端上下文渲染——桌面渲染只得壳。站点适配器标了
      // mobileBrowser 就用移动 emulation(iPhone UA + 移动视口 + sec-ch-ua-mobile)。
      const useMobile = resolveSiteAdapter(finalUrl)?.mobileBrowser ?? false;
      const mobileUA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
      context = await browser.newContext({
        userAgent: useMobile
          ? mobileUA
          : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
            `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
        ...(useMobile
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
          : {}),
        locale: "zh-CN",
        extraHTTPHeaders: {
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "sec-ch-ua": `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not=A?Brand";v="99"`,
          "sec-ch-ua-mobile": useMobile ? "?1" : "?0",
          "sec-ch-ua-platform": useMobile ? '"Android"' : '"Windows"',
        },
        // 这是只读公开内容抓取器，不发送凭据或敏感数据。下方逐请求 SSRF guard
        // 仍会在每个 http(s) 请求前拦截内网、本机和云元数据地址；忽略 HTTPS 证书
        // 错误只放宽服务器身份认证，不放宽 SSRF 边界。权衡是挽回大量证书配置不当的
        // 合法 CN 政府/新闻子站；MITM 读到错误内容的风险很低，且抓取内容本就按不可信处理。
        ignoreHTTPSErrors: true,
        ...BROWSER_SECURITY_CONTEXT_OPTIONS,
      });
      opts?.signal?.throwIfAborted();
      await context.addInitScript(() => {
        // tsx/esbuild 注入的 __name helper 在浏览器上下文不存在，补一个兜底，避免 page.evaluate 崩。
        (globalThis as unknown as { __name?: (fn: unknown) => unknown }).__name ||= (fn) => fn;
        // —— 反检测 stealth:headless Chromium 的默认指纹(webdriver/缺 chrome/空 plugins 等)会被
        // baike/zhihu/smzdm 等反爬识别为爬虫、只返回登录墙或空壳。逐项抹平常见检测向量。
        try {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        } catch {
          /* 某些环境只读,忽略 */
        }
        try {
          if (!(window as unknown as { chrome?: unknown }).chrome) {
            (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
          }
        } catch {
          /* ignore */
        }
        try {
          Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
        } catch {
          /* ignore */
        }
        try {
          // headless 下 navigator.plugins 为空数组——填充非空,避免被当机器人。
          Object.defineProperty(navigator, "plugins", {
            get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
          });
        } catch {
          /* ignore */
        }
        try {
          const perms = navigator.permissions as unknown as {
            query?: (d: { name: string }) => Promise<unknown>;
          };
          const orig = perms?.query?.bind(navigator.permissions);
          if (orig) {
            perms.query = (d: { name: string }) =>
              d && d.name === "notifications"
                ? Promise.resolve({ state: Notification.permission } as unknown)
                : orig(d);
          }
        } catch {
          /* ignore */
        }
      });

      const proxyConfigured = Boolean(proxyFromEnv());
      await installBrowserRequestPolicy(context, {
        // Node 固定 IP 回填无法继承 Chromium 的外部代理链；代理部署继续由浏览器发请求，
        // 保留逐请求校验但仍有二次 DNS 的 TOCTOU 窗口。无代理时普通资源全部固定 IP 回填。
        pinHttpRequests: !proxyConfigured,
        // 文章抓取只提取静态 DOM；代理部署下同样阻断无需使用的长连接与媒体流。
        blockStreamingResources: true,
      });
      const page = await context.newPage();
      opts?.signal?.throwIfAborted();

      // 整个浏览器抓取硬预算(用户要求外部抓取≤15s):默认 13s,留 ~2s 给提取/截图。
      // 每一步都从"剩余预算"取时间,预算用完立刻收手提取现有内容——绝不死等。
      // 极硬/极慢的站(Anubis 需 ~15s 的那种)会在预算内放弃,这是为了交互速度的明确取舍。
      const SCRAPE_BUDGET_MS = Math.min(12_000, DEFAULT_NAVIGATION_TIMEOUT_MS);
      const deadline = Date.now() + SCRAPE_BUDGET_MS;
      const left = () => Math.max(0, deadline - Date.now());

      // 短超时 + 退一档重试:domcontentloaded 撞超时/连接重置就退到 "commit"(只等导航提交)再试一次,
      // 内容靠后面的 waitForSelector/networkidle/挑战自解补齐。不一次性死等。
      try {
        await page.goto(finalUrl.toString(), {
          waitUntil: "domcontentloaded",
          timeout: Math.min(8000, Math.max(1500, left())),
        });
      } catch (gotoErr) {
        const msg = gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
        if (/Timeout|ERR_CONNECTION|ERR_EMPTY_RESPONSE|net::|reset/i.test(msg) && left() > 1200) {
          await page
            .goto(finalUrl.toString(), { waitUntil: "commit", timeout: Math.min(3000, left()) })
            .catch(() => {});
        } else {
          throw gotoErr;
        }
      }
      opts?.signal?.throwIfAborted();

      // Defense-in-depth: redirect chain 可能落到别的 host,提取前重新校验落地 URL。
      await validateFetchUrl(page.url());

      if (opts?.waitForSelector && left() > 800) {
        await page.waitForSelector(opts.waitForSelector, { timeout: Math.min(3000, left()) }).catch(() => {});
      }
      if (left() > 800) {
        await page.waitForLoadState("networkidle", { timeout: Math.min(2500, left()) }).catch(() => {});
      }

      // 反爬 JS 挑战 / SPA 薄壳:用"剩余预算"等其渲染/自解出正文(已有 ≥300 字则不进此分支、零等待;
      // 预算内自解不完就放弃,不超过总预算)。真机:Anubis/futunn 多在数秒内解完。
      const CHALLENGE_RE =
        /Anubis|Proof-of-Work|正在确认你是不是机器人|请启用\s*JavaScript|Just a moment|Checking your browser|making sure you'?re not a bot|安全验证|JavaScript is (required|disabled)/i;
      const initialText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (
        (CHALLENGE_RE.test(initialText) || initialText.replace(/\s+/g, "").length < 300) &&
        left() > 1500
      ) {
        await page
          .waitForFunction(
            (reSrc) => {
              const re = new RegExp(reSrc, "i");
              const t = document.body?.innerText ?? "";
              return t.replace(/\s+/g, "").length > 250 && !re.test(t);
            },
            CHALLENGE_RE.source,
            { timeout: left(), polling: 800 },
          )
          .catch(() => {});
        await validateFetchUrl(page.url());
      }

      const extracted = await page.evaluate(() => {
        // 可靠噪声:任何情况下都删。不含 <form>(只删表单控件,保住 form 内正文,与静态路对齐)。
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
        // 高风险"区块"选择器:可能本身就是正文容器或裹着正文(class="article hot" 命中 .hot、
        // 整列正文放 <aside> 等)。只在"自身与后代都不含正文容器"时才删,否则会把正文连根删掉。
        const SOFT_BOILERPLATE_SELECTORS = [
          "aside",
          "[role=complementary]",
          ".related",
          ".recommend",
          ".recommendation",
          ".hot",
          ".rank",
        ];
        const SELECTORS = [
          "#js_content",
          ".rich_media_content",
          ".note-content",
          "#detail-desc",
          ".origin_content", // 富途牛牛 futunn 正文
          ".inner.origin_content",
          ".article_cont", // 医脉通 medlive 正文
          ".RichText", // 知乎专栏正文(过反爬后)
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
          // VSB(维斯比)CMS:大量 .edu.cn / .gov.cn 站点正文恒在 #vsb_content / .v_news_content,
          // 不加会落到 body 抓成导航壳(线上 library.xhcom.edu.cn 真实漏网)。静态/浏览器两路对齐。
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
        const clean = (text: string) =>
          text
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        const isLikelyLeadingNavLine = (line: string) => {
          const normalized = line.trim();
          if (!normalized || normalized.length > 280) return false;

          const markerHits = LEADING_NAV_MARKERS.filter((marker) =>
            normalized.includes(marker),
          ).length;
          const separatorCount = normalized.match(/[|｜>/]/g)?.length ?? 0;
          const shortTokenCount = normalized
            .split(/[\s|｜>/]+/)
            .map((token) => token.replace(/[^\w\u4e00-\u9fff]/g, ""))
            .filter((token) => token.length > 0 && token.length <= 6).length;

          return markerHits >= 2 && (separatorCount >= 2 || shortTokenCount >= 6);
        };
        const trimLeadingNavigationLines = (text: string) => {
          const lines = text.split("\n");
          let start = 0;
          while (
            start < lines.length - 1 &&
            start < 8 &&
            isLikelyLeadingNavLine(lines[start] ?? "")
          ) {
            start += 1;
          }
          return start > 0 ? lines.slice(start).join("\n").trim() : text;
        };
        const trimBodyFallbackPrefix = (bodyText: string) => {
          const headings = Array.from(document.querySelectorAll("h1"))
            .map((element) => clean((element as HTMLElement).innerText || ""))
            .filter((text) => text.replace(/\s+/g, "").length >= 8)
            .sort((a, b) => b.length - a.length);

          for (const heading of headings) {
            const start = bodyText.indexOf(heading);
            // 窗口与静态路对齐(6000),避免"前置导航很长"时一路裁得掉、另一路裁不掉。
            if (start > 0 && start < 6000) {
              return bodyText.slice(start).trim();
            }
          }

          return trimLeadingNavigationLines(bodyText);
        };
        const CONTENT_SELECTOR = SELECTORS.join(",");
        document.querySelectorAll(HARD_BOILERPLATE_SELECTOR).forEach((element) => {
          element.remove();
        });
        // 高风险区块只在不裹正文容器时才删,否则会把正文连根删掉(aside/.hot/.related 等)。
        for (const sel of SOFT_BOILERPLATE_SELECTORS) {
          document.querySelectorAll(sel).forEach((element) => {
            if (element.matches(CONTENT_SELECTOR) || element.querySelector(CONTENT_SELECTOR)) return;
            element.remove();
          });
        }
        const candidates = SELECTORS.flatMap((selector) =>
          Array.from(document.querySelectorAll(selector)),
        )
          .map((element) =>
            trimBodyFallbackPrefix(clean((element as HTMLElement).innerText || "")),
          )
          .filter((text) => text.length > 0);
        const body =
          candidates.length > 0
            ? candidates.sort((a, b) => b.length - a.length)[0] ?? ""
            : trimBodyFallbackPrefix(clean(document.body?.innerText || ""));
        const meta = (selector: string) =>
          (document.querySelector(selector) as HTMLMetaElement | null)?.content || null;
        const title =
          clean(document.title) ||
          meta('meta[property="og:title"]') ||
          location.hostname;
        const ogImageUrl =
          meta('meta[property="og:image"]') ||
          meta('meta[name="twitter:image"]');
        const images = Array.from(document.querySelectorAll("img[src]"))
          .map((img) => ({
            src: (img as HTMLImageElement).src,
            alt: (img as HTMLImageElement).getAttribute("alt"),
          }))
          .filter((image) => image.src);
        return { title, body, ogImageUrl, images };
      });
      opts?.signal?.throwIfAborted();

      // 微信公众号文章:用渲染后 HTML 过专用清洗器(输出 Markdown + data-src 懒加载图),
      // 与静态路对齐——避免大页(常 3MB+)走浏览器降级时退回纯文本、漏掉全部配图。
      if (isWechatArticleUrl(finalUrl.toString())) {
        try {
          const wxHtml = await page.content();
          const wx = extractWechatArticle(wxHtml, finalUrl.toString());
          if (wx.markdown.replace(/\s+/g, "").length >= MIN_TEXT) {
            const wxShot = await page
              .screenshot({ fullPage: false, type: "jpeg", quality: 80 })
              .catch(() => null);
            opts?.signal?.throwIfAborted();
            const wxShotSrc = wxShot ? await persistScreenshot(wxShot, opts?.signal) : null;
            return {
              ok: true,
              error: null,
              title: wx.title || extracted.title,
              text: wx.markdown,
              wordCount: wx.markdown.replace(/\s+/g, "").length,
              images: wx.images,
              screenshotSrc: wxShotSrc,
              ogImageUrl: extracted.ogImageUrl,
            };
          }
        } catch (error) {
          if (opts?.signal?.aborted) throw error;
          // 微信专用清洗失败 → 回落通用抽取,不吞掉可用正文。
        }
      }

      const body = trimArticleBoilerplateLines(extracted.body);
      const wordCount = body.replace(/\s+/g, "").length;
      if (wordCount < MIN_TEXT) {
        return fail("Rendered page still has too little text (login wall / anti-bot / empty).");
      }
      // 浏览器是最后一道:即便渲染出几百字,若只是标题+导航/分享控件拼出的空洞壳
      //(动态站常见),也按解析失败处理——不把空洞内容当正文交回去落库。
      if (!isSubstantiveContent(body)) {
        return fail("Rendered page is a hollow shell (nav/share controls only, no substantive article text).");
      }
      const screenshot = await page
        .screenshot({ fullPage: false, type: "jpeg", quality: 80 })
        .catch(() => null);
      opts?.signal?.throwIfAborted();
      const screenshotSrc = screenshot
        ? await persistScreenshot(screenshot, opts?.signal)
        : null;
      return {
        ok: true,
        error: null,
        title: extracted.title,
        text: body,
        wordCount,
        images: extracted.images.map((image) => ({ src: image.src, alt: image.alt })),
        screenshotSrc,
        ogImageUrl: extracted.ogImageUrl,
      };
    } catch (error) {
      if (opts?.signal?.aborted) throw error;
      return fail(
        isBrowserAvailabilityError(error)
          ? formatBrowserUnavailableError(error)
          : browserErrorMessage(error),
      );
    } finally {
      opts?.signal?.removeEventListener("abort", closeOnAbort);
      await context?.close().catch(() => {});
    }
  }, opts?.signal);
}

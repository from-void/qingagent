import type { Browser } from "playwright";
import {
  BrowserCapabilityUnavailableError,
  getBrowser,
  getBrowserCapabilityState,
} from "../browser/pool.js";
import { getHtmlToPdfRenderer } from "./pdfRenderer.js";

/**
 * 用 headless Chromium 把一份自包含 HTML(toHtml 生成,样式与字体全部内联)打印成 PDF。
 *
 * 优先用注册的自定义渲染器(桌面端注入 Electron printToPDF,复用自带 Chromium);未注册时
 * 回退到 browser/pool.ts 的全局 Playwright 浏览器单例(VPS 上已随 scrapeWithBrowser 装好
 * Chromium)。HTML 自包含、图片/图表全部内联为 data URI / 内联 SVG,故渲染不需要任何网络;
 * 这里把页面的对外请求全部拦截掉,既防 SSRF 又避免外部资源拖慢/卡住打印。
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const custom = getHtmlToPdfRenderer();
  if (custom) return custom(html);

  if (getBrowserCapabilityState().status === "unavailable") {
    throw new BrowserCapabilityUnavailableError();
  }
  const browser: Browser = await getBrowser();
  const context = await browser.newContext();
  // 拦截一切对外请求:自包含 HTML 不需要联网,放行只剩风险与延迟。
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url === "about:blank") {
      void route.continue();
    } else {
      void route.abort();
    }
  });
  const page = await context.newPage();
  try {
    // 内联资源无网络等待,load 即可;给本地字体/布局留出充足上限。
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    // 等字体就绪,避免首屏用回退字体抢跑导致排版漂移。用字符串表达式形式调用,既能在浏览器上下文
    // 访问 document.fonts,又不让这段 DOM 代码参与 node 侧 tsconfig 的类型检查(desktop 用 node lib)。
    await page.evaluate("document.fonts ? document.fonts.ready : null").catch(() => undefined);
    // 页面尺寸与上下页边距由 CSS @page 控制(preferCSSPageSize),保证分页留白逐页生效、
    // 内容不贴边;printBackground 让根元素奶白纸背景铺满整页(含页边距区)。
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await context.close().catch(() => undefined);
  }
}

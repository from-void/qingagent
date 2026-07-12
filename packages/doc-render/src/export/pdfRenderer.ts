/**
 * PDF 渲染器可注入缝:默认走 Playwright headless Chromium(htmlToPdf.ts),
 * 但桌面端没有随包分发 Playwright Chromium,会硬失败到 500。桌面主进程可在启动时
 * 注册一个基于 Electron 自带 Chromium(webContents.printToPDF)的渲染器,复用已内置的
 * Chromium、零增量体积。
 *
 * 设计为「一个全局可选渲染器」:set 注册、get 取用、htmlToPdf 优先用注册的,没有则回退
 * Playwright。纯函数边界,便于单测(注册一个假渲染器即可验证优先级与回退)。
 */

/** 把一份自包含 HTML 打印成 PDF 字节。 */
export type HtmlToPdfRenderer = (html: string) => Promise<Buffer>;

let customRenderer: HtmlToPdfRenderer | null = null;

/** 注册自定义 PDF 渲染器(桌面端注入 Electron printToPDF);传 null 取消注册。 */
export function setHtmlToPdfRenderer(renderer: HtmlToPdfRenderer | null): void {
  customRenderer = renderer;
}

/** 取当前注册的自定义渲染器;未注册返回 null(调用方回退 Playwright)。 */
export function getHtmlToPdfRenderer(): HtmlToPdfRenderer | null {
  return customRenderer;
}

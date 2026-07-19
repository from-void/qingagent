import { decodeSvgDataUrl } from "@qingagent/pm-schema";
import { getBrowser, withBrowserContextSlot } from "../browser/pool.js";
import { hardenInlineSvg } from "../browser/svgSanitize.js";
import { katexCssEmbedded, renderMathHtml } from "./exportAssets.js";
import { MAX_EXPORT_SVG_BYTES } from "./shared.js";

/**
 * 给缺 width/height 的 SVG 从 viewBox 注入显式尺寸。
 * 修 export-docx-image-lost:AI 生成的配图常是 `<svg viewBox="0 0 800 800">` 无 width/height,
 * 放进 inline-block 容器时 intrinsic 尺寸塌成 0 → boundingBox<1 → 栅格化返回 null → docx 丢图。
 * 从 viewBox 的 w/h 补上显式 width/height,容器即可量到真实尺寸。已有显式尺寸的(如 mermaid)原样返回。
 */
export function ensureSvgDimensions(svg: string): string {
  const openMatch = svg.match(/<svg\b[^>]*>/i);
  if (!openMatch) return svg;
  const open = openMatch[0];
  const hasWidth = /\swidth\s*=/i.test(open);
  const hasHeight = /\sheight\s*=/i.test(open);
  if (hasWidth && hasHeight) return svg;
  const vb = open.match(
    /\sviewBox\s*=\s*["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.+-]+)\s+([\d.+-]+)\s*["']/i,
  );
  if (!vb) return svg;
  const w = Number.parseFloat(vb[1]!);
  const h = Number.parseFloat(vb[2]!);
  if (!(w > 0) || !(h > 0)) return svg;
  const inject = `${hasWidth ? "" : ` width="${w}"`}${hasHeight ? "" : ` height="${h}"`}`;
  const injectedOpen = open.replace(/<svg\b/i, `<svg${inject}`);
  return svg.replace(open, injectedOpen);
}

/**
 * SVG 栅格化的唯一准备入口：data URL 先统一解码，原始/解码后的 SVG 再统一净化，
 * 最后补齐可推断的尺寸。任何一步失败都返回 null，调用方据此降级，绝不把原文送进 setContent。
 */
export function prepareSvgForRasterization(input: string): string | null {
  const raw = /^data:image\/svg\+xml/i.test(input) ? decodeSvgDataUrl(input) : input;
  if (!raw) return null;
  const safe = hardenInlineSvg(raw, { maxBytes: MAX_EXPORT_SVG_BYTES });
  return safe ? ensureSvgDimensions(safe) : null;
}

export type MathRasterResult = { data: Buffer; width: number; height: number };

/**
 * 批量把多个 LaTeX 公式渲染成 PNG(白底)。
 * 单个 Chromium 上下文 + 单次 setContent,所有公式在一个页面里渲染后逐元素截图,
 * 避免 N 次上下文开关的开销(对含 50+ 公式的大文档尤其重要)。
 * displayMode=true 为块级居中样式(24px 字号),false 为行内随文(16px 字号)。
 * 失败的公式返回 null,调用方降级为等宽文本。
 */
export async function rasterizeMathBatch(
  formulas: Array<{ latex: string; displayMode: boolean }>,
): Promise<Array<MathRasterResult | null>> {
  if (formulas.length === 0) return [];

  const css = katexCssEmbedded();
  // 每个公式在独立 div 里渲染,用 id="m${i}" 定位截图。
  const items = formulas.map(({ latex, displayMode }, i) => {
    const html = renderMathHtml(latex, displayMode) ?? "";
    const fontSize = displayMode ? 24 : 16;
    const padding = displayMode ? "8px 16px" : "0";
    return `<div id="m${i}" style="display:inline-block;font-size:${fontSize}px;padding:${padding};line-height:1.4;white-space:nowrap">${html}</div>`;
  });

  const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{background:#fff;}</style><style>${css}</style></head><body>${items.join("\n")}</body></html>`;

  return withBrowserContextSlot(async () => {
    let browser;
    try {
      browser = await getBrowser();
    } catch {
      return formulas.map(() => null);
    }
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") void route.continue();
      else void route.abort();
    });
    const page = await context.newPage();
    try {
      await page.setContent(pageHtml, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate("document.fonts ? document.fonts.ready : null").catch(() => undefined);

      // 并发截图:先批量拿 ElementHandle,再 Promise.all 并发截图,避免串行 N × RTT 开销。
      const handles = await Promise.all(formulas.map(async (_, i) => {
        try { return await page.$(`#m${i}`); } catch { return null; }
      }));
      const results: Array<MathRasterResult | null> = await Promise.all(
        handles.map(async (el) => {
          if (!el) return null;
          try {
            const box = await el.boundingBox();
            if (!box || box.width < 1 || box.height < 1) return null;
            const data = Buffer.from(await el.screenshot({ type: "png", omitBackground: false }));
            return { data, width: Math.round(box.width), height: Math.round(box.height) };
          } catch {
            return null;
          }
        }),
      );
      return results;
    } catch {
      return formulas.map(() => null);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

/**
 * 用 headless Chromium 把一段 SVG 栅格化成 PNG(白底)。
 * 用途:DOCX 不能可靠渲染 SVG / mermaid 图表,把它们转成 PNG 图片嵌入更稳。
 * 复用全局浏览器池;拦截一切外部请求(SVG 自包含,无需联网)。失败返回 null,调用方回退。
 */
export async function rasterizeSvgToPng(
  svg: string,
  options: { scale?: number; maxWidth?: number } = {},
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const safeSvg = prepareSvgForRasterization(svg);
  if (!safeSvg) return null;
  const scale = options.scale ?? 2;
  return withBrowserContextSlot(async () => {
    let browser;
    try {
      browser = await getBrowser();
    } catch {
      return null; // 无 Chromium → 调用方回退(svg 图/图表退回源码或占位)
    }
    const context = await browser.newContext({ deviceScaleFactor: scale });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") void route.continue();
      else void route.abort();
    });
    const page = await context.newPage();
    try {
      // inline-block + 白底:截图只裁到 svg 自身尺寸;DOCX 页面为白,背景用白最自然。
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}html,body{background:#fff}#wrap{display:inline-block}#wrap svg{display:block}</style></head><body><div id="wrap">${safeSvg}</div></body></html>`,
        { waitUntil: "load", timeout: 30_000 },
      );
      await page.evaluate("document.fonts ? document.fonts.ready : null").catch(() => undefined);
      const el = await page.$("#wrap svg");
      if (!el) return null;
      const box = await el.boundingBox();
      if (!box || box.width < 1 || box.height < 1) return null;
      const data = Buffer.from(await el.screenshot({ type: "png", omitBackground: false }));
      return { data, width: Math.round(box.width), height: Math.round(box.height) };
    } catch {
      return null;
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

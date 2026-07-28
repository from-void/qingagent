import { XHS_COVER_FONT_FACES, xhsCoverFontFaceCss, type XhsCoverFontFace } from "./xhsCoverFonts";

const RESOURCE_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi;
const BLOB_URL_PATTERN = /\bblob:[^\s"'<>)]*/gi;
const LOADABLE_ATTRIBUTE_NAMES = new Set([
  "data",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const RESOURCE_HREF_ELEMENTS = new Set(["image", "link", "use"]);
const resourceDataUrls = new Map<string, Promise<string>>();

function mimeTypeForUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

export function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function isEmbeddedResourceUrl(url: string): boolean {
  const trimmed = url.trim();
  return !trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#");
}

async function resourceUrlToDataUrl(rawUrl: string): Promise<string> {
  if (isEmbeddedResourceUrl(rawUrl)) return rawUrl;
  const absoluteUrl = new URL(rawUrl, document.baseURI).href;
  const cached = resourceDataUrls.get(absoluteUrl);
  if (cached) return cached;
  const loading = fetch(absoluteUrl, { credentials: "same-origin" }).then(async (response) => {
    if (!response.ok) throw new Error(`导出资源加载失败 (${response.status}): ${absoluteUrl}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return arrayBufferToDataUrl(await response.arrayBuffer(), contentType || mimeTypeForUrl(absoluteUrl));
  });
  resourceDataUrls.set(absoluteUrl, loading);
  try {
    return await loading;
  } catch (error) {
    resourceDataUrls.delete(absoluteUrl);
    throw error;
  }
}

async function inlineCssResourceUrls(cssText: string): Promise<string> {
  const matches = Array.from(cssText.matchAll(RESOURCE_URL_PATTERN));
  if (matches.length === 0) return cssText;
  const replacements = await Promise.all(matches.map(async (match) => {
    const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
    const dataUrl = await resourceUrlToDataUrl(rawUrl);
    return { start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, value: `url("${dataUrl}")` };
  }));
  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += cssText.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return output + cssText.slice(cursor);
}

function collectComputedStyles(source: Element, clone: Element, usedFontFamilies: Set<string>): void {
  if (
    (source instanceof HTMLElement || source instanceof SVGElement)
    && (clone instanceof HTMLElement || clone instanceof SVGElement)
  ) {
    const computed = getComputedStyle(source);
    usedFontFamilies.add(computed.fontFamily);
    for (const property of Array.from(computed)) {
      clone.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  }
  Array.from(source.children).forEach((child, index) => {
    const clonedChild = clone.children[index];
    if (clonedChild) collectComputedStyles(child, clonedChild, usedFontFamilies);
  });
}

async function inlineElementResources(source: Element, clone: Element): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (source instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
    const sourceUrl = source.currentSrc || source.src;
    if (sourceUrl) {
      tasks.push(resourceUrlToDataUrl(sourceUrl).then((dataUrl) => {
        clone.src = dataUrl;
        clone.removeAttribute("srcset");
      }));
    }
  }
  if (clone instanceof HTMLElement || clone instanceof SVGElement) {
    for (const property of Array.from(clone.style)) {
      const value = clone.style.getPropertyValue(property);
      if (!RESOURCE_URL_PATTERN.test(value)) {
        RESOURCE_URL_PATTERN.lastIndex = 0;
        continue;
      }
      RESOURCE_URL_PATTERN.lastIndex = 0;
      tasks.push(inlineCssResourceUrls(value).then((inlined) => {
        clone.style.setProperty(property, inlined, clone.style.getPropertyPriority(property));
      }));
    }
  }
  Array.from(source.children).forEach((child, index) => {
    const clonedChild = clone.children[index];
    if (clonedChild) tasks.push(inlineElementResources(child, clonedChild));
  });
  await Promise.all(tasks);
}

function matchingExportFonts(usedFontFamilies: ReadonlySet<string>): XhsCoverFontFace[] {
  return Object.values(XHS_COVER_FONT_FACES).filter((font) =>
    Array.from(usedFontFamilies).some((families) => families.split(",").some((family) =>
      family.trim().replace(/^["']|["']$/g, "") === font.family,
    )),
  );
}

async function embeddedFontCss(usedFontFamilies: ReadonlySet<string>): Promise<string> {
  const fonts = matchingExportFonts(usedFontFamilies);
  return (await Promise.all(fonts.map(async (font) =>
    xhsCoverFontFaceCss(font, await resourceUrlToDataUrl(font.sourceUrl), "block"),
  ))).join("");
}

export function externalSvgResourceReferences(svg: string): string[] {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return ["SVG 解析失败"];
  const references: string[] = [];

  const collectCssReferences = (cssText: string) => {
    for (const match of cssText.matchAll(RESOURCE_URL_PATTERN)) {
      const url = match[1] ?? match[2] ?? match[3] ?? "";
      if (!isEmbeddedResourceUrl(url)) references.push(url);
    }
    for (const match of cssText.matchAll(BLOB_URL_PATTERN)) {
      references.push(match[0]);
    }
    if (/@import\b/i.test(cssText)) references.push("@import");
  };

  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    const style = element.getAttribute("style");
    if (style) collectCssReferences(style);
    if (element.localName.toLowerCase() === "style") {
      collectCssReferences(element.textContent ?? "");
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const isResourceHref =
        name === "href" &&
        RESOURCE_HREF_ELEMENTS.has(element.localName.toLowerCase());
      if (
        (LOADABLE_ATTRIBUTE_NAMES.has(name) || isResourceHref) &&
        !isEmbeddedResourceUrl(attribute.value)
      ) {
        references.push(attribute.value);
      }
    }
  }

  return [...new Set(references)];
}

export function svgMarkupToDataUrl(svg: string): string {
  const externalReferences = externalSvgResourceReferences(svg);
  if (externalReferences.length > 0) {
    throw new Error(`导出内容仍含外部资源: ${externalReferences[0]}`);
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface SelfContainedSvg {
  dataUrl: string;
  height: number;
  svg: string;
  width: number;
}

export interface ExportLayoutBounds {
  height: number;
  visualHeight: number;
  visualWidth: number;
  width: number;
}

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computedBorderBoxSize(computed: CSSStyleDeclaration, axis: "height" | "width"): number {
  const size = cssPixelValue(computed[axis]);
  if (size <= 0 || computed.boxSizing === "border-box") return size;
  if (axis === "width") {
    return size
      + cssPixelValue(computed.paddingLeft)
      + cssPixelValue(computed.paddingRight)
      + cssPixelValue(computed.borderLeftWidth)
      + cssPixelValue(computed.borderRightWidth);
  }
  return size
    + cssPixelValue(computed.paddingTop)
    + cssPixelValue(computed.paddingBottom)
    + cssPixelValue(computed.borderTopWidth)
    + cssPixelValue(computed.borderBottomWidth);
}

function clipsOverflow(value: string): boolean {
  return value === "hidden" || value === "clip";
}

/**
 * 导出使用元素自身的布局坐标系，而不是包含祖先 transform 后的视觉 rect。
 * PhoneShell / DesktopShell 会整体缩放预览；混用缩放后的 rect 与缩放前的计算样式，
 * 会让 clone 的标题和页脚落到固定画布之外。
 */
export function measureExportLayoutBounds(element: HTMLElement): ExportLayoutBounds {
  const computed = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const borderWidth = cssPixelValue(computed.borderLeftWidth) + cssPixelValue(computed.borderRightWidth);
  const borderHeight = cssPixelValue(computed.borderTopWidth) + cssPixelValue(computed.borderBottomWidth);
  const borderBoxWidth = Math.max(
    element.offsetWidth,
    element.clientWidth + borderWidth,
    computedBorderBoxSize(computed, "width"),
  );
  const borderBoxHeight = Math.max(
    element.offsetHeight,
    element.clientHeight + borderHeight,
    computedBorderBoxSize(computed, "height"),
  );
  const contentWidth = clipsOverflow(computed.overflowX) ? 0 : element.scrollWidth + borderWidth;
  const contentHeight = clipsOverflow(computed.overflowY) ? 0 : element.scrollHeight + borderHeight;
  const layoutWidth = Math.max(borderBoxWidth, contentWidth);
  const layoutHeight = Math.max(borderBoxHeight, contentHeight);
  return {
    width: Math.max(1, Math.ceil(layoutWidth || rect.width)),
    height: Math.max(1, Math.ceil(layoutHeight || rect.height)),
    visualWidth: Math.max(0, rect.width),
    visualHeight: Math.max(0, rect.height),
  };
}

export async function serializeElementAsSelfContainedSvg(element: HTMLElement): Promise<SelfContainedSvg> {
  await document.fonts?.ready;
  const { width, height } = measureExportLayoutBounds(element);
  const clone = element.cloneNode(true) as HTMLElement;
  const usedFontFamilies = new Set<string>();
  collectComputedStyles(element, clone, usedFontFamilies);
  // width / height 是 border-box 布局边界；显式固定根盒，避免 foreignObject
  // 缺少原祖先宽度时重新触发百分比、容器单位或 flex/grid 收缩。
  clone.style.setProperty("box-sizing", "border-box");
  clone.style.setProperty("margin", "0");
  clone.style.setProperty("width", `${width}px`);
  clone.style.setProperty("height", `${height}px`);
  await inlineElementResources(element, clone);
  const fontCss = await embeddedFontCss(usedFontFamilies);
  const markup = new XMLSerializer().serializeToString(clone);
  const layoutContext = `box-sizing:border-box;width:${width}px;height:${height}px;margin:0;padding:0`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="${layoutContext}">${fontCss ? `<style>${fontCss}</style>` : ""}${markup}</div></foreignObject></svg>`;
  return { dataUrl: svgMarkupToDataUrl(svg), height, svg, width };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片渲染失败"));
    image.src = dataUrl;
  });
}

export async function renderElementToOriginCleanCanvas(element: HTMLElement): Promise<HTMLCanvasElement> {
  const serialized = await serializeElementAsSelfContainedSvg(element);
  const image = await loadImage(serialized.dataUrl);
  const scale = Math.min(2, 4096 / Math.max(serialized.width, serialized.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(serialized.width * scale));
  canvas.height = Math.max(1, Math.round(serialized.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持图片导出");
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, serialized.width, serialized.height);
  // 立即读取一个像素，确保问题在下载前以稳定、可诊断的错误暴露。
  context.getImageData(0, 0, 1, 1);
  return canvas;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败")), "image/png");
  });
}

export async function exportElementAsPng(element: HTMLElement, filename: string): Promise<void> {
  const canvas = await renderElementToOriginCleanCanvas(element);
  const blob = await canvasToPngBlob(canvas);
  // 这里的 blob URL 只承载已编码完成的最终 PNG 下载，不会再作为 image 源绘回 canvas。
  const downloadUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `${filename.replace(/[\\/:*?"<>|]/g, "-")}.png`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(downloadUrl);
  }
}

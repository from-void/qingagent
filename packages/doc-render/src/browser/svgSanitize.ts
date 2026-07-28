import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";
import { hardenInlineSvg as hardenInlineSvgShared } from "@qingagent/pm-schema";

export const SVG_MAX_BYTES = 200_000;
const MAX_ELEMENTS = 5_000;
const textEncoder = new TextEncoder();

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "title",
  "desc",
]);

const ALLOWED_ATTRS = new Set([
  "id",
  "class",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  // width/height 是 rect/线性渐变等的几何尺寸,纯尺寸属性、无安全风险,必须保留——
  // 否则背景 <rect width height> 会被删成 0×0(背景整片消失)。根 <svg> 的 width/height
  // 由下方 removeAttribute 单独去掉(让图按 viewBox 缩放),不受此白名单影响。
  "width",
  "height",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "transform",
  "viewbox",
  "xmlns",
  "role",
  "aria-label",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "style",
]);

const BAD_STYLE = /(?:url\s*\(|expression\s*\(|@import|javascript:|<)/i;
const BAD_URL_VALUE = /url\(\s*['"]?\s*(?:https?:|data:|javascript:|#?\/\/)/i;
const LOCAL_URL_VALUE = /^url\(\s*['"]?#[A-Za-z][\w:.-]*['"]?\s*\)$/;

interface SvgPaintState {
  hidden: boolean;
  opacity: number;
  visibility: string;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  fontSize: number;
}

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function exceedsSvgByteLimit(value: string, maxBytes = SVG_MAX_BYTES): boolean {
  return value.length > maxBytes || utf8ByteLength(value) > maxBytes;
}

function normalizeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}[ \t\r\n\f]?|[\s\S])/g, (_match, escaped: string) => {
    const hex = /^[0-9a-fA-F]{1,6}/.exec(escaped)?.[0];
    if (!hex) return escaped;

    const codePoint = Number.parseInt(hex, 16);
    if (codePoint <= 0 || codePoint > 0x10ffff) return "\uFFFD";
    return String.fromCodePoint(codePoint);
  });
}

function inlineStyleValue(el: XmlElement, prop: string): string | null {
  const style = el.getAttribute("style");
  if (!style) return null;
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() === prop) {
      return declaration.slice(colon + 1).trim();
    }
  }
  return null;
}

function svgPresentationValue(el: XmlElement, prop: string): string | null {
  return inlineStyleValue(el, prop) ?? el.getAttribute(prop);
}

function finiteSvgNumber(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

function svgOpacity(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, trimmed.endsWith("%") ? parsed / 100 : parsed));
}

function cssAlpha(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === "transparent") return 0;
  const shortHex = /^#[0-9a-f]{3}([0-9a-f])$/i.exec(normalized);
  if (shortHex?.[1]) return Number.parseInt(shortHex[1] + shortHex[1], 16) / 255;
  const longHex = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(normalized);
  if (longHex?.[1]) return Number.parseInt(longHex[1], 16) / 255;
  const functional = /^(?:rgb|rgba|hsl|hsla)\((.*)\)$/i.exec(normalized)?.[1];
  if (!functional) return 1;
  const slashAlpha = functional.includes("/")
    ? functional.slice(functional.lastIndexOf("/") + 1)
    : null;
  const commaParts = functional.split(",");
  const commaAlpha = commaParts.length === 4 ? commaParts[3] : null;
  const rawAlpha = (slashAlpha ?? commaAlpha)?.trim();
  if (!rawAlpha) return 1;
  const parsed = Number.parseFloat(rawAlpha);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(1, rawAlpha.endsWith("%") ? parsed / 100 : parsed));
}

function findElementById(root: XmlElement, id: string): XmlElement | null {
  if (root.getAttribute("id") === id) return root;
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes.item(i);
    if (child?.nodeType !== 1) continue;
    const found = findElementById(child as XmlElement, id);
    if (found) return found;
  }
  return null;
}

function gradientHasVisibleStop(root: XmlElement, id: string): boolean {
  const gradient = findElementById(root, id);
  if (!gradient || !/^(?:lineargradient|radialgradient)$/.test(gradient.tagName.toLowerCase())) {
    return false;
  }
  for (let i = 0; i < gradient.childNodes.length; i++) {
    const child = gradient.childNodes.item(i);
    if (child?.nodeType !== 1) continue;
    const stop = child as XmlElement;
    if (stop.tagName.toLowerCase() !== "stop") continue;
    const color = svgPresentationValue(stop, "stop-color") ?? "black";
    const opacity = svgOpacity(svgPresentationValue(stop, "stop-opacity"), 1) *
      svgOpacity(svgPresentationValue(stop, "opacity"), 1);
    if (opacity > 0 && cssAlpha(color) > 0) return true;
  }
  return false;
}

function hasVisiblePaint(value: string, opacity: number, root: XmlElement): boolean {
  const normalized = value.trim().toLowerCase();
  if (opacity <= 0 || normalized === "none" || cssAlpha(normalized) <= 0) return false;
  const gradientId = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/i.exec(normalized)?.[1];
  return gradientId ? gradientHasVisibleStop(root, gradientId) : true;
}

function distinctPoints(el: XmlElement): Array<[number, number]> {
  const values = ((el.getAttribute("points") ?? "").match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [])
    .map(Number)
    .filter(Number.isFinite);
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const point: [number, number] = [values[i]!, values[i + 1]!];
    if (!points.some(([x, y]) => x === point[0] && y === point[1])) points.push(point);
  }
  return points;
}

function polygonArea(points: Array<[number, number]>): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twiceArea) / 2;
}

interface PathGeometry {
  fillArea: number;
  strokeLength: number;
}

function pathGeometry(d: string): PathGeometry {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const arity: Record<string, number> = {
    m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
  };
  const subpaths: Array<Array<[number, number]>> = [];
  let points: Array<[number, number]> | null = null;
  let command = "";
  let index = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let previousControl: [number, number] | null = null;
  let previousCommand = "";
  const addPoint = (point: [number, number]) => {
    points ??= [];
    points.push(point);
    x = point[0];
    y = point[1];
  };
  const beginSubpath = (point: [number, number]) => {
    points = [point];
    subpaths.push(points);
    x = point[0];
    y = point[1];
    startX = x;
    startY = y;
  };
  const numberAt = (offset: number) => Number(tokens[index + offset]);
  const sampleQuadratic = (
    from: [number, number],
    control: [number, number],
    to: [number, number],
  ) => {
    for (let step = 1; step <= 8; step++) {
      const t = step / 8;
      const mt = 1 - t;
      addPoint([
        mt * mt * from[0] + 2 * mt * t * control[0] + t * t * to[0],
        mt * mt * from[1] + 2 * mt * t * control[1] + t * t * to[1],
      ]);
    }
  };
  const sampleCubic = (
    from: [number, number],
    control1: [number, number],
    control2: [number, number],
    to: [number, number],
  ) => {
    for (let step = 1; step <= 12; step++) {
      const t = step / 12;
      const mt = 1 - t;
      addPoint([
        mt ** 3 * from[0] + 3 * mt * mt * t * control1[0] +
          3 * mt * t * t * control2[0] + t ** 3 * to[0],
        mt ** 3 * from[1] + 3 * mt * mt * t * control1[1] +
          3 * mt * t * t * control2[1] + t ** 3 * to[1],
      ]);
    }
  };

  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index]!)) command = tokens[index++]!;
    if (!command) break;
    const lower = command.toLowerCase();
    const count = arity[lower];
    if (count === undefined || index + count > tokens.length) break;
    if (lower === "z") {
      if (subpaths.at(-1)?.length) addPoint([startX, startY]);
      previousControl = null;
      previousCommand = command;
      command = "";
      continue;
    }
    if (/^[a-zA-Z]$/.test(tokens[index]!)) continue;
    const relative = command === lower;
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    const values = Array.from({ length: count }, (_, offset) => numberAt(offset));
    if (values.some((value) => !Number.isFinite(value))) break;
    index += count;

    if (lower === "m") {
      const next: [number, number] = [ox + values[0]!, oy + values[1]!];
      if (!points || command.toLowerCase() === "m" && previousCommand.toLowerCase() !== "m") {
        beginSubpath(next);
      } else {
        addPoint(next);
      }
      command = command === "m" ? "l" : "L";
      previousControl = null;
    } else if (lower === "l") {
      addPoint([ox + values[0]!, oy + values[1]!]);
      previousControl = null;
    } else if (lower === "h") {
      addPoint([ox + values[0]!, y]);
      previousControl = null;
    } else if (lower === "v") {
      addPoint([x, oy + values[0]!]);
      previousControl = null;
    } else if (lower === "c") {
      const from: [number, number] = [x, y];
      const control1: [number, number] = [ox + values[0]!, oy + values[1]!];
      const control2: [number, number] = [ox + values[2]!, oy + values[3]!];
      const to: [number, number] = [ox + values[4]!, oy + values[5]!];
      sampleCubic(from, control1, control2, to);
      previousControl = control2;
    } else if (lower === "s") {
      const from: [number, number] = [x, y];
      const control1: [number, number] =
        previousControl && /[cs]/i.test(previousCommand)
          ? [2 * x - previousControl[0], 2 * y - previousControl[1]]
          : [x, y];
      const control2: [number, number] = [ox + values[0]!, oy + values[1]!];
      const to: [number, number] = [ox + values[2]!, oy + values[3]!];
      sampleCubic(from, control1, control2, to);
      previousControl = control2;
    } else if (lower === "q") {
      const from: [number, number] = [x, y];
      const control: [number, number] = [ox + values[0]!, oy + values[1]!];
      const to: [number, number] = [ox + values[2]!, oy + values[3]!];
      sampleQuadratic(from, control, to);
      previousControl = control;
    } else if (lower === "t") {
      const from: [number, number] = [x, y];
      const control: [number, number] =
        previousControl && /[qt]/i.test(previousCommand)
          ? [2 * x - previousControl[0], 2 * y - previousControl[1]]
          : [x, y];
      const to: [number, number] = [ox + values[0]!, oy + values[1]!];
      sampleQuadratic(from, control, to);
      previousControl = control;
    } else if (lower === "a") {
      addPoint([ox + values[5]!, oy + values[6]!]);
      previousControl = null;
    }
    previousCommand = command;
  }

  let fillArea = 0;
  let strokeLength = 0;
  for (const subpath of subpaths) {
    fillArea += polygonArea(subpath);
    for (let i = 1; i < subpath.length; i++) {
      const previous = subpath[i - 1]!;
      const current = subpath[i]!;
      strokeLength += Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    }
  }
  return { fillArea, strokeLength };
}

function isDrawableSvgElement(
  el: XmlElement,
  state: SvgPaintState,
  root: XmlElement,
): boolean {
  const name = el.tagName.toLowerCase();
  const fillVisible = hasVisiblePaint(
    state.fill,
    state.opacity * state.fillOpacity,
    root,
  );
  const strokeVisible =
    state.strokeWidth > 0 &&
    hasVisiblePaint(state.stroke, state.opacity * state.strokeOpacity, root);
  const positive = (attr: string) => finiteSvgNumber(el.getAttribute(attr), 0) > 0;

  if (name === "rect") return positive("width") && positive("height") && (fillVisible || strokeVisible);
  if (name === "circle") return positive("r") && (fillVisible || strokeVisible);
  if (name === "ellipse") return positive("rx") && positive("ry") && (fillVisible || strokeVisible);
  if (name === "line") {
    const x1 = finiteSvgNumber(el.getAttribute("x1"), 0);
    const y1 = finiteSvgNumber(el.getAttribute("y1"), 0);
    const x2 = finiteSvgNumber(el.getAttribute("x2"), 0);
    const y2 = finiteSvgNumber(el.getAttribute("y2"), 0);
    return strokeVisible && (x1 !== x2 || y1 !== y2);
  }
  if (name === "polyline" || name === "polygon") {
    const points = distinctPoints(el);
    const hasStrokeGeometry = points.length >= 2;
    const hasFillGeometry = points.length >= 3 && polygonArea(points) > 0;
    return (strokeVisible && hasStrokeGeometry) || (fillVisible && hasFillGeometry);
  }
  if (name === "path") {
    const d = (el.getAttribute("d") ?? "").trim();
    const geometry = pathGeometry(d);
    return (strokeVisible && geometry.strokeLength > 0) ||
      (fillVisible && geometry.fillArea > 0);
  }
  if (name === "text" || name === "tspan") {
    return state.fontSize > 0 && Boolean(el.textContent?.trim()) && (fillVisible || strokeVisible);
  }
  return false;
}

export function hasVisibleSvgContent(svg: string): boolean {
  try {
    if (typeof svg !== "string" || svg.length === 0 || exceedsSvgByteLimit(svg)) {
      return false;
    }
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return false;

    const initialState: SvgPaintState = {
      hidden: false,
      opacity: 1,
      visibility: "visible",
      fill: "black",
      fillOpacity: 1,
      stroke: "none",
      strokeOpacity: 1,
      strokeWidth: 1,
      fontSize: 16,
    };
    const visit = (el: XmlElement, inherited: SvgPaintState): boolean => {
      const name = el.tagName.toLowerCase();
      if (name === "defs") return false;

      const display = svgPresentationValue(el, "display")?.trim().toLowerCase();
      const visibility =
        svgPresentationValue(el, "visibility")?.trim().toLowerCase() || inherited.visibility;
      const state: SvgPaintState = {
        hidden: inherited.hidden || display === "none",
        opacity: inherited.opacity * svgOpacity(svgPresentationValue(el, "opacity"), 1),
        visibility,
        fill: svgPresentationValue(el, "fill") ?? inherited.fill,
        fillOpacity: svgOpacity(svgPresentationValue(el, "fill-opacity"), inherited.fillOpacity),
        stroke: svgPresentationValue(el, "stroke") ?? inherited.stroke,
        strokeOpacity: svgOpacity(svgPresentationValue(el, "stroke-opacity"), inherited.strokeOpacity),
        strokeWidth: finiteSvgNumber(svgPresentationValue(el, "stroke-width"), inherited.strokeWidth),
        fontSize: finiteSvgNumber(svgPresentationValue(el, "font-size"), inherited.fontSize),
      };
      if (state.hidden || state.opacity <= 0 || visibility === "hidden" || visibility === "collapse") {
        return false;
      }
      if (isDrawableSvgElement(el, state, root)) return true;

      for (let i = 0; i < el.childNodes.length; i++) {
        const child = el.childNodes.item(i);
        if (child?.nodeType === 1 && visit(child as XmlElement, state)) {
          return true;
        }
      }
      return false;
    };

    return visit(root, initialState);
  } catch {
    return false;
  }
}

// 流式草稿预览专用:把"半截 SVG 流"快速整理成一个可临时渲染的草稿串。
// 前半段只负责流式容错与正则预清理,最终结果必须再走 hardenInlineSvg 的 DOMParser
// 权威加固后才能交给前端 innerHTML。具体做四件事:
// ① 从 <svg 处截取主体;② 正则粗暴剥掉危险表面(script/事件属性/href/外部 url);
// ③ 自动闭合未收尾的标签 + </svg>,让浏览器能渲出"正在成形"的草图;
// ④ DOMParser 解析并剔除脚本/事件/外联等可执行面,堵住正则消毒旁路。
// 限制体积上限,失败/为空返回 null(前端就继续显示进度文字)。
const DRAFT_MAX_BYTES = SVG_MAX_BYTES;
const DRAFT_DANGEROUS_TAGS = /<\/?(?:script|foreignobject|image|use|a|style|iframe|animate|set|audio|video)\b[^>]*>/gi;
const DRAFT_EVENT_ATTRS = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DRAFT_HREF_ATTRS = /\s+(?:xlink:href|href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// 草稿走 dangerouslySetInnerHTML,外链/内联样式是 XSS·SSRF 面,这里这样处理:
// ① 删掉所有 style 属性(CSS 上下文最易被 escape/comment 绕过);
// ② 只删「值里含【外链】url(」的属性 —— url( 后紧跟的不是 '#'(即 http/https/data/javascript/
//    协议相对 // 或 HTML 实体形态的 url(&#x68;ttp…))才删;【本地 url(#id) 渐变/滤镜必须保留】,
//    否则 rect 等失去 fill 会回落到 SVG 默认【黑色】填充,草稿背景整片变黑(与最终成图不一致)。
const DRAFT_STYLE_ATTR = /\s+style\s*=\s*(?:"[^"]*"|'[^']*')/gi;
const DRAFT_URL_ATTR = /\s+[\w:-]+\s*=\s*(?:"[^"]*url\(\s*['"]?(?!#)[^"]*"|'[^']*url\(\s*["']?(?!#)[^']*')/gi;

export function buildPartialSvgDraft(
  raw: string,
  options: { width: number; height: number },
): string | null {
  try {
    if (typeof raw !== "string" || raw.length === 0) return null;
    let text = raw;
    // 剥掉可能存在的 markdown 围栏起始
    text = text.replace(/^```(?:svg|xml)?[ \t]*\r?\n?/i, "");
    const start = text.search(/<svg[\s>]/i);
    if (start === -1) return null;
    text = text.slice(start);
    if (text.length > DRAFT_MAX_BYTES) return null;

    // 去掉 markdown 收尾围栏(如果模型已经写到那)
    text = text.replace(/```\s*$/i, "");
    // 粗暴剥危险表面:危险标签 / 事件属性 / href·src / style 属性 / 含 url() 的属性
    text = text
      .replace(DRAFT_DANGEROUS_TAGS, "")
      .replace(DRAFT_EVENT_ATTRS, "")
      .replace(DRAFT_HREF_ATTRS, "")
      .replace(DRAFT_STYLE_ATTR, "")
      .replace(DRAFT_URL_ATTR, "");

    // 丢弃最后写到一半的残片标签:用 quote-aware 的完整标签扫描定位「最后一个完整标签」的
    // 结束位置,其后若还冒出未写完的 '<…' 就裁掉残片——残片属性里即便含 '>' 也不会误判
    // (旧实现用 lastIndexOf('<')/lastIndexOf('>') 对 `<path d="M0 > 0"` 这类会漏裁)。
    {
      const scanRe = /<\/?[a-zA-Z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*?\/?>/g;
      let lastCompleteEnd = 0;
      let sm: RegExpExecArray | null;
      while ((sm = scanRe.exec(text)) !== null) {
        lastCompleteEnd = sm.index + sm[0].length;
      }
      const tail = text.slice(lastCompleteEnd);
      const fragmentAt = tail.indexOf("<");
      if (fragmentAt !== -1) {
        text = text.slice(0, lastCompleteEnd + fragmentAt);
      }
    }

    // 自动闭合所有未收尾的标签(简易栈)
    const stack: string[] = [];
    const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(text)) !== null) {
      const closing = match[1] === "/";
      const selfClosing = match[4] === "/";
      const name = (match[2] ?? "").toLowerCase();
      if (!name || selfClosing) continue;
      if (closing) {
        // 弹到匹配的开标签
        const idx = stack.lastIndexOf(name);
        if (idx !== -1) stack.length = idx;
      } else {
        stack.push(name);
      }
    }
    let closed = text;
    for (let i = stack.length - 1; i >= 0; i--) {
      closed += `</${stack[i]}>`;
    }
    if (!/<\/svg>\s*$/i.test(closed)) {
      // stack 已补 </svg>;若仍缺(极端)再兜一次
      if (!/<\/svg>/i.test(closed)) closed += "</svg>";
    }

    // 强制 viewBox / xmlns,去掉 width/height,保证按容器缩放
    closed = closed.replace(
      /<svg\b([^>]*)>/i,
      (_m, attrs: string) => {
        let a = attrs
          .replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/\s+height\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
        if (!/viewbox\s*=/i.test(a)) {
          a += ` viewBox="0 0 ${Math.max(1, Math.round(options.width))} ${Math.max(1, Math.round(options.height))}"`;
        }
        if (!/xmlns\s*=/i.test(a)) {
          a += ` xmlns="${SVG_NS}"`;
        }
        return `<svg${a}>`;
      },
    );
    return hardenInlineSvg(closed);
  } catch {
    return null;
  }
}

// 导出内联用的「保真加固」与 PM 客户端缓存共用 pm-schema 单一安全边界：
// 保留 Mermaid/drawio 依赖的 style/marker/渐变，同时只允许本地片段 URL，并移除
// SMIL、脚本、事件与外联，避免导出 HTML 读取本地或远端资源。
/**
 * 把一段 SVG 加固成「可安全内联进导出 HTML」的形态:保留可视内容,移除脚本/事件/外联等可执行面。
 * 解析失败 / 含 DOCTYPE|ENTITY(XXE) / 根非 svg → 返回 null,调用方据此回退(图表→源码,图片→占位)。
 */
export function hardenInlineSvg(raw: string, options: { maxBytes?: number } = {}): string | null {
  return hardenInlineSvgShared(raw, options);
}

export function sanitizeSvg(
  raw: string,
  options: { width: number; height: number },
): string {
  try {
    if (typeof raw !== "string" || raw.length === 0 || exceedsSvgByteLimit(raw)) {
      return "";
    }
    if (/[<!]\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)) {
      return "";
    }

    const guarded = raw.replace(/<\?[\s\S]*?\?>/g, "");
    let parseFailed = false;
    const doc = new DOMParser({
      onError: (level) => {
        if (level !== "warning") {
          parseFailed = true;
        }
      },
    }).parseFromString(guarded, "image/svg+xml");
    if (parseFailed) return "";

    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return "";

    let elementCount = 0;
    function cleanElement(el: XmlElement): void {
      elementCount++;
      if (elementCount > MAX_ELEMENTS) {
        throw new Error("SVG element limit exceeded");
      }

      const name = el.tagName.toLowerCase();
      if (!ALLOWED_ELEMENTS.has(name)) {
        el.parentNode?.removeChild(el);
        return;
      }

      for (let i = el.attributes.length - 1; i >= 0; i--) {
        const attr = el.attributes.item(i);
        if (!attr) continue;
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value;
        const normalizedAttrValue = normalizeCssEscapes(attrValue);
        const isDangerousRef =
          attrName === "href" ||
          attrName === "xlink:href" ||
          attrName === "src" ||
          attrName === "xlink:show" ||
          attrName === "xlink:actuate" ||
          attrName.startsWith("xmlns:");
        const isEvent = attrName.startsWith("on");
        const isAllowed = ALLOWED_ATTRS.has(attrName);
        const hasBadStyle = attrName === "style" && BAD_STYLE.test(normalizedAttrValue);
        const hasBadUrl =
          /url\(/i.test(normalizedAttrValue) &&
          (BAD_URL_VALUE.test(normalizedAttrValue) || !LOCAL_URL_VALUE.test(normalizedAttrValue.trim()));
        if (isDangerousRef || isEvent || !isAllowed || hasBadStyle || hasBadUrl) {
          el.removeAttribute(attr.name);
        }
      }

      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        const child = el.childNodes.item(i);
        if (!child) continue;
        if (child.nodeType === 1) {
          cleanElement(child as XmlElement);
        } else if (child.nodeType !== 3) {
          el.removeChild(child);
        }
      }
    }

    cleanElement(root);
    root.setAttribute("xmlns", SVG_NS);
    root.setAttribute("viewBox", `0 0 ${Math.max(1, Math.round(options.width))} ${Math.max(1, Math.round(options.height))}`);
    root.setAttribute("role", "img");
    root.removeAttribute("width");
    root.removeAttribute("height");

    return new XMLSerializer().serializeToString(root);
  } catch {
    return "";
  }
}

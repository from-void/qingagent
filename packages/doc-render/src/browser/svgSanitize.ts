import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";

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
const VISIBLE_ELEMENTS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
]);

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function exceedsSvgByteLimit(value: string): boolean {
  return value.length > SVG_MAX_BYTES || utf8ByteLength(value) > SVG_MAX_BYTES;
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

export function hasVisibleSvgContent(svg: string): boolean {
  try {
    if (typeof svg !== "string" || svg.length === 0 || exceedsSvgByteLimit(svg)) {
      return false;
    }
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return false;

    const visit = (el: XmlElement): boolean => {
      const name = el.tagName.toLowerCase();
      if (VISIBLE_ELEMENTS.has(name)) return true;

      for (let i = 0; i < el.childNodes.length; i++) {
        const child = el.childNodes.item(i);
        if (child?.nodeType === 1 && visit(child as XmlElement)) {
          return true;
        }
      }
      return false;
    };

    return visit(root);
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

// 导出内联用的「保真加固」:与上面的白名单 sanitizeSvg 不同——白名单会删掉 mermaid 依赖的
// <style>/<marker>/渐变,毁掉图表观感。这里改用黑名单:只剔除会执行脚本/外联的
// 危险面(<script>/<iframe>/<object>/<embed>/<foreignObject>、on* 事件属性、非 #local 的 href/src、<style> 里的
// @import/外部 url()),保留一切可视元素。用于把 mermaid 缓存 SVG / data:image/svg+xml 安全内联进
// 导出 HTML(该 HTML 可能被用户在浏览器里打开,故必须杜绝可执行内容注入)。
const REMOVE_ELEMENTS = new Set(["script", "iframe", "object", "embed", "foreignobject"]);
const HREF_ATTRS = new Set(["href", "xlink:href", "src", "xlink:actuate", "xlink:show"]);
const BAD_STYLE_TEXT = /@import|url\(\s*['"]?\s*(?:https?:|\/\/|data:|javascript:)/i;

/**
 * 把一段 SVG 加固成「可安全内联进导出 HTML」的形态:保留可视内容,移除脚本/事件/外联等可执行面。
 * 解析失败 / 含 DOCTYPE|ENTITY(XXE) / 根非 svg → 返回 null,调用方据此回退(图表→源码,图片→占位)。
 */
export function hardenInlineSvg(raw: string): string | null {
  try {
    if (typeof raw !== "string" || raw.length === 0 || exceedsSvgByteLimit(raw)) return null;
    if (/[<!]\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)) return null;

    const guarded = raw.replace(/<\?[\s\S]*?\?>/g, "");
    let parseFailed = false;
    const doc = new DOMParser({
      onError: (level) => {
        if (level !== "warning") parseFailed = true;
      },
    }).parseFromString(guarded, "image/svg+xml");
    if (parseFailed) return null;

    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;

    let elementCount = 0;
    function clean(el: XmlElement): void {
      elementCount++;
      if (elementCount > MAX_ELEMENTS) throw new Error("SVG element limit exceeded");

      const name = el.tagName.toLowerCase();
      if (REMOVE_ELEMENTS.has(name)) {
        el.parentNode?.removeChild(el);
        return;
      }

      for (let i = el.attributes.length - 1; i >= 0; i--) {
        const attr = el.attributes.item(i);
        if (!attr) continue;
        const attrName = attr.name.toLowerCase();
        const value = normalizeCssEscapes(attr.value).trim();
        // 事件处理器一律删
        if (attrName.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        // href/src 类:只保留本地 #引用(mermaid 箭头 marker 用 #id);其余(javascript:/外链/data:)全删
        if (HREF_ATTRS.has(attrName) && !value.startsWith("#")) {
          el.removeAttribute(attr.name);
          continue;
        }
        // style 内联属性里的 @import / 外部 url() / javascript:
        if (attrName === "style" && BAD_STYLE_TEXT.test(value)) {
          el.removeAttribute(attr.name);
        }
      }

      // <style> 元素文本:剔除 @import / 外部 url() —— 直接清空整段(mermaid 主题 style 不需要它们)
      if (name === "style") {
        const text = el.textContent ?? "";
        if (BAD_STYLE_TEXT.test(normalizeCssEscapes(text))) {
          el.textContent = "";
        }
      }

      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        const child = el.childNodes.item(i);
        if (child?.nodeType === 1) clean(child as XmlElement);
      }
    }

    clean(root);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
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

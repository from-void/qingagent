import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";

export const INLINE_SVG_MAX_BYTES = 200_000;
const INLINE_SVG_MAX_ELEMENTS = 5_000;
const REMOVE_ELEMENTS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "foreignobject",
  // 静态 SVG 不需要 SMIL；动画节点能在运行时改写 href/filter 等 URL 属性，
  // 因此连同 animateMotion 的 mpath 一律移除。
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "mpath",
]);
const HREF_ATTRS = new Set(["href", "xlink:href", "src", "xlink:actuate", "xlink:show"]);
const LOCAL_FRAGMENT = /^#[^\s"'()<>]+$/;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const textEncoder = new TextEncoder();

/**
 * 图表缓存内联前的统一安全边界。保留 marker/渐变/原生 SVG 文本等视觉元素，只剥除
 * 可执行标签、事件、外联与实体声明；Mermaid、drawio 和导出共用同一实现。
 */
export function hardenInlineSvg(raw: string, options: { maxBytes?: number } = {}): string | null {
  try {
    const maxBytes = options.maxBytes ?? INLINE_SVG_MAX_BYTES;
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > maxBytes ||
      textEncoder.encode(raw).length > maxBytes ||
      /[<!]\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)
    ) {
      return null;
    }

    const guarded = raw.replace(/<\?[\s\S]*?\?>/g, "");
    let parseFailed = false;
    const document = new DOMParser({
      onError: (level) => {
        if (level !== "warning") parseFailed = true;
      },
    }).parseFromString(guarded, "image/svg+xml");
    if (parseFailed) return null;

    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;

    let elementCount = 0;
    function clean(element: XmlElement): void {
      elementCount += 1;
      if (elementCount > INLINE_SVG_MAX_ELEMENTS) throw new Error("SVG element limit exceeded");

      const name = element.tagName.toLowerCase();
      if (REMOVE_ELEMENTS.has(name)) {
        element.parentNode?.removeChild(element);
        return;
      }

      for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
        const attr = element.attributes.item(index);
        if (!attr) continue;
        const attrName = attr.name.toLowerCase();
        const value = normalizeCssEscapes(attr.value).trim();
        if (attrName.startsWith("on")) {
          element.removeAttribute(attr.name);
          continue;
        }
        if (HREF_ATTRS.has(attrName) && !LOCAL_FRAGMENT.test(value)) {
          element.removeAttribute(attr.name);
          continue;
        }
        // fill/filter/clip-path/marker/style 等任意属性里的 URL 都只允许 url(#id)。
        if (!hasOnlyLocalFragmentUrls(value)) {
          element.removeAttribute(attr.name);
          continue;
        }
        if (attrName === "style" && !isSafeStyleText(value)) {
          element.removeAttribute(attr.name);
        }
      }

      if (name === "style" && !isSafeStyleText(normalizeCssEscapes(element.textContent ?? ""))) {
        element.textContent = "";
      }
      for (let index = element.childNodes.length - 1; index >= 0; index -= 1) {
        const child = element.childNodes.item(index);
        if (child?.nodeType === 1) clean(child as XmlElement);
      }
    }

    clean(root);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}

function hasOnlyLocalFragmentUrls(value: string): boolean {
  const openings = value.match(/url\s*\(/gi)?.length ?? 0;
  if (openings === 0) return true;
  let count = 0;
  CSS_URL.lastIndex = 0;
  for (const match of value.matchAll(CSS_URL)) {
    count += 1;
    if (!LOCAL_FRAGMENT.test(match[2]?.trim() ?? "")) return false;
  }
  // 出现 url( 却没有完整匹配，按畸形外联表达式拒绝。
  return count === openings;
}

function isSafeStyleText(value: string): boolean {
  return !/@import|javascript:/i.test(value) && hasOnlyLocalFragmentUrls(value);
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

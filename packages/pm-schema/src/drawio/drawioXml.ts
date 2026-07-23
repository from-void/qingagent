import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { inflateSync, strFromU8 } from "fflate";

export const DRAWIO_MAX_SOURCE_BYTES = 2_000_000;
export const DRAWIO_MAX_COMPRESSED_BYTES = 1_000_000;
export const DRAWIO_MAX_ELEMENTS = 20_000;
export const DRAWIO_MAX_DEPTH = 64;
export const DRAWIO_MAX_CELLS = 10_000;

const textEncoder = new TextEncoder();
const UNSAFE_XML_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b|<\?xml-stylesheet\b/i;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const UNSAFE_STYLE_VALUE = /(?:javascript:|data:|https?:|(?:^|[("'])\/\/|url\s*\()/i;
const UNSAFE_STYLE_KEYS = new Set(["image", "link", "href", "src"]);
const UNSAFE_ATTRS = new Set(["link", "href", "src", "image"]);

export const DEFAULT_DRAWIO_SOURCE = `<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="start" value="开始" style="rounded=0;whiteSpace=wrap;html=0;fillColor=#efe3cc;strokeColor=#b08a3e;fontColor=#2f2a22;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="end" value="结束" style="rounded=0;whiteSpace=wrap;html=0;fillColor=#f7f1e3;strokeColor=#7f6a45;fontColor=#2f2a22;" vertex="1" parent="1">
      <mxGeometry x="240" y="40" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="edge-1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;strokeColor=#7f6a45;endArrow=block;" edge="1" parent="1" source="start" target="end">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;

export type DrawioModel = {
  source: string;
  modelXml: string;
};

export function utf8DrawioByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * 把 draw.io 的压缩 diagram 文本展开成可读 XML。返回值只会是未压缩的
 * mxGraphModel / mxfile；明文输入保持原有排版，便于 AI diff。
 */
export function normalizeDrawioSource(raw: string): string {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("drawio source 不能为空");
  if (source.length > DRAWIO_MAX_SOURCE_BYTES || utf8DrawioByteLength(source) > DRAWIO_MAX_SOURCE_BYTES) {
    throw new Error(`drawio source 超过 ${DRAWIO_MAX_SOURCE_BYTES} bytes`);
  }
  if (UNSAFE_XML_DECLARATION.test(source)) {
    throw new Error("drawio XML 禁止 DOCTYPE、ENTITY 与外部 stylesheet");
  }

  if (!source.startsWith("<")) {
    const modelXml = decodeCompressedDiagram(source);
    validateMxGraphModel(requireDocumentElement(parseXml(modelXml)));
    return modelXml;
  }

  const document = parseXml(source);
  const root = requireDocumentElement(document);
  if (root.tagName === "mxGraphModel") {
    validateMxGraphModel(root);
    return source;
  }
  if (root.tagName !== "mxfile") {
    throw new Error("drawio XML 根节点必须是 mxGraphModel 或 mxfile");
  }

  const diagrams = directChildren(root, "diagram");
  if (diagrams.length === 0) throw new Error("mxfile 至少需要一个 diagram");
  let expanded = false;
  for (const diagram of diagrams) {
    const model = firstElementChild(diagram);
    if (model) {
      if (model.tagName !== "mxGraphModel") throw new Error("diagram 子节点必须是 mxGraphModel");
      validateMxGraphModel(model);
      continue;
    }
    const compressed = (diagram.textContent ?? "").trim();
    if (!compressed) throw new Error("diagram 缺少 mxGraphModel");
    const modelDocument = parseXml(decodeCompressedDiagram(compressed));
    validateMxGraphModel(requireDocumentElement(modelDocument));
    while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
    diagram.appendChild(document.importNode(requireDocumentElement(modelDocument), true));
    expanded = true;
  }
  if (expanded) {
    root.setAttribute("compressed", "false");
    return new XMLSerializer().serializeToString(root);
  }
  if (root.getAttribute("compressed") !== "false") {
    // diagram 已是明文 mxGraphModel 时也修正容器声明，避免后续消费者把可读 XML
    // 误当作 deflate 文本；仅在声明确需变化时重排 XML。
    root.setAttribute("compressed", "false");
    return new XMLSerializer().serializeToString(root);
  }
  return source;
}

/**
 * 读取首个页面的 mxGraphModel。调用者可直接把 source 原样持久化，modelXml 仅用于渲染。
 */
export function readDrawioModel(raw: string): DrawioModel {
  const source = normalizeDrawioSource(raw);
  const document = parseXml(source);
  const root = requireDocumentElement(document);
  const model = root.tagName === "mxGraphModel"
    ? root
    : firstElementChild(directChildren(root, "diagram")[0]);
  if (!model || model.tagName !== "mxGraphModel") {
    throw new Error("drawio XML 缺少 mxGraphModel");
  }
  validateMxGraphModel(model);
  return {
    source,
    modelXml: new XMLSerializer().serializeToString(model),
  };
}

/**
 * 渲染专用副本：XML 只作为数据解析，不执行脚本；同时提前移除链接、外部图片与事件属性，
 * 避免 maxGraph 在最终 SVG 加固前触发网络加载。
 */
export function prepareDrawioModelXmlForRender(raw: string): DrawioModel {
  const parsed = readDrawioModel(raw);
  const document = parseXml(parsed.modelXml);
  const root = requireDocumentElement(document);
  walkElements(root, (element) => {
    for (let i = element.attributes.length - 1; i >= 0; i -= 1) {
      const attr = element.attributes.item(i);
      if (!attr) continue;
      const name = attr.name.toLowerCase();
      const localName = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
      if (localName.startsWith("on") || UNSAFE_ATTRS.has(localName)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const safeStyle = attr.value
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .filter((part) => {
            const separator = part.indexOf("=");
            const key = (separator === -1 ? part : part.slice(0, separator)).trim().toLowerCase();
            const value = separator === -1 ? "" : part.slice(separator + 1).trim();
            return !UNSAFE_STYLE_KEYS.has(key) && !UNSAFE_STYLE_VALUE.test(value);
          })
          .join(";");
        if (safeStyle) element.setAttribute(attr.name, `${safeStyle};`);
        else element.removeAttribute(attr.name);
      }
    }
  });
  return {
    source: parsed.source,
    modelXml: new XMLSerializer().serializeToString(root),
  };
}

export function validateDrawioSource(raw: string): { ok: true; source: string } | { ok: false; error: string } {
  try {
    return { ok: true, source: normalizeDrawioSource(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseXml(source: string): XmlDocument {
  if (UNSAFE_XML_DECLARATION.test(source)) {
    throw new Error("drawio XML 禁止 DOCTYPE、ENTITY 与外部 stylesheet");
  }
  let parseFailed = false;
  const document = new DOMParser({
    onError: (level) => {
      if (level !== "warning") parseFailed = true;
    },
  }).parseFromString(source, "application/xml");
  if (parseFailed || !document.documentElement) throw new Error("drawio XML 解析失败");
  return document;
}

function requireDocumentElement(document: XmlDocument): XmlElement {
  if (!document.documentElement) throw new Error("drawio XML 缺少根节点");
  return document.documentElement;
}

function validateMxGraphModel(model: XmlElement): void {
  if (model.tagName !== "mxGraphModel") throw new Error("diagram 内容必须是 mxGraphModel");
  let elementCount = 0;
  let cellCount = 0;
  let hasRootCell = false;
  let hasLayerCell = false;
  walkElements(model, (element, depth) => {
    elementCount += 1;
    if (elementCount > DRAWIO_MAX_ELEMENTS) throw new Error("drawio XML 元素过多");
    if (depth > DRAWIO_MAX_DEPTH) throw new Error("drawio XML 嵌套过深");
    if (element.tagName === "mxCell") {
      cellCount += 1;
      if (cellCount > DRAWIO_MAX_CELLS) throw new Error("drawio XML 单元格过多");
      const id = element.getAttribute("id");
      if (id === "0") hasRootCell = true;
      if (id === "1" && element.getAttribute("parent") === "0") hasLayerCell = true;
    }
  });
  const root = directChildren(model, "root")[0];
  if (!root) throw new Error("mxGraphModel 缺少 root");
  if (!hasRootCell || !hasLayerCell) throw new Error("mxGraphModel 必须包含 id=0 根单元与 parent=0 的 id=1 图层");
}

function walkElements(
  root: XmlElement,
  visitor: (element: XmlElement, depth: number) => void,
  depth = 1,
): void {
  visitor(root, depth);
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index);
    if (child?.nodeType === 1) walkElements(child as XmlElement, visitor, depth + 1);
  }
}

function directChildren(root: XmlElement | undefined, tagName: string): XmlElement[] {
  if (!root) return [];
  const children: XmlElement[] = [];
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index);
    if (child?.nodeType === 1 && (child as XmlElement).tagName === tagName) {
      children.push(child as XmlElement);
    }
  }
  return children;
}

function firstElementChild(root: XmlElement | undefined): XmlElement | undefined {
  if (!root) return undefined;
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index);
    if (child?.nodeType === 1) return child as XmlElement;
  }
  return undefined;
}

function decodeCompressedDiagram(base64: string): string {
  const compact = base64.replace(/\s+/g, "");
  if (!compact || compact.length > DRAWIO_MAX_COMPRESSED_BYTES || !BASE64_TEXT.test(compact)) {
    throw new Error("drawio 压缩数据不是合法 base64");
  }
  let inflated: Uint8Array;
  try {
    // 固定输出缓冲区是防 deflate bomb 的关键：fflate 在 out 不足时截断，不会按攻击者声明
    // 自动扩容；填满 MAX+1 即拒绝，避免先分配巨型结果再做事后长度检查。
    inflated = inflateSync(decodeBase64(compact), {
      out: new Uint8Array(DRAWIO_MAX_SOURCE_BYTES + 1),
    });
  } catch (error) {
    throw new Error(`drawio deflate 解压失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (inflated.length > DRAWIO_MAX_SOURCE_BYTES) {
    throw new Error("drawio deflate 解压结果超过安全上限");
  }
  let encoded: string;
  try {
    encoded = strFromU8(inflated);
    return decodeURIComponent(encoded);
  } catch {
    throw new Error("drawio 压缩数据不是合法 UTF-8/URI 编码 XML");
  }
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error("drawio 压缩数据不是合法 base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

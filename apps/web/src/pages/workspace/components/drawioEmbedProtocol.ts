import {
  INLINE_SVG_MAX_BYTES,
  hardenInlineSvg,
  normalizeDrawioSource,
} from "@qingagent/pm-schema";

export const DRAWIO_EMBED_PATH =
  "/drawio/index.html?embed=1&proto=json&spin=1&offline=1&lang=zh&libraries=1&saveAndExit=1&suppressNewWindows=1";

export const DRAWIO_EXPORT_TIMEOUT_MS = 5_000;
export const DRAWIO_FALLBACK_TIMEOUT_MS = 5_000;
const DRAWIO_EXPORT_MESSAGE_PREFIX = "qingagent-drawio-export:";
const MAX_SVG_DATA_URI_CHARS = INLINE_SVG_MAX_BYTES * 4 + 256;

export type DrawioEditorResult = {
  source: string;
  svg: string | null;
  warning?: string;
};

export type DrawioEmbedEvent =
  | { event: "init" }
  | { event: "load" }
  | { event: "save"; xml: string; exit?: boolean }
  | { event: "export"; format?: string; data: string; message?: string }
  | { event: "exit"; modified?: boolean }
  | { event: "openLink"; href?: string };

export type DrawioLoadAction = {
  action: "load";
  xml: string;
  title: string;
  saveAndExit: true;
};

export type DrawioExportAction = {
  action: "export";
  format: "svg";
  xml: string;
  embedImages: true;
  embedFonts: true;
  message: string;
};

export function parseDrawioEmbedMessage(raw: unknown): DrawioEmbedEvent | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || typeof value.event !== "string") return null;

  switch (value.event) {
    case "init":
    case "load":
      return { event: value.event };
    case "save":
      return typeof value.xml === "string"
        ? { event: "save", xml: value.xml, ...(value.exit === true ? { exit: true } : {}) }
        : null;
    case "export":
      return typeof value.data === "string"
        ? {
            event: "export",
            data: value.data,
            ...(typeof value.format === "string" ? { format: value.format } : {}),
            ...(typeof value.message === "string" ? { message: value.message } : {}),
          }
        : null;
    case "exit":
      return { event: "exit", ...(typeof value.modified === "boolean" ? { modified: value.modified } : {}) };
    case "openLink":
      return { event: "openLink", ...(typeof value.href === "string" ? { href: value.href } : {}) };
    default:
      return null;
  }
}

export function encodeDrawioAction(action: DrawioLoadAction | DrawioExportAction): string {
  return JSON.stringify(action);
}

export function createDrawioLoadAction(source: string, title: string): DrawioLoadAction {
  return {
    action: "load",
    xml: normalizeDrawioSource(source),
    title,
    saveAndExit: true,
  };
}

export function createDrawioExportAction(source: string, nonce: string): DrawioExportAction {
  return {
    action: "export",
    format: "svg",
    xml: normalizeDrawioSource(source),
    embedImages: true,
    embedFonts: true,
    message: drawioExportMessage(nonce),
  };
}

export function drawioExportMessage(nonce: string): string {
  return `${DRAWIO_EXPORT_MESSAGE_PREFIX}${nonce}`;
}

export function isDrawioExportMessage(message: string | undefined, nonce: string): boolean {
  return message === drawioExportMessage(nonce);
}

/**
 * 保存结果必须同时通过 W4 的 XML 防炸弹校验与统一 SVG 加固，调用方拿到的值可直接
 * 用既有 updateAttributes({ source, svg }) 链路回写。
 */
export function finalizeDrawioEdit(rawSource: string, svgDataUri: string): DrawioEditorResult {
  const source = normalizeDrawioSource(rawSource);
  const rawSvg = decodeDrawioSvgDataUri(svgDataUri);
  const svg = hardenInlineSvg(rawSvg);
  if (!svg) throw new Error("drawio 导出的 SVG 未通过安全校验或超过缓存上限");
  return { source, svg };
}

export function decodeDrawioSvgDataUri(dataUri: string): string {
  if (typeof dataUri !== "string" || dataUri.length === 0 || dataUri.length > MAX_SVG_DATA_URI_CHARS) {
    throw new Error("drawio SVG data URI 为空或过大");
  }
  const match = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(dataUri);
  if (!match) throw new Error("drawio export 未返回 SVG data URI");
  const payload = match[2] ?? "";
  try {
    if (match[1]) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    throw new Error("drawio SVG data URI 解码失败");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

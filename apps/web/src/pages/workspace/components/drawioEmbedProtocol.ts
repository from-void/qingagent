import {
  INLINE_SVG_MAX_BYTES,
  hardenInlineSvg,
  normalizeDrawioSource,
} from "@qingagent/pm-schema";

export const DRAWIO_EMBED_PATH =
  "/drawio/index.html?embed=1&proto=json&spin=1&offline=1&lang=zh&saveAndExit=1&keepmodified=1&suppressNewWindows=1";

export const DRAWIO_EXPORT_TIMEOUT_MS = 5_000;
export const DRAWIO_FALLBACK_TIMEOUT_MS = 5_000;
export const DRAWIO_AUTOSAVE_DEBOUNCE_MS = 1_000;
/**
 * 「完成」按钮走 save+exit，会先等这一拍原生 SVG 落定；等不到就必须强制退出。
 * 上限 = 原生导出超时 + 本地回退渲染超时 + 一点余量，保证浮层不会因为任何
 * 保存状态机的中间态被永久钉住。
 */
export const DRAWIO_CLOSE_WATCHDOG_MS =
  DRAWIO_EXPORT_TIMEOUT_MS + DRAWIO_FALLBACK_TIMEOUT_MS + 2_000;
const MAX_SVG_DATA_URI_CHARS = INLINE_SVG_MAX_BYTES * 4 + 256;

export type DrawioEditorResult = {
  source: string;
  svg: string | null;
  warning?: string;
};

export type DrawioEmbedEvent =
  | { event: "init" }
  | { event: "load" }
  | { event: "autosave"; xml: string }
  | { event: "save"; xml: string; exit?: boolean }
  | { event: "export"; data: string; exit?: boolean }
  | { event: "exit"; modified?: boolean }
  | { event: "openLink"; href?: string };

export type DrawioLoadAction = {
  action: "load";
  xml: string;
  title: string;
  saveAndExit: true;
  autosave: true;
};

export type DrawioSnapshotAction = {
  action: "snapshot";
};

export type DrawioStatusAction = {
  action: "status";
  modified: boolean;
};

export type DrawioSnapshotRequest = {
  source: string;
  action: DrawioSnapshotAction;
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
    case "autosave":
      return typeof value.xml === "string"
        ? { event: "autosave", xml: value.xml }
        : null;
    case "save":
      return typeof value.xml === "string"
        ? { event: "save", xml: value.xml, ...(value.exit === true ? { exit: true } : {}) }
        : null;
    case "export":
      return typeof value.data === "string"
        ? {
            event: "export",
            data: value.data,
            ...(typeof value.exit === "boolean" ? { exit: value.exit } : {}),
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

export function encodeDrawioAction(
  action: DrawioLoadAction | DrawioSnapshotAction | DrawioStatusAction,
): string {
  return JSON.stringify(action);
}

export function createDrawioLoadAction(source: string, title: string): DrawioLoadAction {
  return {
    action: "load",
    xml: normalizeDrawioSource(source),
    title,
    saveAndExit: true,
    autosave: true,
  };
}

/**
 * v31 的 SVG 导出只支持 snapshot action；先在宿主侧校验并固定 save 事件里的 XML，
 * 再让 iframe 针对同一拍模型回传原生 SVG。
 */
export function createDrawioSnapshotRequest(rawSource: string): DrawioSnapshotRequest {
  return {
    source: normalizeDrawioSource(rawSource),
    action: { action: "snapshot" },
  };
}

export function createDrawioStatusAction(modified: boolean): DrawioStatusAction {
  return { action: "status", modified };
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

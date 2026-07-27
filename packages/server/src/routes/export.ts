import { Hono, type Context } from "hono";
import { loadSessionFromThread, redactSensitiveText } from "@qingagent/core";
import {
  getBrowserCapabilityState,
  hasSpecializedDiagramOverlayFallback,
  hasHtmlToPdfRenderer,
  SPECIALIZED_DIAGRAM_OVERLAY_NOTICE,
  toDocx,
  toHtml,
  toMarkdown,
  toPdf,
  toTxt,
  withRenderedDiagrams,
} from "@qingagent/doc-render";
import { getSession } from "../gateway/bridgeHandler";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

type ExportFormat = "pdf" | "docx" | "txt" | "markdown" | "html";
const warnedInvalidPublicOrigins = new Set<string>();

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const FILE_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  markdown: "md",
  html: "html",
};

export const exportRoutes = new Hono();

exportRoutes.get("/export/:sessionId", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const sessionId = c.req.param("sessionId");
  const format = normalizeExportFormat(c.req.query("format"));

  if (!format) {
    return c.json({ error: "导出格式不支持，仅支持 pdf、docx、txt、markdown、html" }, 400);
  }
  if (
    format === "pdf" &&
    !hasHtmlToPdfRenderer() &&
    getBrowserCapabilityState().status === "unavailable"
  ) {
    return browserCapabilityUnavailableResponse(c);
  }

  const session = getSession(sessionId) ?? (await loadSessionFromThread(sessionId));
  if (!session) {
    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  }
  // 空文档判定:冷恢复时 threadPersistence 会把空 legacySections 合成一个 content 为空的 PmDoc,
  // 仅判 `!session.doc` 会漏掉它 → 空会话导出回 200 空骨架。把"空 PmDoc"也算作没有可导出内容。
  const hasDocContent = !!session.doc && session.doc.content.length > 0;
  if (!hasDocContent && session.legacySections.length === 0) {
    return c.json({ error: "当前会话没有可导出的文档" }, 409);
  }

  const title = session.title?.trim() || "青简导出";
  const filename = `${safeFilename(title)}.${FILE_EXTENSIONS[format]}`;
  const document = session.doc ?? session.legacySections;
  const baseUrl = requestOrigin(c.req.url, {
    forwardedHost: c.req.header("x-forwarded-host"),
    forwardedProto: c.req.header("x-forwarded-proto"),
  });
  const specializedOverlayFallback =
    (format === "pdf" || format === "docx" || format === "html") &&
    hasSpecializedDiagramOverlayFallback(document);
  let body: BodyInit;
  try {
    body = await renderExport(format, document, title, baseUrl);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "BROWSER_CAPABILITY_UNAVAILABLE"
    ) {
      return browserCapabilityUnavailableResponse(c);
    }
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "EXPORT_BUSY"
    ) {
      return exportBusyResponse(c);
    }
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "EXPORT_DEADLINE_EXCEEDED"
    ) {
      return exportDeadlineExceededResponse(c);
    }
    const internalDetail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("[export] render failed", {
      code: "EXPORT_RENDER_FAILED",
      detail: redactSensitiveText(internalDetail)
        .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g, "sk-[REDACTED]")
        .slice(0, 4_000),
    });
    return c.json({ error: "导出失败，请重试", code: "EXPORT_RENDER_FAILED" }, 500);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
      ...(specializedOverlayFallback
        ? { "X-Qingagent-Export-Notice": SPECIALIZED_DIAGRAM_OVERLAY_NOTICE }
        : {}),
    },
  });
});

function browserCapabilityUnavailableResponse(c: Context) {
  return c.json(
    {
      error: "当前部署环境无法安全启动浏览器，PDF 导出能力不可用；请联系部署管理员检查 Chromium sandbox 配置",
      code: "BROWSER_CAPABILITY_UNAVAILABLE",
    },
    503,
  );
}

function exportBusyResponse(c: Context) {
  c.header("Retry-After", "5");
  return c.json(
    {
      error: "当前导出任务较多，请稍后重试",
      code: "EXPORT_BUSY",
      retryable: true,
    },
    503,
  );
}

function exportDeadlineExceededResponse(c: Context) {
  return c.json(
    {
      error: "导出渲染超时，请重试；若持续失败请减少单次文档中的超大图片或图表",
      code: "EXPORT_DEADLINE_EXCEEDED",
      retryable: true,
    },
    504,
  );
}

function normalizeExportFormat(value: string | undefined): ExportFormat | null {
  if (value === "md") return "markdown";
  if (value === "htm") return "html";
  if (value === "pdf" || value === "docx" || value === "txt" || value === "markdown" || value === "html") return value;
  return null;
}

async function renderExport(
  format: ExportFormat,
  document: Parameters<typeof toTxt>[0],
  title: string,
  baseUrl: string,
): Promise<BodyInit> {
  switch (format) {
    case "pdf":
      return toUint8Array(await toPdf(document, { title }));
    case "docx":
      return toUint8Array(await toDocx(document, { title }));
    case "txt":
      return toTxt(document);
    case "markdown":
      return toMarkdown(document, { title, baseUrl });
    case "html":
      // HTML 导出也先服务端渲染图表(否则图表会回退成源码)。
      return toHtml(await withRenderedDiagrams(document), { title });
  }
}

function requestOrigin(
  requestUrl: string,
  forwarded: { forwardedHost?: string; forwardedProto?: string },
): string {
  const parsed = new URL(requestUrl);
  const publicOrigin = configuredPublicOrigin(process.env.QINGAGENT_PUBLIC_ORIGIN);
  if (publicOrigin) return publicOrigin;
  if (process.env.QINGAGENT_TRUST_PROXY !== "1") return parsed.origin;

  const forwardedProto = forwarded.forwardedProto?.split(",", 1)[0]?.trim().toLowerCase();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? `${forwardedProto}:`
    : parsed.protocol;
  const forwardedHost = forwarded.forwardedHost?.split(",", 1)[0]?.trim();
  if (!forwardedHost) return `${protocol}//${parsed.host}`;
  try {
    return new URL(`${protocol}//${forwardedHost}`).origin;
  } catch {
    return `${protocol}//${parsed.host}`;
  }
}

function configuredPublicOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const configured = value.trim();
  try {
    const parsed = new URL(configured);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    // 统一走下面的明确告警与既有回退。
  }
  if (!warnedInvalidPublicOrigins.has(configured)) {
    warnedInvalidPublicOrigins.add(configured);
    console.warn("Invalid QINGAGENT_PUBLIC_ORIGIN; falling back to request-derived origin", {
      config: "QINGAGENT_PUBLIC_ORIGIN",
      value: configured,
      fallback: "request origin (or trusted proxy origin when enabled)",
    });
  }
  return null;
}

function toUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) as Uint8Array<ArrayBuffer>;
}

function safeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "qingagent-export";
}

function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

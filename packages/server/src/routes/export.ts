import { Hono } from "hono";
import { loadSessionFromThread } from "@qingagent/core";
import { toDocx, toHtml, toMarkdown, toPdf, toTxt, withRenderedDiagrams } from "@qingagent/doc-render";
import { getSession } from "../bridge/bridgeHandler";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

type ExportFormat = "pdf" | "docx" | "txt" | "markdown" | "html";

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
  let body: BodyInit;
  try {
    body = await renderExport(format, document, title);
  } catch (err) {
    console.error("Export failed", err);
    return c.json({ error: "导出失败，请重试", detail: errorMessage(err) }, 500);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
    },
  });
});

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
): Promise<BodyInit> {
  switch (format) {
    case "pdf":
      return toUint8Array(await toPdf(document, { title }));
    case "docx":
      return toUint8Array(await toDocx(document, { title }));
    case "txt":
      return toTxt(document);
    case "markdown":
      return toMarkdown(document, { title });
    case "html":
      // HTML 导出也先服务端渲染图表(否则图表会回退成源码)。
      return toHtml(await withRenderedDiagrams(document), { title });
  }
}

function toUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) as Uint8Array<ArrayBuffer>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

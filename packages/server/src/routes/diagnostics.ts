import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { buildDiagnosticsZip } from "../diagnostics/exporter";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

interface DiagnosticsLogFile {
  name: string;
  bytes: number;
  mtime: number;
}

const ROLLING_LOG_RE = /^(main|spans|server)-(\d{4})-(\d{2})-(\d{2})\.(log|jsonl)$/;

export const diagnosticsRoutes = new Hono();

const diagnosticsExportBodySchema = z.object({
  privacyLevel: z.enum(["L1", "L2"]),
  report: z.string().max(200_000).optional(),
  // 用户在「报bug」勾选的具体文档(会话)id;上限 200 防滥用,缺省回退最近会话。
  sessionIds: z.array(z.string().max(200)).max(200).optional(),
});

diagnosticsRoutes.get("/diagnostics/usage", async (c) => {
  const logsDir = process.env.QINGAGENT_LOG_DIR;
  if (!logsDir) {
    return c.json({ logsDir: null, totalBytes: 0, files: [] });
  }

  const files = await listLogFiles(logsDir);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return c.json({ logsDir, totalBytes, files });
});

diagnosticsRoutes.post("/diagnostics/clear", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const logsDir = process.env.QINGAGENT_LOG_DIR;
  if (!logsDir) {
    return c.json({ deleted: 0, freedBytes: 0 });
  }

  const today = localDay(new Date());
  let deleted = 0;
  let freedBytes = 0;

  for (const file of await listLogFiles(logsDir)) {
    const match = ROLLING_LOG_RE.exec(file.name);
    if (!match) continue;
    const fileDay = `${match[2]}-${match[3]}-${match[4]}`;
    if (fileDay === today) continue;
    try {
      await rm(path.join(logsDir, file.name), { force: true });
      deleted += 1;
      freedBytes += file.bytes;
    } catch {
      // 清理是诊断旁路，单个文件失败不影响整体返回。
    }
  }

  return c.json({ deleted, freedBytes });
});

diagnosticsRoutes.post("/diagnostics/export", async (c) => {
  const parsed = await parseBody(c, diagnosticsExportBodySchema, {
    makeErrorResponse: (ctx) => ctx.json({ error: "诊断包导出参数不合法" }, 400),
  });
  if (!parsed.ok) return parsed.response;

  const result = await buildDiagnosticsZip({
    privacyLevel: parsed.data.privacyLevel,
    report: parsed.data.report,
    sessionIds: parsed.data.sessionIds,
  });
  return new Response(toUint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(result.filename),
      "Cache-Control": "no-store",
    },
  });
});

async function listLogFiles(logsDir: string): Promise<DiagnosticsLogFile[]> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return [];
  }

  const files: DiagnosticsLogFile[] = [];
  for (const name of names) {
    const filePath = path.join(logsDir, name);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      files.push({
        name,
        bytes: fileStat.size,
        mtime: fileStat.mtimeMs,
      });
    } catch {
      // 文件可能被并发清理，跳过即可。
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) as Uint8Array<ArrayBuffer>;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

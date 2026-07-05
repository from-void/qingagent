// F6/F7 debug 路由(产品决策:生产也开放;这里对所有可变文本做脱敏/截断,
// 避免 installed skill 或 schema examples 意外带出 key/token/绝对路径)。
//
// GET /debug/context?sessionId=  — F6 对话上下文占用(最近一次真实 inputTokens / 窗口)
// GET /debug/skills              — F7 skill 清单(含来源/启用态)
// GET /debug/skills/:name/raw    — F7 skill 原始 SKILL.md(路径来自扫描清单,无穿越面)
// GET /debug/tools               — F7 工具原始视图(id/description/JSON Schema)

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEEPSEEK_CONTEXT_WINDOWS,
  DEEPSEEK_MODEL_IDS,
  describeToolsForDebug,
  latestAgentUsageForSession,
  readDisabledSet,
} from "@qingagent/core";
import { isDebugEndpointEnabled } from "../lib/debugGate";
import { listAllSkillItems } from "./skills";

export const debugRoutes = new Hono();

function isDebugRoutePath(path: string): boolean {
  // 前缀精确匹配(挂载于 /api/v1 或裸挂两种形态),不能用 includes——
  // 否则 /api/v1/skills/debug/enable 这类"参数恰为 debug"的兄弟路由会被误拦。
  return (
    path === "/debug" ||
    path.startsWith("/debug/") ||
    path === "/api/v1/debug" ||
    path.startsWith("/api/v1/debug/")
  );
}

debugRoutes.use("*", async (c, next) => {
  // Hono 子 app 挂到 /api/v1 时,use("*") 也会看到后续兄弟路由;只拦 debug 段。
  if (!isDebugRoutePath(c.req.path)) return next();
  // 默认 404(不用 403:不向探测者确认路由存在)。开放条件见 debugGate。
  if (!isDebugEndpointEnabled()) return c.json({ error: "not found" }, 404);
  return next();
});

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RAW_SKILL_BYTES = 128 * 1024;
const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|private[_-]?key|session[_-]?token)/i;

function truncateUtf8ForDebug(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  let used = 0;
  let end = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: true, originalBytes };
}

function redactDebugText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sk-proj|sk-ant|sk-or|sk-deepseek)-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(
      /([?&](?:api[_-]?key|key|token|access_token|refresh_token|secret|password)=)[^&\s"'`)<>]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY|SESSION[_-]?TOKEN)[A-Z0-9_.-]*\s*[:=]\s*)(["']?)[^"',\s}\])]+(["']?)/gi,
      (_match, prefix: string, quote: string, tailQuote: string) =>
        `${prefix}${quote}[REDACTED]${quote && tailQuote === quote ? quote : ""}`,
    )
    .replace(
      /(^|[\s(["'=])\/(?:Users|home|root|tmp|var|etc|opt|srv|mnt|Volumes|private|app|workspace|data)\/[^\s"'`)<>]*/g,
      "$1[REDACTED_PATH]",
    )
    .replace(/\b[A-Za-z]:\\[^\s"'`)<>]+/g, "[REDACTED_PATH]");
}

function redactDebugValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactDebugText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactDebugValue(nested, seen);
  }
  return out;
}

debugRoutes.get("/debug/context", async (c) => {
  const sessionId = c.req.query("sessionId")?.trim();
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  if (sessionId.length > 128) return c.json({ error: "invalid sessionId" }, 400);
  try {
    const latest = await latestAgentUsageForSession(sessionId);
    if (!latest) {
      return c.json({
        sessionId,
        available: false,
        contextWindow: DEEPSEEK_CONTEXT_WINDOWS[DEEPSEEK_MODEL_IDS.flash],
      });
    }
    const contextWindow =
      DEEPSEEK_CONTEXT_WINDOWS[latest.modelId] ??
      DEEPSEEK_CONTEXT_WINDOWS[DEEPSEEK_MODEL_IDS.flash] ??
      1_000_000;
    return c.json({
      sessionId,
      available: true,
      modelId: latest.modelId,
      // 口径:最近一次 agent step 的真实 inputTokens ≈ 当前上下文体积(含系统提示+文档快照)。
      lastInputTokens: latest.inputTokens,
      lastOutputTokens: latest.outputTokens,
      contextWindow,
      percentUsed: contextWindow > 0 ? (latest.inputTokens / contextWindow) * 100 : 0,
      measuredAt: latest.createdAt,
    });
  } catch (err) {
    console.warn("[debug] context failed", { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "debug context failed" }, 500);
  }
});

debugRoutes.get("/debug/skills", async (c) => {
  const disabled = await readDisabledSet();
  const skills = await listAllSkillItems(disabled);
  return c.json({
    skills: skills.map((s) => ({
      name: s.name,
      description: redactDebugText(s.description),
      source: s.source,
      enabled: s.enabled,
      userInvocable: s.userInvocable,
    })),
  });
});

debugRoutes.get("/debug/skills/:name/raw", async (c) => {
  const name = c.req.param("name");
  if (!SKILL_NAME_RE.test(name)) return c.json({ error: "invalid skill name" }, 400);
  const disabled = await readDisabledSet();
  // 路径只取自扫描清单(白名单),URL 中的 name 仅用于匹配,杜绝路径穿越。
  const skill = (await listAllSkillItems(disabled)).find((s) => s.name === name);
  if (!skill) return c.json({ error: "skill not found" }, 404);
  try {
    const raw = await readFile(join(skill.path, "SKILL.md"), "utf8");
    const redacted = redactDebugText(raw);
    const truncated = truncateUtf8ForDebug(redacted, MAX_RAW_SKILL_BYTES);
    return c.json({
      name: skill.name,
      source: skill.source,
      enabled: skill.enabled,
      raw: truncated.text,
      truncated: truncated.truncated,
      originalBytes: truncated.originalBytes,
      maxBytes: MAX_RAW_SKILL_BYTES,
    });
  } catch {
    return c.json({ error: "failed to read SKILL.md" }, 500);
  }
});

debugRoutes.get("/debug/tools", async (c) => {
  try {
    return c.json({ tools: redactDebugValue(await describeToolsForDebug()) });
  } catch (err) {
    console.warn("[debug] tools failed", { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "debug tools failed" }, 500);
  }
});

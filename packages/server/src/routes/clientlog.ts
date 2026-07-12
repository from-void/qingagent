import { Hono } from "hono";
import { z } from "zod";
import { mastra, getObservability, sessionIdToTraceId } from "@qingagent/core";
import { SpanType } from "@mastra/core/observability";
import { parseOrigin } from "../gateway/bridgeHandler";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

/** clientlog 请求体:events 数组(逐条元素形状由下方业务清洗,不在此深校验)。 */
const clientLogBodySchema = z.object({ events: z.array(z.unknown()) });

/**
 * Layer ① 前端点击流上报端点（阶段5b）。
 *
 * `POST /api/v1/clientlog`：前端批量上报 client_event。每条事件记一条
 * `SpanType.GENERIC`（name=`client_event`）span，与后端命令/模型/DB span 用
 * 同一 traceId（`sessionIdToTraceId(sessionId)`）+ `metadata.clientTraceId` 关联，
 * 实现"点击 → 命令 → 模型 → DB"四层串联（见设计文档 §三 Layer ① / §十）。
 *
 * 防滥用：单请求 ≤ MAX_EVENTS 条；超出截断（不报错，旁路日志不阻塞前端）。
 * observability 失败只 warn，永远返回 {ok:true}。
 */

/** 单请求最多接收的事件数（与前端 BATCH_MAX 对齐，防滥用）。 */
const MAX_EVENTS = 50;
/** 单条 event 的 meta 序列化后字节上限（信任边界防护：前端摘要不可信，硬截断）。 */
const MAX_META_BYTES = 2048;
/** action / target 字符串长度上限（防超长字段污染 span）。 */
const MAX_STR_LEN = 200;

/**
 * 归一化 clientTraceId 到 32hex（与 /stream 入口同协议）。非法/缺失返回 undefined。
 * 信任边界：前端任意串都先清洗去 dash/小写，恰好 32hex 才接受。
 */
function normalizeClientTraceId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const cleaned = raw.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(cleaned) ? cleaned : undefined;
}

/**
 * 信任边界净化客户端 meta：只保留可 JSON 序列化、且总字节 ≤ MAX_META_BYTES 的对象，
 * 超限丢弃（不报错）。前端 summarizeCommandForLog 只放计数/枚举，但后端不能信任前端，
 * 故在此硬截断，杜绝用户正文/大对象灌进 span（修 Codex review）。
 */
function sanitizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  try {
    const json = JSON.stringify(meta);
    if (json.length > MAX_META_BYTES) {
      return { _truncated: true, _bytes: json.length };
    }
    return meta as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 单条客户端事件（与前端 clientLog.ts 的形状一致）。 */
interface ClientEventInput {
  clientTraceId?: string;
  sessionId?: string;
  action?: string;
  target?: string;
  ts?: number;
  meta?: Record<string, unknown>;
}

export const clientLogRoutes = new Hono();

clientLogRoutes.post("/clientlog", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsed = await parseBody(c, clientLogBodySchema);
  if (!parsed.ok) return parsed.response;

  // 防滥用：截断到上限（多余的丢弃，不报错）。
  const sliced = (parsed.data.events as ClientEventInput[]).slice(0, MAX_EVENTS);

  let recorded = 0;
  // 0603 — 触发来源:client_event(Layer①)也读 x-origin,与 ②③④ 入口口径一致(缺省 manual)。
  const origin = parseOrigin(c.req.header("x-origin"));
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (instance) {
      for (const ev of sliced) {
        if (!ev || typeof ev !== "object") continue;
        const action =
          typeof ev.action === "string"
            ? ev.action.slice(0, MAX_STR_LEN)
            : "unknown";
        const sessionId =
          typeof ev.sessionId === "string" && ev.sessionId
            ? ev.sessionId.slice(0, MAX_STR_LEN)
            : undefined;
        // 信任边界：clientTraceId 必须是 32hex（与 /stream 同协议），否则丢弃。
        const clientTraceId = normalizeClientTraceId(ev.clientTraceId);
        const target =
          typeof ev.target === "string"
            ? ev.target.slice(0, MAX_STR_LEN)
            : undefined;
        // 有 sessionId 才能算会话级 traceId（与 ②③④ 同源）；无则省略，
        // 仍可经 metadata.clientTraceId 单次动作关联。
        const traceId = sessionId ? sessionIdToTraceId(sessionId) : undefined;
        try {
          const span = instance.startSpan({
            type: SpanType.GENERIC,
            name: "client_event",
            traceId,
            metadata: {
              eventKind: "client_event",
              action,
              sessionId,
              clientTraceId,
              origin,
            },
            input: {
              target,
              meta: sanitizeMeta(ev.meta),
              clientTs: typeof ev.ts === "number" ? ev.ts : undefined,
            },
          });
          span?.end();
          recorded += 1;
        } catch (err) {
          mastra.getLogger().warn("clientlog span failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    mastra.getLogger().warn("clientlog handler failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return c.json({ ok: true, recorded });
});

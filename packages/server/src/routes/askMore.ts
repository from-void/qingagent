import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { isPlanDraftTool, streamMoreQuestions, schedulePersist } from "@qingagent/core";
import type { AskUserQuestion } from "@qingagent/contract-ts";
import { RequestContext } from "@mastra/core/request-context";
import { getSession } from "../bridge/bridgeHandler";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

export const askMoreRoutes = new Hono();

/** ask-more 请求体:sessionId 必填;当前问卷/答案沿用前端形状(与旧内联类型一致)。 */
const askMoreBodySchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  currentQuestions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        kind: z.object({ kind: z.string() }),
        options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
      }),
    )
    .optional(),
  currentAnswers: z
    .record(
      z.string(),
      z.object({
        chosen: z.array(z.string()).optional(),
        freeText: z
          .string()
          .nullable()
          .optional()
          .transform((value) => value ?? undefined),
      }),
    )
    .optional(),
});

const PUBLIC_ASK_MORE_ERROR = "上游模型服务暂时不可用，请稍后重试";
const JSON_SECRET_HEADER_RE = /(["'](?:authorization|x-api-key)["']\s*:\s*["'])(?:Bearer\s+)?[^"']+(["'])/gi;
const TEXT_SECRET_HEADER_RE = /\b(authorization|x-api-key)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s"',;}\]]+/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g;

export function redactAskMoreErrorForLog(error: unknown): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return raw
    .replace(JSON_SECRET_HEADER_RE, "$1[REDACTED]$2")
    .replace(TEXT_SECRET_HEADER_RE, "$1$2[REDACTED]")
    .replace(SK_TOKEN_RE, "sk-[REDACTED]");
}

export function publicAskMoreErrorMessage(): string {
  return PUBLIC_ASK_MORE_ERROR;
}

// streamMoreQuestions 输出的问题结构(与 AskUserQuestion 结构兼容)。
type AskMoreQuestion = {
  id: string;
  label: string;
  kind: { kind: "single" | "multi" | "text" };
  options: Array<{ value: string; label: string; description?: string | null; preview?: string | null }>;
  placeholder?: string | null;
};

/**
 * 把"问我更多"生成的追加问题并入会话里当前 open 的 askUser toolCall spec.questions。
 * 否则这些问题只存在于前端 BigPlanPanel 本地 state,提交后对话流里的折叠卡片(从
 * toolCall spec.questions 渲染)看不到这些问答 —— 即"提交到对话流里的卡片不生效"。
 */
export function hasOpenPlanDraftQuestionnaire(
  session: NonNullable<ReturnType<typeof getSession>>,
): boolean {
  return findOpenPlanDraftQuestionnaireId(session) !== null;
}

export function isOpenPlanDraftQuestionnaire(
  session: NonNullable<ReturnType<typeof getSession>>,
  toolCallId: string,
): boolean {
  return session.chatHistory.some((message) => message.parts.some((part) =>
    part.kind === "toolCall" &&
    part.data.id === toolCallId &&
    isPlanDraftTool(part.data.name) &&
    part.data.body.kind === "askUser" &&
    (part.data.status.kind === "pending" || part.data.status.kind === "running"),
  ));
}

export function findOpenPlanDraftQuestionnaireId(
  session: NonNullable<ReturnType<typeof getSession>>,
): string | null {
  for (let mi = session.chatHistory.length - 1; mi >= 0; mi--) {
    const message = session.chatHistory[mi]!;
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi]!;
      if (
        part.kind === "toolCall" &&
        isPlanDraftTool(part.data.name) &&
        part.data.body.kind === "askUser" &&
        (part.data.status.kind === "pending" || part.data.status.kind === "running")
      ) {
        return part.data.id;
      }
    }
  }
  return null;
}

export function appendAskMoreQuestions(
  session: NonNullable<ReturnType<typeof getSession>>,
  toolCallId: string,
  newQuestions: AskMoreQuestion[],
): boolean {
  if (newQuestions.length === 0) return false;
  for (let mi = session.chatHistory.length - 1; mi >= 0; mi--) {
    const msg = session.chatHistory[mi]!;
    for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
      const part = msg.parts[pi]!;
      if (part.kind !== "toolCall") continue;
      const spec = part.data;
      if (spec.id !== toolCallId) continue;
      if (!isPlanDraftTool(spec.name)) continue;
      if (spec.body.kind !== "askUser") continue;
      if (spec.status.kind !== "pending" && spec.status.kind !== "running") continue;
      const existing = new Set(spec.body.data.questions.map((q) => q.id));
      const mapped: AskUserQuestion[] = newQuestions
        .filter((q) => !existing.has(q.id))
        .map((q) => ({
          id: q.id,
          label: q.label,
          kind: q.kind,
          options: q.options.map((o) => ({
            value: o.value,
            label: o.label,
            description: o.description ?? null,
            preview: o.preview ?? null,
          })),
          placeholder: q.placeholder ?? null,
        }));
      if (mapped.length === 0) return false;
      msg.parts[pi] = {
        kind: "toolCall",
        data: {
          ...spec,
          body: {
            kind: "askUser",
            data: { ...spec.body.data, questions: [...spec.body.data.questions, ...mapped] },
          },
        },
      };
      void schedulePersist(session, "askMore").catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * POST /api/v1/ask-more — stream follow-up questions via SSE.
 *
 * Body: { sessionId, currentQuestions, currentAnswers }
 * SSE events: { type: "progress", questions: [...] } and { type: "done", questions: [...] }
 */
askMoreRoutes.post("/ask-more", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsed = await parseBody(c, askMoreBodySchema);
  if (!parsed.ok) return parsed.response;
  const { sessionId, toolCallId, currentQuestions, currentAnswers } = parsed.data;

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (!isOpenPlanDraftQuestionnaire(session, toolCallId)) {
    return c.json({ error: "当前问卷不支持追加问题" }, 409);
  }
  const targetToolCallId = toolCallId;
  const modelOverrides = await resolveRequestModelOverrides({
    visitorKey: c.req.header("x-deepseek-key"),
    baseUrl: c.req.header("x-model-base-url"),
    modelFlash: c.req.header("x-model-flash"),
    modelPro: c.req.header("x-model-pro"),
    modelTier: c.req.header("x-model-tier"),
    protocol: c.req.header("x-model-protocol"),
    visionKey: c.req.header("x-vision-key"),
    visionBaseUrl: c.req.header("x-vision-base-url"),
    visionModel: c.req.header("x-vision-model"),
    visionProtocol: c.req.header("x-vision-protocol"),
  });
  session.modelOverrides = modelOverrides;
  const requestContext = new RequestContext([
    ["sessionId", session.sessionId],
    ["modelOverrides", modelOverrides],
  ] as never) as RequestContext;

  const conversationSummary = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-10)
    .map((m) => {
      const role = m.role === "user" ? "用户" : "助手";
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && "type" in p && p.type === "text")
                .map((p) => p.text)
                .join(" ")
            : "";
      return `${role}: ${text.slice(0, 200)}`;
    })
    .join("\n");

  return streamSSE(c, async (stream) => {
    try {
      let lastQuestions: unknown[] = [];
      for await (const partial of streamMoreQuestions({
        conversationSummary,
        currentQuestions: currentQuestions ?? [],
        currentAnswers: currentAnswers ?? {},
        requestContext,
        abortSignal: c.req.raw.signal,
      })) {
        lastQuestions = partial;
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify({ questions: partial }),
        });
      }
      // 回写到 open askUser toolCall,确保提交后折叠卡片能展示这些追加问答。
      // 只允许回写请求开始时捕获的同一张问卷；期间提交/取消后不污染新问卷。
      appendAskMoreQuestions(session, targetToolCallId, lastQuestions as AskMoreQuestion[]);
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ questions: lastQuestions }),
      });
    } catch (err) {
      console.error("[ask-more] streaming failed:", redactAskMoreErrorForLog(err));
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: publicAskMoreErrorMessage(), retriable: true }),
      });
    }
  });
});

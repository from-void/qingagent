import { Hono } from "hono";
import { assembleReviewQuery } from "@qingagent/contract-ts";
import type { ReviewTemplateItem, ReviewType } from "@qingagent/contract-ts";
import {
  deleteReviewTemplate,
  getReviewDocSupplement,
  getReviewTemplate,
  getSelectedReviewTemplate,
  listReviewTemplates,
  ReviewTemplateMutationError,
  saveReviewTemplate,
  selectReviewTemplate,
  upsertReviewDocSupplement,
} from "@qingagent/db";
import { getOrRestoreSession } from "../gateway/bridgeHandler";
import { externalError } from "../lib/externalError";
import { queueExternalChat } from "../lib/externalChatQueue";

export const externalTemplateRoutes = new Hono();

const REVIEW_TYPES = new Set<ReviewType>([
  "sensitive",
  "deai",
  "source",
  "consistency",
  "privacy",
  "format",
  "role",
  "custom",
]);
const MUTATION_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTemplateMutationAllowed(): boolean {
  const raw = process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION;
  return raw !== undefined && MUTATION_ENABLED_VALUES.has(raw.trim().toLowerCase());
}

externalTemplateRoutes.get("/review-templates", async (c) => {
  const startedAt = Date.now();
  const rawType = c.req.query("type");
  if (rawType !== undefined && !isReviewType(rawType)) {
    return rejected(c, "template_list", startedAt, 400, "VALIDATION", "type 不合法");
  }
  const templates = await listReviewTemplates(rawType);
  const selectedByType = new Map<ReviewType, string | null>();
  await Promise.all([...new Set(templates.map((template) => template.type))].map(async (type) => {
    selectedByType.set(type, (await getSelectedReviewTemplate(type))?.id ?? null);
  }));
  logTemplateRequest(c, "template_list", startedAt, "ok");
  return c.json({
    templates: templates.map((template) =>
      serializeTemplate(template, selectedByType.get(template.type) === template.id)
    ),
  });
});

externalTemplateRoutes.get("/review-templates/:id", async (c) => {
  const startedAt = Date.now();
  const template = await getReviewTemplate(c.req.param("id"));
  if (!template) {
    return rejected(c, "template_show", startedAt, 404, "NOT_FOUND", "审查模板不存在");
  }
  const selected = await getSelectedReviewTemplate(template.type);
  logTemplateRequest(c, "template_show", startedAt, "ok");
  return c.json({ template: serializeTemplate(template, selected?.id === template.id) });
});

externalTemplateRoutes.post("/review-templates", async (c) => {
  const startedAt = Date.now();
  const gated = requireTemplateMutation(c, "template_create", startedAt);
  if (gated) return gated;
  const body = await c.req.json().catch(() => null) as {
    type?: unknown;
    name?: unknown;
    prompt?: unknown;
  } | null;
  if (
    !isReviewType(body?.type) ||
    typeof body?.name !== "string" ||
    !body.name.trim() ||
    typeof body?.prompt !== "string" ||
    !body.prompt.trim()
  ) {
    return rejected(c, "template_create", startedAt, 400, "VALIDATION", "type、name、prompt 不合法");
  }
  const template = await saveReviewTemplate({
    type: body.type,
    name: body.name,
    prompt: body.prompt,
  });
  const selected = await getSelectedReviewTemplate(template.type);
  logTemplateRequest(c, "template_create", startedAt, "created");
  return c.json({ template: serializeTemplate(template, selected?.id === template.id) }, 201);
});

externalTemplateRoutes.put("/review-templates/:id", async (c) => {
  const startedAt = Date.now();
  const gated = requireTemplateMutation(c, "template_update", startedAt);
  if (gated) return gated;
  const body = await c.req.json().catch(() => null) as {
    name?: unknown;
    prompt?: unknown;
    expectedUpdatedAt?: unknown;
  } | null;
  if (
    !body ||
    typeof body.expectedUpdatedAt !== "string" ||
    !body.expectedUpdatedAt ||
    (body.name === undefined && body.prompt === undefined) ||
    (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) ||
    (body.prompt !== undefined && (typeof body.prompt !== "string" || !body.prompt.trim()))
  ) {
    return rejected(
      c,
      "template_update",
      startedAt,
      400,
      "VALIDATION",
      "name、prompt 或 expectedUpdatedAt 不合法",
    );
  }
  const existing = await getReviewTemplate(c.req.param("id"));
  if (!existing) {
    return rejected(c, "template_update", startedAt, 404, "NOT_FOUND", "审查模板不存在");
  }
  try {
    const template = await saveReviewTemplate({
      id: existing.id,
      type: existing.type,
      name: typeof body.name === "string" ? body.name : existing.name,
      prompt: typeof body.prompt === "string" ? body.prompt : existing.prompt,
      expectedUpdatedAt: body.expectedUpdatedAt,
    });
    const selected = await getSelectedReviewTemplate(template.type);
    logTemplateRequest(c, "template_update", startedAt, "updated");
    return c.json({ template: serializeTemplate(template, selected?.id === template.id) });
  } catch (error) {
    return templateMutationError(c, error, "template_update", startedAt);
  }
});

externalTemplateRoutes.delete("/review-templates/:id", async (c) => {
  const startedAt = Date.now();
  const gated = requireTemplateMutation(c, "template_delete", startedAt);
  if (gated) return gated;
  try {
    if (!await deleteReviewTemplate(c.req.param("id"))) {
      return rejected(c, "template_delete", startedAt, 404, "NOT_FOUND", "审查模板不存在");
    }
    logTemplateRequest(c, "template_delete", startedAt, "deleted");
    return c.json({ deleted: true as const, id: c.req.param("id") });
  } catch (error) {
    return templateMutationError(c, error, "template_delete", startedAt);
  }
});

externalTemplateRoutes.post("/review-templates/:id/select", async (c) => {
  const startedAt = Date.now();
  const gated = requireTemplateMutation(c, "template_select", startedAt);
  if (gated) return gated;
  const template = await getReviewTemplate(c.req.param("id"));
  if (!template) {
    return rejected(c, "template_select", startedAt, 404, "NOT_FOUND", "审查模板不存在");
  }
  await selectReviewTemplate(template.type, template.id);
  logTemplateRequest(c, "template_select", startedAt, "selected");
  return c.json({ selected: true as const, id: template.id, type: template.type });
});

externalTemplateRoutes.get("/sessions/:id/review-supplement", async (c) => {
  const startedAt = Date.now();
  const type = c.req.query("type");
  if (!isReviewType(type)) {
    return rejected(c, "review_supplement_get", startedAt, 400, "VALIDATION", "type 不合法");
  }
  const session = await getOrRestoreSession(c.req.param("id"));
  if (!session) {
    return rejected(c, "review_supplement_get", startedAt, 404, "SESSION_NOT_FOUND");
  }
  const supplement = await getReviewDocSupplement(session.docId, type);
  logTemplateRequest(c, "review_supplement_get", startedAt, "ok");
  return c.json({ sessionId: session.sessionId, type, supplement });
});

externalTemplateRoutes.put("/sessions/:id/review-supplement", async (c) => {
  const startedAt = Date.now();
  const gated = requireTemplateMutation(c, "review_supplement_put", startedAt);
  if (gated) return gated;
  const type = c.req.query("type");
  const body = await c.req.json().catch(() => null) as { supplement?: unknown } | null;
  if (!isReviewType(type) || typeof body?.supplement !== "string") {
    return rejected(
      c,
      "review_supplement_put",
      startedAt,
      400,
      "VALIDATION",
      "type 或 supplement 不合法",
    );
  }
  const session = await getOrRestoreSession(c.req.param("id"));
  if (!session) {
    return rejected(c, "review_supplement_put", startedAt, 404, "SESSION_NOT_FOUND");
  }
  const supplement = await upsertReviewDocSupplement(
    session.docId,
    type,
    body.supplement,
  );
  logTemplateRequest(c, "review_supplement_put", startedAt, "saved");
  return c.json({ sessionId: session.sessionId, type, supplement });
});

externalTemplateRoutes.post("/sessions/:id/review/run", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json().catch(() => null) as {
    type?: unknown;
    templateId?: unknown;
    supplement?: unknown;
  } | null;
  if (
    !isReviewType(body?.type) ||
    (body.templateId !== undefined && typeof body.templateId !== "string") ||
    (body.supplement !== undefined && typeof body.supplement !== "string")
  ) {
    return rejected(c, "review_run", startedAt, 400, "VALIDATION", "type、templateId 或 supplement 不合法");
  }
  const session = await getOrRestoreSession(c.req.param("id"));
  if (!session) {
    return rejected(c, "review_run", startedAt, 404, "SESSION_NOT_FOUND");
  }
  const template = body.templateId
    ? await getReviewTemplate(body.templateId)
    : await getSelectedReviewTemplate(body.type);
  if (!template || template.type !== body.type) {
    return rejected(c, "review_run", startedAt, 404, "NOT_FOUND", "审查模板不存在或类型不匹配");
  }
  const supplement = typeof body.supplement === "string"
    ? body.supplement
    : await getReviewDocSupplement(session.docId, body.type);
  const text = assembleReviewQuery(body.type, template, supplement);
  return queueExternalChat(c, {
    sessionId: session.sessionId,
    text,
    event: "review_run",
    reviewContext: {
      type: body.type,
      templateId: template.id,
      templateName: template.name,
    },
    responseExtra: { type: body.type, templateId: template.id },
  });
});

function isReviewType(value: unknown): value is ReviewType {
  return typeof value === "string" && REVIEW_TYPES.has(value as ReviewType);
}

function serializeTemplate(template: ReviewTemplateItem, selected: boolean) {
  return { ...template, selected };
}

function requireTemplateMutation(
  c: Parameters<typeof externalError>[0],
  evt: string,
  startedAt: number,
): Response | null {
  if (isTemplateMutationAllowed()) return null;
  logTemplateRequest(c, evt, startedAt, "rejected:GATE");
  return externalError(c, 403, "VALIDATION", "当前环境已禁止修改审查模板");
}

function templateMutationError(
  c: Parameters<typeof externalError>[0],
  error: unknown,
  evt: string,
  startedAt: number,
) {
  if (error instanceof ReviewTemplateMutationError) {
    logTemplateRequest(c, evt, startedAt, `rejected:${error.code}`);
    return externalError(
      c,
      409,
      "CONFLICT",
      error.message,
      error.code === "CONFLICT"
        ? "用 `qa template pull <id> --out <file.md>` 拉取最新版本后再修改"
        : undefined,
    );
  }
  throw error;
}

function rejected(
  c: Parameters<typeof externalError>[0],
  evt: string,
  startedAt: number,
  status: 400 | 404,
  code: "VALIDATION" | "NOT_FOUND" | "SESSION_NOT_FOUND",
  message?: string,
) {
  logTemplateRequest(c, evt, startedAt, `rejected:${code}`);
  return externalError(c, status, code, message);
}

function logTemplateRequest(
  c: Parameters<typeof externalError>[0],
  evt: string,
  startedAt: number,
  result: string,
): void {
  const rawClient = c.req.header("x-qa-client");
  const client = rawClient === "claudecode" || rawClient === "codex" ? rawClient : "agent";
  console.log(
    `[external] evt=${evt} client=${client} session=${c.req.param("id") || "-"} ms=${Date.now() - startedAt} result=${result}`,
  );
}

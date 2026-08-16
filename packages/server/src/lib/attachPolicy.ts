import type { Context, MiddlewareHandler } from "hono";
import type {
  AttachCapability,
  Command,
} from "@qingagent/contract-ts";
import { getPrincipalAuthFailure, getRequestPrincipal, type RequestPrincipal } from "./principal";
import { attachSessionHasCapability } from "./attachSessions";
import { requestSocketAddress } from "./sseAdmission";
import { resolveUploadMaxBytes } from "./uploadLimits";
import { externalError } from "./externalError";
import { hasCommandsModelOverrideHeader } from "./commandRequestHeaders";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ServerRouteCatalogEntry {
  method: RouteMethod;
  honoPathTemplate: string;
}

/**
 * server 业务 endpoint 的防漂移目录。测试与 Hono app.routes 做集合相等；新增路由未登记即失败。
 * ALL middleware 与 route-level bodyLimit 产生的重复项不属于 endpoint，测试会归一化剔除。
 */
export const SERVER_ROUTE_CATALOG = [
  ["GET", "/health"],
  ["POST", "/api/v1/auth/session"],
  ["POST", "/api/v1/attach/handshake"],
  ["GET", "/api/v1/home"],
  ["DELETE", "/api/v1/sessions/:id"],
  ["GET", "/api/v1/history"],
  ["GET", "/api/v1/history/:versionId"],
  ["POST", "/api/v1/commands"],
  ["GET", "/api/v1/events"],
  ["POST", "/api/v1/commit"],
  ["POST", "/api/v1/confirms/cancel"],
  ["POST", "/api/v1/confirms/decision"],
  ["GET", "/api/v1/settings/security"],
  ["POST", "/api/v1/settings/security/bypass"],
  ["POST", "/api/v1/settings/security/:kind"],
  ["GET", "/api/v1/settings/memory"],
  ["PUT", "/api/v1/settings/memory"],
  ["GET", "/api/v1/settings/credential-share"],
  ["POST", "/api/v1/settings/credential-share"],
  ["POST", "/api/v1/upload"],
  ["GET", "/api/v1/files/:fileId"],
  ["GET", "/api/v1/files/:fileId/:filename"],
  ["GET", "/api/v1/materials/:materialId/text"],
  ["POST", "/api/v1/ask-more"],
  ["GET", "/api/v1/export/:sessionId"],
  ["GET", "/api/v1/skills"],
  ["GET", "/api/v1/skills/:name"],
  ["POST", "/api/v1/skills/install"],
  ["POST", "/api/v1/skills/:name/:action"],
  ["PATCH", "/api/v1/skills/:name"],
  ["DELETE", "/api/v1/skills/:name"],
  ["GET", "/api/v1/credentials"],
  ["POST", "/api/v1/credentials"],
  ["DELETE", "/api/v1/credentials/:platform"],
  ["POST", "/api/v1/clientlog"],
  ["GET", "/api/v1/debug/context"],
  ["GET", "/api/v1/debug/skills"],
  ["GET", "/api/v1/debug/skills/:name/raw"],
  ["GET", "/api/v1/debug/tools"],
  ["GET", "/api/v1/data/stats"],
  ["GET", "/api/v1/data/sessions"],
  ["GET", "/api/v1/data/usage/export"],
  ["DELETE", "/api/v1/data/usage"],
  ["POST", "/api/v1/folder-bridge/register"],
  ["POST", "/api/v1/folder-bridge/unregister"],
  ["GET", "/api/v1/folder-bridge/events"],
  ["POST", "/api/v1/folder-bridge/responses/:requestId"],
  ["GET", "/api/v1/settings/model"],
  ["PUT", "/api/v1/settings/model"],
  ["GET", "/api/v1/settings/model/balance"],
  ["POST", "/api/v1/settings/model/test-custom"],
  ["POST", "/api/v1/settings/vision/test"],
  ["GET", "/api/v1/settings/search"],
  ["GET", "/api/v1/settings/search/primary"],
  ["PUT", "/api/v1/settings/search/primary"],
  ["PUT", "/api/v1/settings/search/:id"],
  ["POST", "/api/v1/settings/search/:id/test"],
  ["GET", "/api/v1/usage/summary"],
  ["GET", "/api/v1/usage/docstats"],
  ["GET", "/api/v1/capabilities"],
  ["GET", "/api/v1/connectors"],
  ["GET", "/api/v1/connectors/:id"],
  ["POST", "/api/v1/connectors/:id/start"],
  ["POST", "/api/v1/connectors/:id/probe"],
  ["DELETE", "/api/v1/connectors/:id/pending/:pendingId"],
  ["DELETE", "/api/v1/connectors/:id"],
  ["GET", "/api/v1/sessions/:sessionId/folder-sources/:folderId/entries"],
  ["GET", "/api/v1/sessions/:sessionId/folder-sources/:folderId/file"],
  ["GET", "/api/v1/diagnostics/usage"],
  ["POST", "/api/v1/diagnostics/clear"],
  ["POST", "/api/v1/diagnostics/export"],
  ["GET", "/api/v1/external/review-templates"],
  ["GET", "/api/v1/external/review-templates/:id"],
  ["POST", "/api/v1/external/review-templates"],
  ["PUT", "/api/v1/external/review-templates/:id"],
  ["DELETE", "/api/v1/external/review-templates/:id"],
  ["POST", "/api/v1/external/review-templates/:id/select"],
  ["GET", "/api/v1/external/sessions/:id/review-supplement"],
  ["PUT", "/api/v1/external/sessions/:id/review-supplement"],
  ["POST", "/api/v1/external/sessions/:id/review/run"],
  ["GET", "/api/v1/external/skills"],
  ["GET", "/api/v1/external/skills/:name"],
  ["POST", "/api/v1/external/skills"],
  ["PUT", "/api/v1/external/skills/:name"],
  ["DELETE", "/api/v1/external/skills/:name"],
  ["POST", "/api/v1/external/skills/:name/:action"],
  ["GET", "/api/v1/external/health"],
  ["GET", "/api/v1/external/sessions"],
  ["POST", "/api/v1/external/sessions"],
  ["GET", "/api/v1/external/sessions/:id/doc"],
  ["PUT", "/api/v1/external/sessions/:id/doc"],
  ["GET", "/api/v1/external/sessions/:id/review"],
  ["GET", "/api/v1/external/sessions/:id/review/patches/:patchId"],
  ["GET", "/api/v1/external/sessions/:id/review/annotations/:annotationId"],
  ["POST", "/api/v1/external/sessions/:id/review/verdicts"],
  ["POST", "/api/v1/external/sessions/:id/review/commit"],
  ["POST", "/api/v1/external/sessions/:id/review/annotations/ignore"],
  ["GET", "/api/v1/external/sessions/:id/chat"],
  ["POST", "/api/v1/external/sessions/:id/assets"],
  ["GET", "/api/v1/external/sessions/:id/assets/:ref"],
  ["GET", "/api/v1/external/sessions/:id/files"],
  ["GET", "/api/v1/external/sessions/:id/files/:materialId/text"],
  ["POST", "/api/v1/external/sessions/:id/proposals"],
  ["POST", "/api/v1/external/sessions/:id/chat"],
  ["GET", "/api/v1/external/sessions/:id/events"],
].map(([method, honoPathTemplate]) => ({ method, honoPathTemplate })) as readonly ServerRouteCatalogEntry[];

export interface AttachParamConstraint {
  maxLength: number;
  pattern: RegExp;
  forbidDotDot?: boolean;
}

export interface AttachRoutePolicyEntry extends ServerRouteCatalogEntry {
  paramConstraints: Readonly<Record<string, AttachParamConstraint>>;
  bodyLimit: number;
  headerLimit: number;
  requiredCapability: AttachCapability | null;
}

const HEADER_LIMIT = 32 * 1024;
const JSON_BODY_LIMIT = 8 * 1024 * 1024;
const ID: AttachParamConstraint = { maxLength: 256, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ };
const FILE_NAME: AttachParamConstraint = {
  maxLength: 255,
  pattern: /^[^/\\]+$/u,
  forbidDotDot: true,
};

function route(
  method: RouteMethod,
  honoPathTemplate: string,
  options: {
    capability?: AttachCapability | null;
    bodyLimit?: number;
    params?: Readonly<Record<string, AttachParamConstraint>>;
  } = {},
): AttachRoutePolicyEntry {
  return {
    method,
    honoPathTemplate,
    paramConstraints: options.params ?? {},
    bodyLimit: options.bodyLimit ?? (method === "GET" ? 0 : JSON_BODY_LIMIT),
    headerLimit: HEADER_LIMIT,
    requiredCapability: options.capability ?? null,
  };
}

/** attachSession 第一层唯一允许表；不存在的 method/template 必须拒绝。 */
export const ATTACH_ROUTE_POLICY = [
  route("GET", "/api/v1/home", { capability: "docEditing" }),
  route("GET", "/api/v1/history", { capability: "docEditing" }),
  route("GET", "/api/v1/history/:versionId", { capability: "docEditing", params: { versionId: ID } }),
  route("POST", "/api/v1/commands"),
  route("GET", "/api/v1/events", { capability: "docEditing" }),
  route("POST", "/api/v1/commit", { capability: "review" }),
  route("POST", "/api/v1/ask-more", { capability: "docEditing" }),
  route("POST", "/api/v1/confirms/cancel", { capability: "docEditing", bodyLimit: 16 * 1024 }),
  route("POST", "/api/v1/confirms/decision", { capability: "docEditing", bodyLimit: 16 * 1024 }),
  route("POST", "/api/v1/upload", { capability: "assets", bodyLimit: resolveUploadMaxBytes() }),
  route("GET", "/api/v1/files/:fileId", { capability: "assets", params: { fileId: ID } }),
  route("GET", "/api/v1/files/:fileId/:filename", {
    capability: "assets",
    params: { fileId: ID, filename: FILE_NAME },
  }),
  route("GET", "/api/v1/materials/:materialId/text", { capability: "assets", params: { materialId: ID } }),
  route("GET", "/api/v1/export/:sessionId", {
    capability: "documentExport",
    params: { sessionId: ID },
  }),
  route("GET", "/api/v1/capabilities"),
  route("GET", "/api/v1/settings/security"),
  route("GET", "/api/v1/settings/memory"),
  route("GET", "/api/v1/settings/credential-share"),
  route("GET", "/api/v1/settings/model"),
  route("GET", "/api/v1/settings/model/balance"),
  route("GET", "/api/v1/settings/search"),
  route("GET", "/api/v1/settings/search/primary"),
  route("GET", "/api/v1/usage/summary"),
  route("GET", "/api/v1/usage/docstats"),
  route("POST", "/api/v1/clientlog", { bodyLimit: 256 * 1024 }),
] as const satisfies readonly AttachRoutePolicyEntry[];

export interface AttachCommandOperationPolicyEntry {
  kind: Command["kind"];
  allowInAttach: boolean;
  requiredCapability: AttachCapability | null;
  mutationClass: string;
  reason: string;
}

/** 附录 B 39 项矩阵的代码唯一真源。 */
export const ATTACH_COMMAND_OPERATION_POLICY = [
  ["startSession", true, "docEditing", "session-create", "renderer 建立或恢复会话"],
  ["sendMessage", true, "docEditing", "model-turn", "会话消息核心"],
  ["updateAskMore", true, "docEditing", "model-turn", "问卷补充"],
  ["cancelStream", true, "docEditing", "control", "取消生成"],
  ["acceptPatch", true, "review", "review-verdict", "审阅裁决"],
  ["rejectPatch", true, "review", "review-verdict", "审阅裁决"],
  ["commitPatches", true, "review", "review-settle", "审阅结算"],
  ["commitReviewGroups", true, "review", "review-settle", "审阅结算"],
  ["submitReviewOutcome", true, "review", "review-settle", "结算回执"],
  ["ignoreAnnotationGroups", true, "review", "review-verdict", "批注裁决"],
  ["resumeAskUser", true, "docEditing", "control", "问卷续答"],
  ["cancelAskUser", true, "docEditing", "control", "问卷取消"],
  ["updateDoc", true, "docEditing", "doc-write", "用户直写保存"],
  ["renameSession", true, "docEditing", "meta-write", "会话标题修改"],
  ["updateMaterialSummary", true, "assets", "material-write", "素材摘要编辑"],
  ["removeMaterial", true, "assets", "material-write", "素材移除"],
  ["reparseMaterial", true, "assets", "material-write", "素材重解析"],
  ["attachFolder", false, "folderSelection", "fs-bridge", "依赖本机文件桥"],
  ["detachFolder", false, "folderSelection", "fs-bridge", "依赖本机文件桥"],
  ["externalPropose", false, null, "external-only", "仅 external API 子树可用"],
  ["listLexicons", true, "review", "read", "词库只读"],
  ["listLexiconEntries", true, "review", "read", "词库只读"],
  ["setEnabledLexicons", false, "lexiconMutation", "settings-write", "词库全局设置写"],
  ["listDerivatives", true, "review", "read", "衍生只读"],
  ["getDerivativeDoc", true, "review", "read", "衍生只读"],
  ["createDerivative", false, "derivativeMutation", "derivative-write", "本期降级"],
  ["deleteDerivative", false, "derivativeMutation", "derivative-write", "本期降级"],
  ["updateDerivativeParams", false, "derivativeMutation", "derivative-write", "本期降级"],
  ["listStyleTemplates", true, "docEditing", "read", "模板只读"],
  ["getStyleTemplate", true, "docEditing", "read", "模板只读"],
  ["saveStyleTemplate", false, "templateMutation", "template-write", "模板写本期降级"],
  ["deleteStyleTemplate", false, "templateMutation", "template-write", "模板写本期降级"],
  ["listReviewTemplates", true, "review", "read", "审阅模板只读"],
  ["getReviewSupplement", true, "review", "read", "补充说明只读"],
  ["saveReviewTemplate", false, "templateMutation", "template-write", "模板写本期降级"],
  ["deleteReviewTemplate", false, "templateMutation", "template-write", "模板写本期降级"],
  ["selectReviewTemplate", true, "review", "review-launch-write", "审阅启动必经"],
  ["upsertReviewSupplement", true, "review", "review-launch-write", "审阅启动输入"],
  ["draftTemplate", false, "templateMutation", "template-write", "起手模板生成写本期降级"],
].map(([kind, allowInAttach, requiredCapability, mutationClass, reason]) => ({
  kind,
  allowInAttach,
  requiredCapability,
  mutationClass,
  reason,
})) as readonly AttachCommandOperationPolicyEntry[];

const commandPolicyByKind = new Map(
  ATTACH_COMMAND_OPERATION_POLICY.map((entry) => [entry.kind, entry]),
);

export function findAttachRoutePolicy(
  method: string,
  pathname: string,
): AttachRoutePolicyEntry | null {
  for (const policy of ATTACH_ROUTE_POLICY) {
    if (policy.method !== method.toUpperCase()) continue;
    if (matchesHonoPathTemplate(pathname, policy.honoPathTemplate, policy.paramConstraints)) {
      return policy;
    }
  }
  return null;
}

export function authorizeAttachCommand(
  principal: RequestPrincipal,
  kind: Command["kind"],
): AttachCommandOperationPolicyEntry | null {
  if (principal.kind !== "attachSession") return commandPolicyByKind.get(kind) ?? null;
  const policy = commandPolicyByKind.get(kind);
  if (
    !policy
    || !policy.allowInAttach
    || !attachSessionHasCapability(principal.session, policy.requiredCapability)
  ) return null;
  return policy;
}

export function isAttachRequest(c: Context): boolean {
  return getRequestPrincipal(c).kind === "attachSession";
}

export function attachOperationDenied(c: Context): Response {
  return c.json({ error: { code: "ATTACH_OPERATION_DENIED", message: "当前连接不支持此操作" } }, 403);
}

export type RouteAuthorizationDecision = "allow" | "legacy" | "deny";

export function routeAuthorizationDecision(
  principal: RequestPrincipal,
  method: string,
  pathname: string,
): RouteAuthorizationDecision {
  if (pathname === "/api/v1/attach/handshake") {
    return principal.kind === "externalInstance" && method.toUpperCase() === "POST"
      ? "allow"
      : "deny";
  }
  if (pathname.startsWith("/api/v1/external/")) {
    return principal.kind === "externalInstance" && catalogContains(method, pathname, true)
      ? "allow"
      : "deny";
  }
  if (principal.kind === "attachSession") {
    const policy = findAttachRoutePolicy(method, pathname);
    return policy && attachSessionHasCapability(principal.session, policy.requiredCapability)
      ? "allow"
      : "deny";
  }
  if (principal.kind === "externalInstance") {
    return catalogContains(method, pathname, true) ? "allow" : "deny";
  }
  return catalogContains(method, pathname, false) ? "legacy" : "deny";
}

/** principal → CSRF 后的路由授权层。 */
export const attachRouteAuthorizationMiddleware: MiddlewareHandler = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const principal = getRequestPrincipal(c);
  const authFailure = getPrincipalAuthFailure(c);
  const decision = routeAuthorizationDecision(principal, c.req.method, pathname);

  if (pathname === "/api/v1/attach/handshake") {
    const client = requestSocketAddress(c);
    if (!client.loopback) return c.json({ error: "forbidden" }, 403);
    const admitted = handshakeAdmission.acquire(client.ip);
    if (!admitted.ok) {
      if (admitted.retryAfterSeconds) c.header("Retry-After", String(admitted.retryAfterSeconds));
      return c.json({ error: admitted.reason }, admitted.reason === "rate_limited" ? 429 : 503);
    }
    try {
      if (decision !== "allow") {
        return c.json({ error: { code: "INSTANCE_AUTH_FAILED", message: "连接凭据无效" } }, 401);
      }
      return await next();
    } finally {
      admitted.release();
    }
  }

  if (pathname.startsWith("/api/v1/external/")) {
    if (decision !== "allow") {
      if (principal.kind !== "externalInstance") {
        return externalError(c, 401, "AUTH_FAILED", "unauthorized");
      }
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  }

  if (authFailure) {
    return c.json({ error: { code: authFailure, message: "连接凭据已失效" } }, 401);
  }
  if (decision === "legacy") return next();
  if (decision === "deny") {
    return principal.kind === "attachSession"
      ? c.json({ error: { code: "ATTACH_ROUTE_DENIED", message: "当前连接不支持此请求" } }, 403)
      : c.json({ error: "forbidden" }, 403);
  }

  // modelKeys 本期固定禁用；旧 renderer 或直连请求在读取/解析密钥前 fail closed。
  if (principal.kind !== "attachSession") return c.json({ error: "forbidden" }, 403);
  if (hasCommandsModelOverrideHeader(c)) return attachOperationDenied(c);
  const policy = findAttachRoutePolicy(c.req.method, pathname);
  if (!policy) {
    return c.json({ error: { code: "ATTACH_ROUTE_DENIED", message: "当前连接不支持此请求" } }, 403);
  }
  if (requestHeaderBytes(c.req.raw.headers) > policy.headerLimit) {
    return c.json({ error: "request headers too large" }, 431);
  }
  const contentLength = Number(c.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > policy.bodyLimit) {
    return c.json({ error: "请求体过大" }, 413);
  }
  return next();
};

export function matchesHonoPathTemplate(
  pathname: string,
  template: string,
  constraints: Readonly<Record<string, AttachParamConstraint>> = {},
): boolean {
  const pathSegments = pathname.split("/");
  const templateSegments = template.split("/");
  if (pathSegments.length !== templateSegments.length) return false;
  for (let index = 0; index < templateSegments.length; index += 1) {
    const expected = templateSegments[index]!;
    const actualEncoded = pathSegments[index]!;
    if (!expected.startsWith(":")) {
      if (actualEncoded !== expected) return false;
      continue;
    }
    const name = expected.slice(1);
    const constraint = constraints[name];
    if (!constraint) return false;
    let actual: string;
    try { actual = decodeURIComponent(actualEncoded); } catch { return false; }
    if (
      !actual
      || actual.length > constraint.maxLength
      || !constraint.pattern.test(actual)
      || (constraint.forbidDotDot && actual.includes(".."))
    ) return false;
  }
  return true;
}

function catalogContains(method: string, pathname: string, externalOnly: boolean): boolean {
  return SERVER_ROUTE_CATALOG.some((entry) =>
    entry.method === method.toUpperCase()
    && (!externalOnly || entry.honoPathTemplate.startsWith("/api/v1/external/"))
    && matchesCatalogTemplate(pathname, entry.honoPathTemplate));
}

function matchesCatalogTemplate(pathname: string, template: string): boolean {
  const actual = pathname.split("/");
  const expected = template.split("/");
  return actual.length === expected.length && expected.every((part, index) =>
    part.startsWith(":") ? actual[index]!.length > 0 : actual[index] === part);
}

function requestHeaderBytes(headers: Headers): number {
  let total = 0;
  headers.forEach((value, name) => { total += Buffer.byteLength(name) + Buffer.byteLength(value) + 4; });
  return total;
}

export class HandshakeAdmission {
  private concurrent = 0;
  private readonly attempts = new Map<string, number[]>();

  acquire(ip: string):
    | { ok: true; release: () => void }
    | { ok: false; reason: "rate_limited" | "busy"; retryAfterSeconds?: number } {
    const now = Date.now();
    const windowStart = now - 60_000;
    const attempts = (this.attempts.get(ip) ?? []).filter((at) => at > windowStart);
    if (attempts.length >= 10) {
      this.attempts.set(ip, attempts);
      return { ok: false, reason: "rate_limited", retryAfterSeconds: 60 };
    }
    attempts.push(now);
    this.attempts.set(ip, attempts);
    if (this.concurrent >= 2) return { ok: false, reason: "busy" };
    this.concurrent += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.concurrent -= 1;
      },
    };
  }
}

const handshakeAdmission = new HandshakeAdmission();

export function __resetHandshakeAdmissionForTest(): void {
  (handshakeAdmission as unknown as { concurrent: number }).concurrent = 0;
  (handshakeAdmission as unknown as { attempts: Map<string, number[]> }).attempts.clear();
}

import { Hono, type Context } from "hono";
import {
  ConnectorService,
  createConnectorStatus,
  getConnectorService,
  isConnectorId,
  listConnectorDefinitions,
  type ConnectorInfoDto,
} from "@qingagent/core";
import {
  ConnectorMutationForbiddenError,
  getConnectorRuntimeAccess,
  type ConnectorRuntimeAccess,
} from "../lib/connectorRuntimeGate";

export interface ConnectorsRoutesOptions {
  service?: Pick<ConnectorService, "list" | "info" | "probe" | "disconnect"> & Partial<Pick<ConnectorService, "start">>;
  runtimeAccess?: () => ConnectorRuntimeAccess;
}

const TRUSTED_CONNECTOR_ERRORS: Readonly<Record<
  string,
  { status: 400 | 401 | 403 | 409 | 410 | 429 | 502; message: string }
>> = {
  INVALID_ARGUMENT: { status: 400, message: "连接参数无效，请检查后重试。" },
  CONNECTOR_START_UNSUPPORTED: { status: 409, message: "当前连接器不支持发起授权。" },
  ILLEGAL_CONNECTOR_TRANSITION: { status: 409, message: "当前连接状态不支持此操作。" },
  PENDING_LOST: { status: 410, message: "授权上下文已丢失，请重新发起。" },
  PENDING_EXPIRED: { status: 410, message: "授权已过期，请重新发起。" },
  PENDING_CAPACITY: { status: 429, message: "待处理授权过多，请稍后重试。" },
  GITHUB_CLIENT_ID_MISSING: { status: 409, message: "GitHub 连接尚未配置。" },
  INSUFFICIENT_SCOPE: { status: 409, message: "GitHub 实际授权范围不足。" },
  ACCOUNT_CHANGE_CONFIRMATION_REQUIRED: { status: 409, message: "GitHub 授权账号发生变化，请重新确认。" },
  ACCESS_DENIED: { status: 403, message: "连接权限不足或访问被拒绝。" },
  NEEDS_REAUTH: { status: 401, message: "连接授权已失效，请重新授权。" },
  RATE_LIMIT: { status: 429, message: "连接服务请求过于频繁，请稍后重试。" },
  GITHUB_PROBE_FAILED: { status: 502, message: "连接检查暂时失败，请稍后重试。" },
  FEISHU_AUTH_ALREADY_PENDING: { status: 409, message: "已有飞书授权正在进行。" },
  FEISHU_ALREADY_AUTHORIZED: { status: 409, message: "飞书当前授权已满足要求。" },
};

function unavailableInfo(reasonCode: string): ConnectorInfoDto[] {
  return listConnectorDefinitions().map((definition) => ({
    id: definition.id,
    name: definition.name,
    icon: definition.icon,
    official: definition.official,
    authPresentation: definition.authPresentation,
    riskNote: definition.riskNote ?? null,
    usedBySkills: [...definition.usedBySkills],
    status: createConnectorStatus("unavailable", {
      reasonCode,
      statusFreshness: "fresh",
      canProbe: false,
    }),
  }));
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof ConnectorMutationForbiddenError) {
    return c.json({ error: error.code, message: error.message, reasonCode: error.reasonCode }, 403);
  }
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : null;
  const trusted = rawCode ? TRUSTED_CONNECTOR_ERRORS[rawCode] : undefined;
  const errorMessage =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : null;
  if (!trusted) {
    console.error("[connector-route] operation failed", {
      code: rawCode,
      error: errorMessage ?? String(error),
    });
    return c.json({
      error: "CONNECTOR_OPERATION_FAILED",
      message: "连接操作失败，请稍后重试。",
    }, 500);
  }
  return c.json(
    { error: rawCode, message: trusted.message },
    trusted.status,
  );
}

export function createConnectorsRoutes(options: ConnectorsRoutesOptions = {}): Hono {
  const routes = new Hono();
  const service = options.service ?? getConnectorService();
  const runtimeAccess = options.runtimeAccess ?? getConnectorRuntimeAccess;

  routes.get("/connectors", async (c) => {
    const access = runtimeAccess();
    if (!access.capability.mutationEnabled) {
      return c.json({ connectors: unavailableInfo(access.capability.reasonCode ?? "CONNECTORS_DISABLED") });
    }
    return c.json({ connectors: await service.list() });
  });

  routes.get("/connectors/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isConnectorId(id)) return c.json({ error: "CONNECTOR_NOT_FOUND" }, 404);
      const access = runtimeAccess();
      if (!access.capability.mutationEnabled) {
        const connector = unavailableInfo(access.capability.reasonCode ?? "CONNECTORS_DISABLED").find((item) => item.id === id)!;
        return c.json(connector);
      }
      return c.json(await service.info(id, c.req.query("pendingId")));
    } catch (error) { return errorResponse(c, error); }
  });

  routes.post("/connectors/:id/start", async (c) => {
    try {
      runtimeAccess().assertMutationAllowed();
      const id = c.req.param("id");
      if (!isConnectorId(id)) return c.json({ error: "CONNECTOR_NOT_FOUND" }, 404);
      const body = await c.req.json().catch(() => ({}));
      if (!service.start) return c.json({ error: "CONNECTOR_START_UNSUPPORTED" }, 409);
      return c.json(await service.start(id, body));
    } catch (error) { return errorResponse(c, error); }
  });

  routes.post("/connectors/:id/probe", async (c) => {
    try {
      // 铁律：必须先于 id 分发、runner、网络和凭证仓调用。
      runtimeAccess().assertMutationAllowed();
      const id = c.req.param("id");
      if (!isConnectorId(id)) return c.json({ error: "CONNECTOR_NOT_FOUND" }, 404);
      return c.json(await service.probe(id));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.delete("/connectors/:id", async (c) => {
    try {
      // 铁律：必须先于 id 分发、runner、网络和凭证仓调用。
      runtimeAccess().assertMutationAllowed();
      const id = c.req.param("id");
      if (!isConnectorId(id)) return c.json({ error: "CONNECTOR_NOT_FOUND" }, 404);
      return c.json(await service.disconnect(id));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}

export const connectorsRoutes = createConnectorsRoutes();

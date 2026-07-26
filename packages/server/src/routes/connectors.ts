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
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 500;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "CONNECTOR_OPERATION_FAILED";
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "连接操作失败，请稍后重试。";
  const responseStatus = status >= 400 && status <= 599 ? status : 500;
  return c.json({ error: code, message }, responseStatus as 400);
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

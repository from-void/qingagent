import { Hono } from "hono";
import { z } from "zod";
import type {
  SecurityGrantCategory,
  SecurityGrantMode,
  SecuritySettingsResponse,
  UpdateSecurityGrantResponse,
} from "@qingagent/contract-ts";
import {
  createConfirmGrantCanonical,
  listConfirmGrantStates,
  revokeConfirmGrantWithState,
  type ConfirmGrantKind,
} from "@qingagent/db";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const updateSecuritySchema = z.object({
  grantMode: z.enum(["ask", "always"]),
}).strict();

const rememberableKinds = new Set<ConfirmGrantKind>(["install", "command"]);

interface SecuritySettingsRoutesDependencies {
  listGrantStates?: typeof listConfirmGrantStates;
  createGrant?: typeof createConfirmGrantCanonical;
  revokeGrant?: typeof revokeConfirmGrantWithState;
}

export function createSecuritySettingsRoutes(
  dependencies: SecuritySettingsRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const listGrantStates = dependencies.listGrantStates ?? listConfirmGrantStates;
  const createGrant = dependencies.createGrant ?? createConfirmGrantCanonical;
  const revokeGrant = dependencies.revokeGrant ?? revokeConfirmGrantWithState;

  routes.get("/settings/security", async (c) => {
    const states = await listGrantStates();
    const stateByKind = new Map(states.map((state) => [state.kind, state]));
    const category = (
      kind: ConfirmGrantKind,
      label: string,
    ): SecurityGrantCategory => {
      const state = stateByKind.get(kind);
      if (!state) throw new Error(`confirm grant state missing for ${kind}`);
      return {
        kind,
        label,
        grantMode: state.present ? "always" : "ask",
        grantModes: ["ask", "always"],
        present: state.present,
        grantId: state.grantId,
        version: state.version,
      };
    };
    const body: SecuritySettingsResponse = {
      categories: [
      category("install", "安装"),
      category("command", "同类操作"),
        {
          kind: "send",
          label: "向外发送内容",
          grantMode: "ask",
          grantModes: ["ask"],
          present: false,
          grantId: null,
          version: 0,
        },
        {
          kind: "connect",
          label: "连接账号",
          grantMode: "ask",
          grantModes: ["ask"],
          present: false,
          grantId: null,
          version: 0,
        },
      ],
    };
    return c.json(body);
  });

  routes.post("/settings/security/:kind", async (c) => {
    const originError = requireTrustedOrigin(c);
    if (originError) return originError;
    const kind = c.req.param("kind");
    if (!rememberableKinds.has(kind as ConfirmGrantKind)) {
      return c.json({ error: "这类操作只能每次询问，不能改为自动进行。" }, 400);
    }
    const parsed = updateSecuritySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "设置内容不完整，请再试一次。" }, 400);
    const grantKind = kind as ConfirmGrantKind;
    const grantMode: SecurityGrantMode = parsed.data.grantMode;

    if (grantMode === "ask") {
      const result = await revokeGrant(grantKind, "settings");
      const body: UpdateSecurityGrantResponse = {
        kind: grantKind,
        grantMode,
        present: result.state.present,
        grantId: result.state.grantId,
        version: result.state.version,
      };
      return c.json(body);
    }

    const result = await createGrant({ kind: grantKind, source: "settings" });
    const body: UpdateSecurityGrantResponse = {
      kind: grantKind,
      grantMode: result.state.present ? "always" : "ask",
      present: result.state.present,
      grantId: result.state.grantId,
      version: result.state.version,
    };
    return c.json(body);
  });

  return routes;
}

export const securitySettingsRoutes = createSecuritySettingsRoutes();

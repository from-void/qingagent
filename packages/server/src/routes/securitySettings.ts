import { Hono } from "hono";
import { z } from "zod";
import {
  createConfirmGrant,
  listConfirmGrants,
  revokeConfirmGrant,
  type ConfirmGrantKind,
} from "@qingagent/db";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import {
  consumeConfirmUiGrant,
  insecureRememberAllowed,
} from "../lib/confirmUiGrant";

const updateSecuritySchema = z.object({
  needConfirmation: z.boolean(),
  uiGrantNonce: z.string().min(1).max(256).optional(),
}).strict();

const rememberableKinds = new Set<ConfirmGrantKind>(["install", "command"]);

interface SecuritySettingsRoutesDependencies {
  listGrants?: typeof listConfirmGrants;
  createGrant?: typeof createConfirmGrant;
  revokeGrant?: typeof revokeConfirmGrant;
  consumeUiGrant?: typeof consumeConfirmUiGrant;
  insecureRememberAllowed?: () => boolean;
}

export function createSecuritySettingsRoutes(
  dependencies: SecuritySettingsRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const listGrants = dependencies.listGrants ?? listConfirmGrants;
  const createGrant = dependencies.createGrant ?? createConfirmGrant;
  const revokeGrant = dependencies.revokeGrant ?? revokeConfirmGrant;
  const consumeUiGrant = dependencies.consumeUiGrant ?? consumeConfirmUiGrant;
  const allowInsecureRemember = dependencies.insecureRememberAllowed
    ?? insecureRememberAllowed;

  routes.get("/settings/security", async (c) => {
  const grants = await listGrants();
  const granted = new Set(grants.map((grant) => grant.kind));
  return c.json({
    categories: [
      { kind: "install", label: "安装指令", needConfirmation: !granted.has("install"), mutable: true },
      { kind: "command", label: "此类命令", needConfirmation: !granted.has("command"), mutable: true },
      { kind: "send", label: "外发指令", needConfirmation: true, mutable: false },
      { kind: "connect", label: "连接账号", needConfirmation: true, mutable: false },
    ],
    insecureRememberAllowed: allowInsecureRemember(),
  });
  });

  routes.post("/settings/security/:kind", async (c) => {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;
  const kind = c.req.param("kind");
  if (!rememberableKinds.has(kind as ConfirmGrantKind)) {
    return c.json({ error: "该类别始终需要确认" }, 400);
  }
  const parsed = updateSecuritySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "安全设置请求无效" }, 400);
  const grantKind = kind as ConfirmGrantKind;

  if (parsed.data.needConfirmation) {
    await revokeGrant(grantKind, "settings");
    return c.json({ kind: grantKind, needConfirmation: true });
  }

  const authorized = allowInsecureRemember() || consumeUiGrant({
    purpose: "settings",
    nonce: parsed.data.uiGrantNonce,
    kind: grantKind,
  }).ok;
  if (!authorized) return c.json({ error: "缺少有效的桌面设置授权" }, 403);
  const grant = await createGrant({ kind: grantKind, source: "settings" });
  return c.json({ kind: grantKind, needConfirmation: false, grantId: grant.grantId });
  });

  return routes;
}

export const securitySettingsRoutes = createSecuritySettingsRoutes();

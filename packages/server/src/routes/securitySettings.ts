import { Hono } from "hono";
import { z } from "zod";
import {
  createConfirmGrantCanonical,
  listConfirmGrantStates,
  revokeConfirmGrantWithState,
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
  listGrantStates?: typeof listConfirmGrantStates;
  createGrant?: typeof createConfirmGrantCanonical;
  revokeGrant?: typeof revokeConfirmGrantWithState;
  consumeUiGrant?: typeof consumeConfirmUiGrant;
  insecureRememberAllowed?: () => boolean;
}

export function createSecuritySettingsRoutes(
  dependencies: SecuritySettingsRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const listGrantStates = dependencies.listGrantStates ?? listConfirmGrantStates;
  const createGrant = dependencies.createGrant ?? createConfirmGrantCanonical;
  const revokeGrant = dependencies.revokeGrant ?? revokeConfirmGrantWithState;
  const consumeUiGrant = dependencies.consumeUiGrant ?? consumeConfirmUiGrant;
  const allowInsecureRemember = dependencies.insecureRememberAllowed
    ?? insecureRememberAllowed;

  routes.get("/settings/security", async (c) => {
  const states = await listGrantStates();
  const stateByKind = new Map(states.map((state) => [state.kind, state]));
  const category = (kind: ConfirmGrantKind, label: string) => {
    const state = stateByKind.get(kind);
    if (!state) throw new Error(`confirm grant state missing for ${kind}`);
    return {
      kind,
      label,
      needConfirmation: !state.present,
      mutable: true,
      present: state.present,
      grantId: state.grantId,
      version: state.version,
    };
  };
  return c.json({
    categories: [
      category("install", "安装"),
      category("command", "同类操作"),
      { kind: "send", label: "向外发送内容", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
      { kind: "connect", label: "连接账号", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
    ],
    insecureRememberAllowed: allowInsecureRemember(),
  });
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

  if (parsed.data.needConfirmation) {
    const result = await revokeGrant(grantKind, "settings");
    return c.json({
      kind: grantKind,
      needConfirmation: true,
      present: result.state.present,
      grantId: result.state.grantId,
      version: result.state.version,
    });
  }

  const authorized = allowInsecureRemember() || consumeUiGrant({
    purpose: "settings",
    nonce: parsed.data.uiGrantNonce,
    kind: grantKind,
  }).ok;
  if (!authorized) return c.json({ error: "开启记忆需要在桌面应用中完成确认。" }, 403);
  const result = await createGrant({ kind: grantKind, source: "settings" });
  return c.json({
    kind: grantKind,
    needConfirmation: !result.state.present,
    present: result.state.present,
    grantId: result.state.grantId,
    version: result.state.version,
  });
  });

  return routes;
}

export const securitySettingsRoutes = createSecuritySettingsRoutes();

import { Hono } from "hono";
import { z } from "zod";
import type {
  SecurityBypassState,
  SecurityGrantCategory,
  SecurityGrantMode,
  SecuritySettingsOperation,
  SecuritySettingsResponse,
  UpdateSecurityGrantResponse,
} from "@qingagent/contract-ts";
import { randomUUID } from "node:crypto";
import { applyBypassMode, loadBypassMode } from "@qingagent/core";
import {
  createConfirmGrantCanonical,
  listConfirmGrantStates,
  revokeConfirmGrantWithState,
  type ConfirmGrantKind,
} from "@qingagent/db";
import { listCredentialShareItems } from "./credentialShare";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const updateSecuritySchema = z.object({
  grantMode: z.enum(["ask", "always"]),
  operationId: z.string().min(1).max(128).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
}).strict();

const rememberableKinds = new Set<ConfirmGrantKind>(["install", "command", "send", "connect"]);

// 「以后不用再问我」的常驻控制点就在这一页:用户随时能看到自己现在处于哪一档,
// 也能一键改回默认(改回后立刻恢复弹确认卡与隔离执行,已有会话即时生效)。
const updateBypassSchema = z.object({ enabled: z.boolean() }).strict();

interface SecuritySettingsRoutesDependencies {
  listCredentialShare?: typeof listCredentialShareItems;
  listGrantStates?: typeof listConfirmGrantStates;
  createGrant?: typeof createConfirmGrantCanonical;
  revokeGrant?: typeof revokeConfirmGrantWithState;
  readBypass?: typeof loadBypassMode;
  writeBypass?: typeof applyBypassMode;
}

export function createSecuritySettingsRoutes(
  dependencies: SecuritySettingsRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const listGrantStates = dependencies.listGrantStates ?? listConfirmGrantStates;
  const createGrant = dependencies.createGrant ?? createConfirmGrantCanonical;
  const revokeGrant = dependencies.revokeGrant ?? revokeConfirmGrantWithState;
  const listCredentialShare = dependencies.listCredentialShare ?? listCredentialShareItems;
  const readBypass = dependencies.readBypass ?? loadBypassMode;
  const writeBypass = dependencies.writeBypass ?? applyBypassMode;
  const operations = new Map<string, SecuritySettingsOperation>();
  const rememberOperation = (operation: SecuritySettingsOperation) => {
    operations.delete(operation.operationId);
    operations.set(operation.operationId, operation);
    const oldest = operations.keys().next().value as string | undefined;
    if (operations.size > 256 && oldest) operations.delete(oldest);
  };

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
    // 共享条目随设置一起返回:安全页只发一次请求,读失败也不拖垮整页。
    const credentialShare = await listCredentialShare().catch(() => []);
    // 读失败按默认形态(仍在询问)呈现,不能因为一次读失败就告诉用户"已关闭询问"。
    const bypass: SecurityBypassState = await readBypass()
      .then((snapshot) => ({ enabled: snapshot.enabled, enabledAt: snapshot.enabledAt }))
      .catch(() => ({ enabled: false, enabledAt: null }));
    const body: SecuritySettingsResponse = {
      bypass,
      categories: [
        category("install", "安装软件"),
        category("command", "删除或移动文件"),
        category("send", "向外发送内容"),
        category("connect", "连接账号"),
      ],
      credentialShare,
    };
    const operationId = c.req.query("operationId");
    const operation = operationId ? operations.get(operationId) : undefined;
    if (operation) body.operation = operation;
    return c.json(body);
  });

  // 必须注册在 :kind 之前,否则 "bypass" 会被当成一个确认类别吃掉。
  routes.post("/settings/security/bypass", async (c) => {
    const originError = requireTrustedOrigin(c);
    if (originError) return originError;
    const parsed = updateBypassSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "设置内容不完整，请再试一次。" }, 400);
    try {
      const snapshot = await writeBypass(parsed.data.enabled);
      const body: SecurityBypassState = {
        enabled: snapshot.enabled,
        enabledAt: snapshot.enabledAt,
      };
      return c.json(body);
    } catch {
      return c.json({ error: "设置保存失败，请再试一次。" }, 500);
    }
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
    const operationId = parsed.data.operationId ?? randomUUID();
    const baseVersion = parsed.data.baseVersion ?? 0;
    const existingOperation = operations.get(operationId);
    if (
      existingOperation &&
      (
        existingOperation.kind !== grantKind ||
        existingOperation.grantMode !== grantMode ||
        existingOperation.baseVersion !== baseVersion
      )
    ) {
      return c.json({ error: "设置请求已失效，请刷新后重试。" }, 409);
    }
    if (existingOperation?.status === "committed") {
      return c.json(existingOperation.result);
    }
    if (existingOperation?.status === "failed") {
      return c.json({ error: "设置保存失败，请再试一次。" }, 500);
    }
    if (existingOperation?.status === "pending") {
      return c.json({ operation: existingOperation }, 202);
    }
    rememberOperation({
      operationId,
      kind: grantKind,
      grantMode,
      baseVersion,
      status: "pending",
    });

    try {
      if (grantMode === "ask") {
        const result = await revokeGrant(grantKind, "settings");
        const body: UpdateSecurityGrantResponse = {
          kind: grantKind,
          grantMode,
          present: result.state.present,
          grantId: result.state.grantId,
          version: result.state.version,
          operationId,
          baseVersion,
        };
        rememberOperation({
          operationId,
          kind: grantKind,
          grantMode,
          baseVersion,
          status: "committed",
          result: body,
        });
        return c.json(body);
      }

      const result = await createGrant({ kind: grantKind, source: "settings" });
      const body: UpdateSecurityGrantResponse = {
        kind: grantKind,
        grantMode: result.state.present ? "always" : "ask",
        present: result.state.present,
        grantId: result.state.grantId,
        version: result.state.version,
        operationId,
        baseVersion,
      };
      rememberOperation({
        operationId,
        kind: grantKind,
        grantMode,
        baseVersion,
        status: "committed",
        result: body,
      });
      return c.json(body);
    } catch {
      rememberOperation({
        operationId,
        kind: grantKind,
        grantMode,
        baseVersion,
        status: "failed",
      });
      return c.json({ error: "设置保存失败，请再试一次。" }, 500);
    }
  });

  return routes;
}

export const securitySettingsRoutes = createSecuritySettingsRoutes();

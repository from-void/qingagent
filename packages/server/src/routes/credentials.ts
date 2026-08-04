// 沙箱凭据路由:保留通用表单凭据与连接器凭据元数据能力；当前没有表单型平台。
// 密钥加密落库(packages/core/src/credentials),录入后让会话沙箱缓存失效。
// 安全:凭据值只入不出——GET 只返回元信息(平台/键/更新时间),从不回传明文。

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import {
  PLATFORM_CREDENTIAL_SPECS,
  deleteCredential,
  getConnectorService,
  invalidateSessionWorkspace,
  listCredentialMeta,
  saveCredentialRecord,
} from "@qingagent/core";
import {
  ConnectorMutationForbiddenError,
  getConnectorRuntimeAccess,
} from "../lib/connectorRuntimeGate";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

export const credentialsRoutes = new Hono();

/** 凭据录入请求体外层形状;platform 是否已知 / values 各键是否合法由下方业务校验(保留中文文案)。 */
const credentialsPostSchema = z.object({
  platform: z.string(),
  values: z.record(z.string(), z.unknown()),
});

async function requireTrustedOriginForCredentials(c: Context, next: Next) {
  if (c.req.method === "GET") return next();
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;
  return next();
}

credentialsRoutes.use("/credentials/*", requireTrustedOriginForCredentials);
credentialsRoutes.use("/credentials", requireTrustedOriginForCredentials);

const KNOWN_PLATFORMS = new Set(PLATFORM_CREDENTIAL_SPECS.map((s) => s.platform));
// 每个平台只接受自己声明的 key,防止跨平台字段错存(扁平注入会互相覆盖)
const PLATFORM_KEYS = new Map(
  PLATFORM_CREDENTIAL_SPECS.map((spec) => [spec.platform, new Set(spec.fields.map((f) => f.key))]),
);

/** 平台规格 + 已配置状态(供设置页渲染表单,标记哪些已填)。 */
credentialsRoutes.get("/credentials", async (c) => {
  const meta = await listCredentialMeta();
  const configured = new Set(meta.map((m) => `${m.platform}:${m.key}`));
  return c.json({
    specs: PLATFORM_CREDENTIAL_SPECS.map((spec) => ({
      ...spec,
      fields: spec.fields.map((f) => ({
        ...f,
        configured: configured.has(`${spec.platform}:${f.key}`),
      })),
    })),
    meta,
  });
});

/** 录入/更新一组凭据。body: { platform, values: { KEY: value, ... } } */
credentialsRoutes.post("/credentials", async (c) => {
  const parsed = await parseBody(c, credentialsPostSchema, {
    invalidJsonMessage: "请求内容格式不正确",
  });
  if (!parsed.ok) return parsed.response;
  const { platform, values } = parsed.data;
  if (!KNOWN_PLATFORMS.has(platform)) {
    return c.json({ error: `未知平台：${platform}` }, 400);
  }
  if (platform.startsWith("connector:")) {
    return c.json({ error: "连接器凭据只能通过授权流程写入" }, 405);
  }
  const allowedKeys = PLATFORM_KEYS.get(platform)!;
  const saved: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      return c.json({ error: `${platform} 不支持该字段：${key}` }, 400);
    }
    if (typeof value !== "string" || value.length === 0) continue; // 空值跳过(不覆盖已有)
    await saveCredentialRecord({ platform, key, value });
    saved.push(key);
  }
  // 凭据变了 → 让所有会话沙箱缓存失效,下轮重新注入
  invalidateSessionWorkspace();
  return c.json({ ok: true, saved });
});

/** 删除某平台凭据(整组或单键)。 */
credentialsRoutes.delete("/credentials/:platform", async (c) => {
  const platform = c.req.param("platform");
  if (!KNOWN_PLATFORMS.has(platform)) {
    return c.json({ error: `未知平台：${platform}` }, 400);
  }
  const key = c.req.query("key");
  if (platform === "connector:wechat-mp") {
    try {
      // 铁律：门禁必须先于 connector service 解析及任何断连副作用。
      getConnectorRuntimeAccess().assertMutationAllowed();
    } catch (error) {
      if (error instanceof ConnectorMutationForbiddenError) {
        return c.json({
          error: error.code,
          message: error.message,
          reasonCode: error.reasonCode,
        }, 403);
      }
      throw error;
    }
    await getConnectorService().disconnect("wechat-mp");
  } else {
    await deleteCredential(platform, key || undefined);
  }
  invalidateSessionWorkspace();
  return c.json({ ok: true });
});

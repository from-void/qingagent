import { Hono } from "hono";
import { z } from "zod";
import type {
  CredentialShareItem,
  CredentialShareResponse,
} from "@qingagent/contract-ts";
import {
  ensureCredentialPathExists,
  listCredentialRequests,
  type CredentialRequest,
} from "@qingagent/core";
import {
  createCredentialGrant,
  listCredentialGrants,
  revokeCredentialGrant,
} from "@qingagent/db";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const updateSchema = z.object({
  skillName: z.string().min(1).max(64),
  declared: z.string().min(1).max(512),
  granted: z.boolean(),
}).strict();

export interface CredentialShareDependencies {
  listRequests?: () => Promise<CredentialRequest[]>;
  listGrants?: typeof listCredentialGrants;
  createGrant?: typeof createCredentialGrant;
  revokeGrant?: typeof revokeCredentialGrant;
  ensurePath?: typeof ensureCredentialPathExists;
}

function toItem(request: CredentialRequest, grantedAt: string | null): CredentialShareItem {
  return {
    skillName: request.skillName,
    skillLabel: request.skillLabel,
    declared: request.declared,
    granted: grantedAt !== null,
    grantedAt,
  };
}

export function createCredentialShareRoutes(
  dependencies: CredentialShareDependencies = {},
): Hono {
  const routes = new Hono();
  const listRequests = dependencies.listRequests ?? (() => listCredentialRequests());
  const listGrants = dependencies.listGrants ?? listCredentialGrants;
  const createGrant = dependencies.createGrant ?? createCredentialGrant;
  const revokeGrant = dependencies.revokeGrant ?? revokeCredentialGrant;
  const ensurePath = dependencies.ensurePath ?? ensureCredentialPathExists;

  // 只列出「当前已启用技能确实声明了的」条目:声明没了就不该继续出现在设置里。
  routes.get("/settings/credential-share", async (c) => {
    const [requests, grants] = await Promise.all([listRequests(), listGrants()]);
    const grantedAtByPath = new Map(grants.map((grant) => [grant.path, grant.createdAt]));
    const body: CredentialShareResponse = {
      items: requests.map((request) => toItem(request, grantedAtByPath.get(request.path) ?? null)),
    };
    return c.json(body);
  });

  routes.post("/settings/credential-share", async (c) => {
    const originError = requireTrustedOrigin(c);
    if (originError) return originError;
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "设置内容不完整，请再试一次。" }, 400);

    // 路径不从请求体取:只认当前已启用技能的声明,避免任意路径被授权。
    const requests = await listRequests();
    const request = requests.find(
      (item) =>
        item.skillName === parsed.data.skillName && item.declared === parsed.data.declared,
    );
    if (!request) {
      return c.json({ error: "这个技能现在没有请求共享这个位置。" }, 404);
    }

    if (!parsed.data.granted) {
      await revokeGrant(request.path);
      return c.json({ ...toItem(request, null) });
    }
    await ensurePath(request.path);
    const mutation = await createGrant({
      path: request.path,
      skillName: request.skillName,
      declared: request.declared,
      source: "settings",
    });
    return c.json({ ...toItem(request, mutation.grant.createdAt) });
  });

  return routes;
}

export const credentialShareRoutes = createCredentialShareRoutes();

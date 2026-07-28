import { Hono } from "hono";
import { z } from "zod";
import type {
  CredentialShareItem,
  CredentialShareResponse,
} from "@qingagent/contract-ts";
import {
  ensureCredentialPathExists,
  invalidateSessionWorkspace,
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
  // 空串 = 按需申请拿到的授权,不绑技能;它只能被收回,不能靠本接口新增。
  skillName: z.string().max(64),
  declared: z.string().min(1).max(512),
  granted: z.boolean(),
}).strict();

export interface CredentialShareDependencies {
  listRequests?: () => Promise<CredentialRequest[]>;
  listGrants?: typeof listCredentialGrants;
  createGrant?: typeof createCredentialGrant;
  revokeGrant?: typeof revokeCredentialGrant;
  ensurePath?: typeof ensureCredentialPathExists;
  invalidateWorkspaces?: typeof invalidateSessionWorkspace;
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

export const ADHOC_CREDENTIAL_SKILL_LABEL = "命令行工具";

/**
 * 共享条目 + 授权状态。两条通道合流:技能声明的条目 + 按需申请拿到的授权
 * (后者没有技能,统一挂在「命令行工具」名下)。安全页与 credential-share 路由共用同一口径。
 */
export async function listCredentialShareItems(deps: {
  listRequests?: () => Promise<CredentialRequest[]>;
  listGrants?: typeof listCredentialGrants;
} = {}): Promise<CredentialShareItem[]> {
  const [requests, grants] = await Promise.all([
    (deps.listRequests ?? listCredentialRequests)(),
    (deps.listGrants ?? listCredentialGrants)(),
  ]);
  const grantedAtByPath = new Map(grants.map((grant) => [grant.path, grant.createdAt]));
  const declaredPaths = new Set(requests.map((request) => request.path));
  const items = requests.map((request) => toItem(request, grantedAtByPath.get(request.path) ?? null));
  for (const grant of grants) {
    if (declaredPaths.has(grant.path)) continue;
    items.push({
      skillName: grant.skillName,
      skillLabel: grant.skillName || ADHOC_CREDENTIAL_SKILL_LABEL,
      declared: grant.declared,
      granted: true,
      grantedAt: grant.createdAt,
    });
  }
  return items;
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
  const invalidateWorkspaces =
    dependencies.invalidateWorkspaces ?? invalidateSessionWorkspace;

  // 只列出「当前已启用技能确实声明了的」条目:声明没了就不该继续出现在设置里。
  routes.get("/settings/credential-share", async (c) => {
    const body: CredentialShareResponse = {
      items: await listCredentialShareItems({ listRequests, listGrants }),
    };
    return c.json(body);
  });

  routes.post("/settings/credential-share", async (c) => {
    const originError = requireTrustedOrigin(c);
    if (originError) return originError;
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "设置内容不完整，请再试一次。" }, 400);

    // 路径不从请求体取:授权只认当前已启用技能的声明,避免任意路径被授权。
    const requests = await listRequests();
    const request = requests.find(
      (item) =>
        item.skillName === parsed.data.skillName && item.declared === parsed.data.declared,
    );
    if (!request) {
      // 收回是纯削权,按需申请拿到的授权(没有技能声明)也必须收得回来。
      if (!parsed.data.granted) {
        const grant = (await listGrants()).find(
          (item) =>
            item.declared === parsed.data.declared && item.skillName === parsed.data.skillName,
        );
        if (grant) {
          await revokeGrant(grant.path);
          invalidateWorkspaces();
          return c.json({
            skillName: grant.skillName,
            skillLabel: grant.skillName || ADHOC_CREDENTIAL_SKILL_LABEL,
            declared: grant.declared,
            granted: false,
            grantedAt: null,
          });
        }
      }
      return c.json({ error: "这个技能现在没有请求共享这个位置。" }, 404);
    }

    if (!parsed.data.granted) {
      await revokeGrant(request.path);
      invalidateWorkspaces();
      return c.json({ ...toItem(request, null) });
    }
    await ensurePath(request.path);
    const mutation = await createGrant({
      path: request.path,
      skillName: request.skillName,
      declared: request.declared,
      source: "settings",
    });
    invalidateWorkspaces();
    return c.json({ ...toItem(request, mutation.grant.createdAt) });
  });

  return routes;
}

export const credentialShareRoutes = createCredentialShareRoutes();

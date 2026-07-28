import { checkCredentialPath } from "./credentialPaths.js";
import { ensureCredentialPathExists, listCredentialRequests } from "./credentialRequests.js";

/**
 * 随包分发的命令行工具(桌面端的 lark-cli)预置授权。
 *
 * 目的:这类工具是产品自己带的、用户早就在用的,升级到声明式共享后不该冒出一张新确认卡。
 * 口径:仍然走同一张表、同一套校验——只是来源标成 preset,且必须已被某个已启用技能声明,
 * 不接受任意路径;安全页里和其它条目一样可以收回。
 */
export interface PresetCredentialGrantResult {
  seeded: string[];
  skipped: string[];
}

function parsePresetPaths(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

export async function seedPresetCredentialGrants(deps: {
  home: string;
  createGrant: (input: {
    path: string;
    skillName: string;
    declared: string;
    source: "preset";
  }) => Promise<unknown>;
  raw?: string;
}): Promise<PresetCredentialGrantResult> {
  const declaredPaths = parsePresetPaths(deps.raw ?? process.env.QINGAGENT_PRESET_CREDENTIAL_PATHS);
  if (declaredPaths.length === 0) return { seeded: [], skipped: [] };
  const requests = await listCredentialRequests({ home: deps.home });
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const declared of declaredPaths) {
    const checked = checkCredentialPath(declared, deps.home);
    if (!checked.ok) {
      skipped.push(declared);
      continue;
    }
    const request = requests.find((item) => item.path === checked.value.path);
    if (!request) {
      skipped.push(declared);
      continue;
    }
    await ensureCredentialPathExists(request.path);
    await deps.createGrant({
      path: request.path,
      skillName: request.skillName,
      declared: request.declared,
      source: "preset",
    });
    seeded.push(request.path);
  }
  return { seeded, skipped };
}

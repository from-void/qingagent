import { useCallback, useEffect, useState } from "react";
import type { ConnectorId, CredentialShareItem } from "@qingagent/contract-ts";
import { parseCredentialShareItems } from "./credentialShare";

export const SKILLS_CHANGED_EVENT = "qingagent:skills-changed";

export interface SkillBaseInfo {
  name: string;
  description: string;
  label: string;
  summary: string;
  icon: string;
  source: "builtin" | "installed";
  userInvocable: boolean;
  placeholder?: string;
  config?: string;
  tools: string[];
  enabled: boolean;
  connectorId?: ConnectorId;
}

export interface SkillInfo extends SkillBaseInfo {
  children: SkillInfo[];
}

export interface SkillDetailInfo extends SkillBaseInfo {
  body: string;
}

export interface SkillInstallResult {
  name: string;
}

export function useSkills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // 初值必须是 true:首拉由挂载后的 effect 发起,若初值 false,首帧就会命中
  // 「!loading && skills.length === 0」渲染出「暂无技能」,切到技能 tab 闪一帧再被列表顶掉。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/skills");
      if (!res.ok) throw new Error(`技能列表加载失败 (${res.status})`);
      const data = (await res.json()) as { skills?: SkillInfo[] };
      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "技能列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const target = globalThis.window;
    if (!target) return undefined;
    const onSkillsChanged = () => {
      void refresh();
    };
    target.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
    return () => target.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
  }, [refresh]);

  const setSkillEnabled = useCallback(
    async (name: string, enabled: boolean): Promise<CredentialShareItem[]> => {
      setSkills((prev) =>
        prev.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
      );
      const action = enabled ? "enable" : "disable";
      const res = await fetch(`/api/v1/skills/${encodeURIComponent(name)}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        await refresh();
        throw new Error(`技能${enabled ? "启用" : "停用"}失败`);
      }
      // 刚启用的技能可能要共享命令行工具的登录信息,把待授权条目交给调用方弹卡。
      const pending = parseCredentialShareItems(
        await res.json().then((body: unknown) => ({
          items: (body as { credentialRequests?: unknown }).credentialRequests,
        })).catch(() => ({ items: [] })),
      );
      await refresh();
      notifySkillsChanged();
      return pending;
    },
    [refresh],
  );

  const deleteSkill = useCallback(
    async (name: string) => {
      const res = await fetch(`/api/v1/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("删除技能失败");
      await refresh();
      notifySkillsChanged();
    },
    [refresh],
  );

  const installSkillMd = useCallback(
    // name 不再从前端解析传入:后端以 SKILL.md frontmatter 为唯一真源自行取名校验。
    async (skillMd: string): Promise<SkillInstallResult> => {
      const res = await fetch("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd }),
      });
      if (!res.ok) throw new Error(await readError(res, "安装技能失败"));
      const result = await readInstallResult(res);
      await refresh();
      notifySkillsChanged();
      return result;
    },
    [refresh],
  );

  const installZip = useCallback(
    async (file: File): Promise<SkillInstallResult> => {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/v1/skills/install", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(await readError(res, "安装技能失败"));
      const result = await readInstallResult(res);
      await refresh();
      notifySkillsChanged();
      return result;
    },
    [refresh],
  );

  const getSkillDetail = useCallback(async (
    name: string,
    childName?: string,
  ): Promise<SkillDetailInfo> => {
    const childQuery = childName ? `?child=${encodeURIComponent(childName)}` : "";
    const res = await fetch(`/api/v1/skills/${encodeURIComponent(name)}${childQuery}`);
    if (!res.ok) throw new Error(`技能详情加载失败 (${res.status})`);
    return (await res.json()) as SkillDetailInfo;
  }, []);

  const setSkillLabel = useCallback(
    async (name: string, label: string): Promise<SkillDetailInfo> => {
      const res = await fetch(`/api/v1/skills/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(await readError(res, "显示名保存失败"));
      await refresh();
      notifySkillsChanged();
      return await getSkillDetail(name);
    },
    [getSkillDetail, refresh],
  );

  return {
    skills,
    loading,
    error,
    refresh,
    setSkillEnabled,
    deleteSkill,
    installSkillMd,
    installZip,
    setSkillLabel,
    getSkillDetail,
  };
}

function notifySkillsChanged(): void {
  globalThis.window?.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function readInstallResult(res: Response): Promise<SkillInstallResult> {
  const data = (await res.json()) as { name?: unknown };
  if (typeof data.name !== "string" || !data.name) throw new Error("安装技能失败");
  return { name: data.name };
}

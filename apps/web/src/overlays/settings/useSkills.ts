import { useCallback, useEffect, useState } from "react";

export const SKILLS_CHANGED_EVENT = "qingagent:skills-changed";

export interface SkillInfo {
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
}

export interface SkillDetailInfo extends SkillInfo {
  body: string;
}

export function useSkills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
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
    async (name: string, enabled: boolean) => {
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
      await refresh();
      notifySkillsChanged();
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
    async (skillMd: string) => {
      const res = await fetch("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd }),
      });
      if (!res.ok) throw new Error(await readError(res, "安装技能失败"));
      await refresh();
      notifySkillsChanged();
    },
    [refresh],
  );

  const installZip = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/v1/skills/install", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(await readError(res, "安装技能失败"));
      await refresh();
      notifySkillsChanged();
    },
    [refresh],
  );

  const getSkillDetail = useCallback(async (name: string): Promise<SkillDetailInfo> => {
    const res = await fetch(`/api/v1/skills/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`技能详情加载失败 (${res.status})`);
    return (await res.json()) as SkillDetailInfo;
  }, []);

  return {
    skills,
    loading,
    error,
    refresh,
    setSkillEnabled,
    deleteSkill,
    installSkillMd,
    installZip,
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

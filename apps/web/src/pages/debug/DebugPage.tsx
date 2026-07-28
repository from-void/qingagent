import { useEffect, useState } from "react";
import { CaretIcon } from "../../system/icons";
import "./debug.css";

// F7 debug 页:skill / tool 原始视图(需求:能看到所有 skill 和 tool 的原始数据)。
// 产品决策:生产也开放(内容已脱敏,只含能力说明与 schema,无密钥)。
// 样式沿用全局 ink/line design tokens(app 级变量),debug 取向从简。

interface SkillItem {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  userInvocable: boolean;
}

interface ToolItem {
  id: string;
  description: string;
  group: string;
  inputSchema: unknown;
}

interface RawSkillState {
  name: string;
  raw: string;
  truncated?: boolean;
  originalBytes?: number;
  maxBytes?: number;
}

export function DebugPage() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [rawSkill, setRawSkill] = useState<RawSkillState | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [skillsRes, toolsRes] = await Promise.all([
          fetch("/api/v1/debug/skills", { signal: controller.signal }),
          fetch("/api/v1/debug/tools", { signal: controller.signal }),
        ]);
        if (skillsRes.ok) setSkills(((await skillsRes.json()) as { skills: SkillItem[] }).skills);
        if (toolsRes.ok) setTools(((await toolsRes.json()) as { tools: ToolItem[] }).tools);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError("debug 数据加载失败");
      }
    })();
    return () => controller.abort();
  }, []);

  const showRaw = async (name: string) => {
    if (rawSkill?.name === name) {
      setRawSkill(null);
      return;
    }
    try {
      const res = await fetch(`/api/v1/debug/skills/${encodeURIComponent(name)}/raw`);
      if (res.ok) {
        const body = (await res.json()) as RawSkillState;
        setRawSkill(body);
      }
    } catch {
      setError(`读取 ${name} 原文失败`);
    }
  };

  return (
    <section className="debug-page" data-wf="DebugPage">
      <header className="dbg-head">
        <button type="button" className="dbg-back" onClick={() => (window.location.hash = "#/")}>
          <CaretIcon size={12} direction="left" />首页
        </button>
        <h1 className="dbg-title">Debug · Skill / Tool 原始视图</h1>
      </header>
      {error && <p className="dbg-error">{error}</p>}

      <h2 className="dbg-section">Skills({skills.length})</h2>
      <ul className="dbg-list">
        {skills.map((s) => (
          <li key={s.name} className="dbg-item">
            <div className="dbg-row">
              <span className="dbg-name font-mono">{s.name}</span>
              <span className="dbg-meta">
                {s.source}
                {!s.enabled && " · 已禁用"}
                {s.userInvocable && " · 可用户调用"}
              </span>
              <button type="button" className="dbg-btn" onClick={() => void showRaw(s.name)}>
                {rawSkill?.name === s.name ? "收起" : "原文"}
              </button>
            </div>
            <p className="dbg-desc">{s.description}</p>
            {rawSkill?.name === s.name && (
              <>
                {rawSkill.truncated && (
                  <p className="dbg-truncated">
                    原文已截断: {rawSkill.maxBytes} / {rawSkill.originalBytes} bytes
                  </p>
                )}
                <pre className="dbg-raw">{rawSkill.raw}</pre>
              </>
            )}
          </li>
        ))}
      </ul>

      <h2 className="dbg-section">Tools({tools.length})</h2>
      <ul className="dbg-list">
        {tools.map((t) => {
          const toolKey = `${t.group}:${t.id}`;
          return (
            <li key={toolKey} className="dbg-item">
              <div className="dbg-row">
                <span className="dbg-name font-mono">{t.id}</span>
                <span className="dbg-meta">{t.group}</span>
                {t.inputSchema != null && (
                  <button
                    type="button"
                    className="dbg-btn"
                    onClick={() => setOpenTool(openTool === toolKey ? null : toolKey)}
                  >
                    {openTool === toolKey ? "收起" : "schema"}
                  </button>
                )}
              </div>
              <p className="dbg-desc">{t.description}</p>
              {openTool === toolKey && t.inputSchema != null && (
                <pre className="dbg-raw">{JSON.stringify(t.inputSchema, null, 2)}</pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

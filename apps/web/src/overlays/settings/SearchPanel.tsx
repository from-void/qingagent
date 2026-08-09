import { useCallback, useEffect, useRef, useState } from "react";
import { useDelayedVisible } from "../../system/useDelayedVisible";

type SearchProviderHealthStatus = "ok" | "auth" | "quota";
type PrimarySearchSource = "db" | "env" | "none";

interface PrimarySearchSettings {
  enabled: boolean;
  keyConfigured: boolean;
  maskedTail: string | null;
  source: PrimarySearchSource;
}

interface SearchProviderSettings {
  id: string;
  label: string;
  kind: "scrape" | "api";
  enabled: boolean;
  keyConfigured: boolean;
  maskedTail: string | null;
  health: { status: SearchProviderHealthStatus; quotaUntil: string | null };
  freeQuotaNote: string;
  keyUrl: string | null;
}

function healthLabel(status: SearchProviderHealthStatus): string {
  if (status === "auth") return "key 无效";
  if (status === "quota") return "额度冷却";
  return "正常";
}

function errorKindLabel(kind: string | undefined): string {
  if (kind === "auth") return "key 无效";
  if (kind === "quota") return "额度受限";
  if (kind === "missing_key") return "尚未配置 key";
  return "请求未完成";
}

function primarySourceLabel(source: PrimarySearchSource): string {
  if (source === "db") return "自定义 key";
  if (source === "env") return "站点默认 key";
  return "未配置 key";
}

export function SearchPanel() {
  const [primary, setPrimary] = useState<PrimarySearchSettings | null>(null);
  const [providers, setProviders] = useState<SearchProviderSettings[]>([]);
  const [primaryDraft, setPrimaryDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // 加载占位延迟 250ms 才显形,快请求不闪
  const showLoading = useDelayedVisible(loading && providers.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const providerUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [searchRes, primaryRes] = await Promise.all([
        fetch("/api/v1/settings/search", { signal }),
        fetch("/api/v1/settings/search/primary", { signal }),
      ]);
      if (!searchRes.ok || !primaryRes.ok) {
        throw new Error(`${searchRes.status}/${primaryRes.status}`);
      }
      const body = (await searchRes.json()) as { providers?: SearchProviderSettings[] };
      const primaryBody = (await primaryRes.json()) as PrimarySearchSettings;
      if (mountedRef.current && !signal?.aborted) {
        setProviders(body.providers ?? []);
        setPrimary(primaryBody);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) {
        setProviders([]);
        setPrimary(null);
        setLoading(false);
        setMessage("搜索设置加载失败,请稍后重试");
      }
    }
  }, []);

  useEffect(() => {
    // StrictMode 会 mount→unmount→remount,setup 阶段必须重置,否则 ref 残留 false 永久拦截 setState
    mountedRef.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [load]);

  const updatePrimary = async (patch: Record<string, unknown>) => {
    setBusy("primary");
    setMessage(null);
    try {
      const res = await fetch("/api/v1/settings/search/primary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as PrimarySearchSettings;
      if (!mountedRef.current) return;
      setPrimary(body);
      setPrimaryDraft("");
      setMessage("已更新 DeepSeek 主搜索");
    } catch {
      if (mountedRef.current) setMessage("DeepSeek 主搜索更新失败,请重试");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const togglePrimary = async () => {
    if (!primary) return;
    await updatePrimary({ enabled: !primary.enabled });
  };

  const savePrimary = async () => {
    const draft = primaryDraft.trim();
    if (!draft) {
      setMessage("请输入 DeepSeek API key");
      return;
    }
    await updatePrimary({ enabled: true, apiKey: draft });
  };

  const clearPrimary = async () => {
    await updatePrimary({ apiKey: "" });
  };

  const updateProvider = (provider: SearchProviderSettings, patch: Record<string, unknown>) => {
    const update = providerUpdateQueueRef.current.then(async () => {
      if (mountedRef.current) {
        setBusy(provider.id);
        setMessage(null);
      }
      try {
        const res = await fetch(`/api/v1/settings/search/${encodeURIComponent(provider.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { providers?: SearchProviderSettings[] };
        if (!mountedRef.current) return;
        setProviders(body.providers ?? []);
        setDrafts((prev) => ({ ...prev, [provider.id]: "" }));
        setMessage(`已更新 ${provider.label}`);
      } catch {
        if (mountedRef.current) setMessage(`${provider.label} 更新失败,请重试`);
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    });
    providerUpdateQueueRef.current = update;
    return update;
  };

  const toggleProvider = async (provider: SearchProviderSettings) => {
    if (provider.id === "bing" || provider.id === "ddg") return;
    const nextEnabled = !provider.enabled;
    const draft = (drafts[provider.id] ?? "").trim();
    if (nextEnabled && !provider.keyConfigured && !draft) {
      setMessage(provider.id === "searxng" ? "请先填写 SearXNG URL" : `请先填写 ${provider.label} API key`);
      return;
    }
    const patch: Record<string, unknown> = { enabled: nextEnabled };
    if (draft) {
      if (provider.id === "searxng") patch.url = draft;
      else patch.apiKey = draft;
    }
    await updateProvider(provider, patch);
  };

  const saveProvider = async (provider: SearchProviderSettings) => {
    const draft = (drafts[provider.id] ?? "").trim();
    if (!draft) {
      setMessage(provider.id === "searxng" ? "请输入 SearXNG URL" : `请输入 ${provider.label} API key`);
      return;
    }
    await updateProvider(provider, {
      enabled: true,
      [provider.id === "searxng" ? "url" : "apiKey"]: draft,
    });
  };

  const clearProvider = async (provider: SearchProviderSettings) => {
    await updateProvider(provider, {
      enabled: false,
      [provider.id === "searxng" ? "url" : "apiKey"]: "",
    });
  };

  const testProvider = async (provider: SearchProviderSettings) => {
    setBusy(provider.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/settings/search/${encodeURIComponent(provider.id)}/test`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null) as {
        ok?: boolean;
        errorKind?: string;
        resultCount?: number;
      } | null;
      if (!mountedRef.current) return;
      if (!body) {
        setMessage(`${provider.label} 测试请求未完成`);
        return;
      }
      setMessage(
        res.ok && body.ok
          ? `${provider.label} 测试通过,返回 ${body.resultCount ?? 0} 条`
          : `${provider.label} 测试失败:${errorKindLabel(body.errorKind)}`,
      );
      await load();
    } catch {
      if (mountedRef.current) setMessage(`${provider.label} 测试请求未完成`);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  return (
    <div className="settings-search" data-wf="SearchPanel">
      <p className="sm-note" style={{ marginTop: 0 }}>
        搜索 Key 保存为本站配置；Bing 和 DuckDuckGo 会在其他搜索不可用时自动补充。
      </p>
      <section className="ss-card ss-primary">
        <div className="ss-head">
          <div className="ss-titleline">
            <h3 className="sm-title">DeepSeek 联网 · 主搜索</h3>
            <span className={`ss-badge ${primary?.enabled === false ? "ss-quota" : "ss-ok"}`}>
              {primary?.enabled === false ? "已关闭" : "已启用"}
            </span>
          </div>
          <button
            type="button"
            className={`sk-toggle${primary?.enabled === false ? "" : " sk-on"}`}
            disabled={!primary || busy === "primary"}
            aria-pressed={primary?.enabled ?? true}
            onClick={() => void togglePrimary()}
          >
            <span className="sk-toggle-dot" aria-hidden="true" />
            {primary?.enabled === false ? "启用" : "停用"}
          </button>
        </div>
        <p className="ss-meta">
          主搜索用 DeepSeek 服务端联网,自动综合答案与来源;关闭则只用下方多源。
          {primary && (
            <>
              {" · "}
              {primarySourceLabel(primary.source)}
              {primary.maskedTail ? ` 尾号 ${primary.maskedTail}` : ""}
            </>
          )}
        </p>
        <div className="sm-keyrow">
          <input
            type="text"
            className="sm-keyinput sm-secret"
            placeholder="留空用站点默认 key;也可填你自己的 DeepSeek key"
            value={primaryDraft}
            onChange={(e) => setPrimaryDraft(e.target.value)}
          />
          <button
            type="button"
            className="sm-btn"
            disabled={busy === "primary" || !primaryDraft.trim()}
            onClick={() => void savePrimary()}
          >
            保存
          </button>
        </div>
        <div className="sm-keyops">
          <button
            type="button"
            className="sm-btn"
            disabled={busy === "primary" || primary?.source !== "db"}
            onClick={() => void clearPrimary()}
          >
            清除自定义 key
          </button>
        </div>
      </section>
      <div className="ss-section-head">
        <h3 className="sm-title">主搜索的回退源</h3>
        <span>DeepSeek 关闭、失败或无结果时使用</span>
      </div>
      {loading && providers.length === 0 && <p className="sm-empty">加载中…</p>}
      {!loading && providers.length === 0 && <p className="sm-empty">暂无搜索源</p>}
      <div className="ss-grid">
        {providers.map((provider) => {
          const configurable = provider.kind === "api" || provider.id === "searxng";
          const draft = drafts[provider.id] ?? "";
          return (
            <section key={provider.id} className="ss-card">
              <div className="ss-head">
                <div className="ss-titleline">
                  <h3 className="sm-title">{provider.label}</h3>
                  <span className={`ss-badge ss-${provider.health.status}`}>
                    {healthLabel(provider.health.status)}
                  </span>
                </div>
                <button
                  type="button"
                  className="sm-btn"
                  disabled={provider.id === "bing" || provider.id === "ddg" || busy === provider.id}
                  aria-pressed={provider.enabled}
                  onClick={() => void toggleProvider(provider)}
                >
                  {provider.id === "bing" || provider.id === "ddg"
                    ? "兜底启用"
                    : provider.enabled
                      ? "已启用"
                      : "已停用"}
                </button>
              </div>
              <p className="ss-meta">
                {provider.freeQuotaNote}
                {provider.keyUrl && (
                  <>
                    {" · "}
                    <a href={provider.keyUrl} target="_blank" rel="noreferrer">
                      获取配置
                    </a>
                  </>
                )}
              </p>
              {!configurable && (
                // R1-A:免费爬取源也提供「测试」自检(WSL/受限网络下爬取可能被反爬/reset)
                <div className="sm-keyops">
                  <button
                    type="button"
                    className="sm-btn"
                    disabled={busy === provider.id}
                    onClick={() => void testProvider(provider)}
                  >
                    {busy === provider.id ? "处理中…" : "测试"}
                  </button>
                </div>
              )}
              {configurable && (
                <>
                  <div className="sm-keyrow">
                    <input
                      type="text"
                      className={`sm-keyinput${provider.id === "searxng" ? "" : " sm-secret"}`}
                      placeholder={
                        provider.id === "searxng"
                          ? provider.keyConfigured && provider.maskedTail
                            ? `已配置 URL,尾号 ${provider.maskedTail};输入新 URL 更新`
                            : "SearXNG 实例 URL"
                          : provider.keyConfigured && provider.maskedTail
                            ? `已配置 key,尾号 ${provider.maskedTail};输入新 key 更新`
                            : `${provider.label} API key`
                      }
                      value={draft}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="sm-btn"
                      disabled={busy === provider.id || !draft.trim()}
                      onClick={() => void saveProvider(provider)}
                    >
                      保存
                    </button>
                  </div>
                  <div className="sm-keyops">
                    <button
                      type="button"
                      className="sm-btn"
                      disabled={busy === provider.id || !provider.keyConfigured}
                      onClick={() => void testProvider(provider)}
                    >
                      {busy === provider.id ? "处理中…" : "测试"}
                    </button>
                    <button
                      type="button"
                      className="sm-btn"
                      disabled={busy === provider.id || !provider.keyConfigured}
                      onClick={() => void clearProvider(provider)}
                    >
                      清除
                    </button>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
      {message && <p className="sm-message">{message}</p>}
    </div>
  );
}

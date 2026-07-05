import { useEffect, useState } from "react";

// F6 对话上下文 debug:展示最近一次 agent 调用的真实 inputTokens 与窗口占比。
// 口径标注"约"——inputTokens 来自模型上报,≈ 当前上下文体积(系统提示+文档快照+消息)。
// 挂在聊天输入区下方,debug 取向,流结束后约 8s 轮询一次刷新。

interface ContextDebugInfo {
  available: boolean;
  modelId?: string;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  contextWindow: number;
  percentUsed?: number;
  measuredAt?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextDebugPill({ sessionId }: { sessionId: string | null }) {
  const [info, setInfo] = useState<ContextDebugInfo | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    let inFlight: AbortController | null = null;
    const load = async () => {
      if (document.visibilityState === "hidden" || inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const res = await fetch(`/api/v1/debug/context?sessionId=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
        });
        if (res.ok && !cancelled) setInfo((await res.json()) as ContextDebugInfo);
      } catch {
        // debug pill 静默失败,不打扰主流程
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      inFlight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId]);

  if (!info?.available || info.lastInputTokens == null) return null;

  return (
    <div
      className="ws-ctx-pill font-mono"
      data-wf="ContextDebugPill"
      title={`最近一次模型调用:输入 ${info.lastInputTokens} tokens / 输出 ${info.lastOutputTokens ?? 0} tokens · ${info.modelId ?? ""} · 测于 ${info.measuredAt ?? ""}`}
    >
      ctx ≈ {formatTokens(info.lastInputTokens)} / {formatTokens(info.contextWindow)}
      ({(info.percentUsed ?? 0) < 0.1 ? "<0.1" : (info.percentUsed ?? 0).toFixed(1)}%)
    </div>
  );
}

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 判断是否为「动态 import 的 chunk 加载失败」类错误。
 * 典型场景:VPS 部署后换了 chunk hash,停在旧 index.html 的用户点进 lazy 路由(HomePage/
 * WorkspacePage 等),旧 chunk URL 已 404 → 动态 import reject。这类错误刷新即可恢复
 * (拉到新 index.html + 新 chunk),应给「点刷新」兜底,绝不能整树白屏不可恢复。
 */
function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; message?: string };
  const msg = String(e.message ?? "");
  return (
    e.name === "ChunkLoadError" ||
    /dynamically imported module|failed to fetch dynamically|importing a module script failed|error loading dynamically imported|css chunk|loading chunk/i.test(
      msg,
    )
  );
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 顶层错误边界:捕获渲染期/懒加载期未处理错误,给浅色兜底 UI(而非整树白屏)。
 * 之前全库无 ErrorBoundary,任何渲染抛错或 lazy chunk import 失败都会让整个 React 树白屏
 * 不可恢复(e2e R30-c1:prod 懒加载 CSS preload error 直接整站白屏击穿会话)。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] caught", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <div
        role="alert"
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          // 与 boot/首页同色系暖纸底,兜底不刺眼(= body 稳态色 --bg-window #ece4d3,与 boot 同步)
          background: "var(--app-boot-bg, var(--bg-window))",
          color: "var(--ink-1)",
          fontFamily: "var(--font-zh-serif)",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {chunk ? "页面已更新" : "出了点小问题"}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 360 }}>
          {chunk
            ? "应用有了新版本，刷新一下即可加载最新页面。"
            : "页面遇到一个错误，刷新通常可以恢复。"}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 4,
            padding: "8px 20px",
            borderRadius: 8,
            border: "1px solid rgba(168,130,63,.55)",
            background: "rgba(168,130,63,.12)",
            color: "#8a6a2f",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          刷新页面
        </button>
      </div>
    );
  }
}

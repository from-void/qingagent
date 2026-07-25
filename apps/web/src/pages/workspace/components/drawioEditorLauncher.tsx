import { createRoot } from "react-dom/client";
import { normalizeDrawioSource } from "@qingagent/pm-schema";
import { DrawioEditorOverlay } from "./DrawioEditorOverlay";
import type { DrawioEditorResult } from "./drawioEmbedProtocol";

type ActiveEditorSession = {
  host: HTMLDivElement;
  finish: (result: DrawioEditorResult | null) => void;
};

let activeEditorSession: ActiveEditorSession | null = null;

/**
 * 命令式入口让 Tiptap NodeView、顶部工具栏和块手柄共用同一编辑器。
 * 只有用户主动进入时才创建 iframe；取消返回 null，调用方不得写文档。
 */
export function openDrawioEditor(
  rawSource: string,
  title = "drawio 可视化编辑",
  onSave?: (result: DrawioEditorResult) => void,
): Promise<DrawioEditorResult | null> {
  if (typeof document === "undefined") return Promise.reject(new Error("drawio 编辑器只能在浏览器中打开"));
  if (activeEditorSession?.host.isConnected) {
    return Promise.reject(new Error("已有 drawio 编辑器正在打开"));
  }
  // host 被路由切换、ErrorBoundary 或外层 DOM 清理提前摘除时，旧 Promise 可能还没走到
  // Overlay.onClose。把这种孤儿会话结算为取消，避免模块级单例永久锁死后续所有入口。
  activeEditorSession?.finish(null);
  const source = normalizeDrawioSource(rawSource);

  const host = document.createElement("div");
  host.dataset.drawioEditorHost = "true";
  document.body.appendChild(host);
  const root = createRoot(host);

  return new Promise((resolve) => {
    let settled = false;
    let session!: ActiveEditorSession;
    const finish = (result: DrawioEditorResult | null) => {
      if (settled) return;
      settled = true;
      if (activeEditorSession === session) activeEditorSession = null;
      // onClose 可能来自 Overlay 自身的 React 点击事件，延迟清理可避免在
      // 当前 React 提交过程中同步卸载另一个 root。即便 unmount 抛错，finally
      // 也必须移除 host 并 resolve，调用方的 opening 状态才不会永久卡住。
      queueMicrotask(() => {
        try {
          root.unmount();
        } finally {
          host.remove();
          resolve(result);
        }
      });
    };
    // 先登记会话再 render，覆盖 render 过程中 Overlay 同步失败/外层清理的边界。
    session = { host, finish };
    activeEditorSession = session;
    try {
      root.render(
        <DrawioEditorOverlay source={source} title={title} onSave={onSave} onClose={finish} />,
      );
    } catch (renderError) {
      finish(null);
      throw renderError;
    }
  });
}

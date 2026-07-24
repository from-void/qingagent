import { createRoot } from "react-dom/client";
import { normalizeDrawioSource } from "@qingagent/pm-schema";
import { DrawioEditorOverlay } from "./DrawioEditorOverlay";
import type { DrawioEditorResult } from "./drawioEmbedProtocol";

let activeEditor = false;

/**
 * 命令式入口让 Tiptap NodeView、顶部工具栏和块手柄共用同一编辑器。
 * 只有用户主动进入时才创建 iframe；取消返回 null，调用方不得写文档。
 */
export function openDrawioEditor(
  rawSource: string,
  title = "drawio 可视化编辑",
): Promise<DrawioEditorResult | null> {
  if (typeof document === "undefined") return Promise.reject(new Error("drawio 编辑器只能在浏览器中打开"));
  if (activeEditor) return Promise.reject(new Error("已有 drawio 编辑器正在打开"));
  const source = normalizeDrawioSource(rawSource);
  activeEditor = true;

  const host = document.createElement("div");
  host.dataset.drawioEditorHost = "true";
  document.body.appendChild(host);
  const root = createRoot(host);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DrawioEditorResult | null) => {
      if (settled) return;
      settled = true;
      activeEditor = false;
      // onClose 可能来自 Overlay 自身的 React 点击事件，延迟清理可避免在
      // 当前 React 提交过程中同步卸载另一个 root。
      queueMicrotask(() => {
        root.unmount();
        host.remove();
        resolve(result);
      });
    };
    root.render(<DrawioEditorOverlay source={source} title={title} onClose={finish} />);
  });
}

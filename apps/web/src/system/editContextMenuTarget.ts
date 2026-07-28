// 可编辑区域右键菜单的「命中判定 + 可用项计算」纯逻辑,单独抽出来便于直接单测。
//
// 背景:桌面端原来弹的是 Electron 原生菜单(apps/desktop/src/main/contextMenu.ts),
// 原生菜单改不了字体,和全应用的宋体割裂。改成渲染进程自绘后,判定逻辑落在这里。

/** 支持文本编辑、右键菜单有意义的 input type;其余(checkbox/按钮/文件…)一律不接管。 */
const TEXTUAL_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
  "email",
  "number",
  "", // 未写 type 等同 text
]);

export type EditableTarget =
  | { kind: "input"; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "contenteditable"; element: HTMLElement };

/** 从右键事件的 target 往上找最近的可编辑宿主;找不到返回 null(交回浏览器/原生菜单)。 */
export function resolveEditableTarget(node: EventTarget | null): EditableTarget | null {
  const start = node instanceof Element ? node : null;
  if (!start) return null;
  const host = start.closest<HTMLElement>(
    'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (!host) return null;
  if (host instanceof HTMLTextAreaElement) {
    return host.disabled ? null : { kind: "input", element: host };
  }
  if (host instanceof HTMLInputElement) {
    if (host.disabled) return null;
    if (!TEXTUAL_INPUT_TYPES.has(host.type.toLowerCase())) return null;
    return { kind: "input", element: host };
  }
  return { kind: "contenteditable", element: host };
}

export interface EditMenuAbility {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

/**
 * 计算四项的可用状态。
 * - 只读区域:能复制/全选,不能剪切/粘贴;
 * - 密码框:不给复制/剪切(浏览器本身也不允许读出明文)。
 */
export function computeEditMenuAbility(input: {
  target: EditableTarget;
  hasSelection: boolean;
  hasContent: boolean;
}): EditMenuAbility {
  const { target, hasSelection, hasContent } = input;
  const readOnly =
    target.kind === "input"
      ? target.element.readOnly
      : target.element.getAttribute("contenteditable") === "false";
  const isPassword =
    target.kind === "input" &&
    target.element instanceof HTMLInputElement &&
    target.element.type.toLowerCase() === "password";
  return {
    canCut: !readOnly && hasSelection && !isPassword,
    canCopy: hasSelection && !isPassword,
    canPaste: !readOnly,
    canSelectAll: hasContent,
  };
}

/** 把浮层左上角夹回视口内(留 margin 边距),保证菜单不越出屏幕。 */
export function clampMenuPosition(input: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const margin = input.margin ?? 6;
  const maxLeft = Math.max(margin, input.viewportWidth - input.menuWidth - margin);
  const maxTop = Math.max(margin, input.viewportHeight - input.menuHeight - margin);
  return {
    left: Math.min(Math.max(input.x, margin), maxLeft),
    top: Math.min(Math.max(input.y, margin), maxTop),
  };
}

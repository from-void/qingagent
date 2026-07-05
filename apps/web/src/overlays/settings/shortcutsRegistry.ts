// 快捷键单一数据源:设置页「快捷键」tab 由此渲染,新增/修改快捷键必须同步本表。
// source 标注实现出处,避免"文档写了但不能用":
//   app    —— 本仓库代码显式注册的 handler
//   tiptap —— TipTap StarterKit / 扩展内建 keymap(随编辑器聚焦生效)
//   browser—— 浏览器 / contenteditable 原生行为

export type ShortcutSource = "app" | "tiptap" | "browser";

export interface ShortcutItem {
  /** 按键序列,"Mod" 渲染时按平台显示 ⌘ / Ctrl。 */
  keys: string[];
  label: string;
  source: ShortcutSource;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: "global",
    title: "全局",
    items: [
      { keys: ["Esc"], label: "关闭弹层 / 预览", source: "app" },
    ],
  },
  {
    id: "chat",
    title: "AI 对话输入框",
    items: [
      { keys: ["Mod", "Enter"], label: "发送消息", source: "app" },
      { keys: ["Enter"], label: "换行", source: "browser" },
      { keys: ["Backspace"], label: "在标记块后按删除可移除引用/附件标记", source: "app" },
      { keys: ["Mod", "V"], label: "粘贴(自动转纯文本)", source: "app" },
    ],
  },
  {
    id: "editor-text",
    title: "编辑器 · 文本样式",
    items: [
      { keys: ["Mod", "B"], label: "加粗", source: "tiptap" },
      { keys: ["Mod", "I"], label: "斜体", source: "tiptap" },
      { keys: ["Mod", "U"], label: "下划线", source: "tiptap" },
      { keys: ["Mod", "Shift", "S"], label: "删除线", source: "tiptap" },
      { keys: ["Mod", "E"], label: "行内代码", source: "tiptap" },
      { keys: ["Mod", "Shift", "H"], label: "高亮", source: "tiptap" },
    ],
  },
  {
    id: "editor-block",
    title: "编辑器 · 块级结构",
    items: [
      { keys: ["Mod", "Alt", "1"], label: "一级标题(2~6 级同理)", source: "tiptap" },
      { keys: ["Mod", "Alt", "0"], label: "正文段落", source: "tiptap" },
      { keys: ["Mod", "Shift", "8"], label: "无序列表", source: "tiptap" },
      { keys: ["Mod", "Shift", "7"], label: "有序列表", source: "tiptap" },
      { keys: ["Mod", "Shift", "B"], label: "引用块", source: "tiptap" },
      { keys: ["Mod", "Alt", "C"], label: "代码块", source: "app" },
      { keys: ["Tab"], label: "列表项降级", source: "tiptap" },
      { keys: ["Shift", "Tab"], label: "列表项升级", source: "tiptap" },
    ],
  },
  {
    id: "editor-table",
    title: "编辑器 · 表格",
    items: [
      { keys: ["Tab"], label: "跳到下一个单元格(末尾自动新增行)", source: "tiptap" },
      { keys: ["Shift", "Tab"], label: "跳到上一个单元格", source: "tiptap" },
      { keys: ["Backspace"], label: "整表选中时删除表格", source: "tiptap" },
      { keys: ["Delete"], label: "整表选中时删除表格", source: "tiptap" },
      { keys: ["Mod", "Backspace"], label: "整表选中时删除表格", source: "tiptap" },
      { keys: ["Mod", "Delete"], label: "整表选中时删除表格", source: "tiptap" },
    ],
  },
  {
    id: "editor-history",
    title: "编辑器 · 编辑操作",
    items: [
      { keys: ["Mod", "Z"], label: "撤销", source: "tiptap" },
      { keys: ["Mod", "Shift", "Z"], label: "重做", source: "tiptap" },
      { keys: ["Mod", "Y"], label: "重做", source: "tiptap" },
      { keys: ["Mod", "A"], label: "全选", source: "browser" },
      { keys: ["Mod", "C"], label: "复制", source: "browser" },
      { keys: ["Mod", "X"], label: "剪切", source: "browser" },
      { keys: ["Mod", "V"], label: "粘贴", source: "browser" },
    ],
  },
];

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** 把按键 token 渲染成当前平台的展示文案。 */
export function formatKey(token: string): string {
  if (token === "Mod") return IS_MAC ? "⌘" : "Ctrl";
  if (token === "Alt") return IS_MAC ? "⌥" : "Alt";
  if (token === "Shift") return IS_MAC ? "⇧" : "Shift";
  if (token === "Enter") return IS_MAC ? "↵" : "Enter";
  return token;
}

export const SOURCE_LABELS: Record<ShortcutSource, string> = {
  app: "",
  tiptap: "编辑器内建",
  browser: "系统默认",
};

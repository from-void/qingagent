import { isAllowedLinkHref } from "@qingagent/contract-ts";

export type ToolbarCommandGroup = "marks" | "headings" | "blocks" | "align" | "table" | "resourceRef";

export interface ToolbarUnlockConfig {
  marks: boolean;
  headings: boolean;
  blocks: boolean;
  align: boolean;
  table: boolean;
  resourceRef: boolean;
}

export const TOOLBAR_THEME_COLORS = [
  { key: "ink", label: "墨", text: "#2f2a22", highlight: "#eee2c6", border: "#cdbb92" },
  { key: "gray", label: "灰", text: "#5f625c", highlight: "#e8e5dc", border: "#c7c0ae" },
  { key: "slate", label: "青灰", text: "#44555c", highlight: "#dbe7e9", border: "#b5c9cf" },
  { key: "brown", label: "茶", text: "#7a5234", highlight: "#ead8c7", border: "#d0ad8d" },
  { key: "red", label: "朱", text: "#a33a2a", highlight: "#f4d2ca", border: "#dda69b" },
  { key: "orange", label: "橘", text: "#a65d1f", highlight: "#f2d9bd", border: "#d9ad78" },
  { key: "amber", label: "琥珀", text: "#927016", highlight: "#f0e0ad", border: "#d6bd63" },
  { key: "yellow", label: "黄", text: "#7f7418", highlight: "#fff3a3", border: "#e6d87a" },
  { key: "lime", label: "青柠", text: "#627a22", highlight: "#e5efba", border: "#c8d779" },
  { key: "green", label: "绿", text: "#3f7a42", highlight: "#d4edd4", border: "#a8cca8" },
  { key: "sage", label: "鼠尾草", text: "#57745c", highlight: "#dce9d7", border: "#b8cbaa" },
  { key: "mint", label: "薄荷", text: "#2f7b69", highlight: "#cfebe0", border: "#9ccdbf" },
  { key: "teal", label: "青碧", text: "#24777a", highlight: "#cce8e7", border: "#8fc8c8" },
  { key: "cyan", label: "湖蓝", text: "#27738e", highlight: "#cde8f0", border: "#95c9d9" },
  { key: "sky", label: "天青", text: "#3f6e9a", highlight: "#d7e7f6", border: "#a5c5e1" },
  { key: "blue", label: "蓝", text: "#365d9f", highlight: "#cfe0f5", border: "#a3c4e8" },
  { key: "indigo", label: "靛", text: "#4d55a0", highlight: "#d8dcf5", border: "#aeb7e6" },
  { key: "violet", label: "堇", text: "#694c9a", highlight: "#e1d8f2", border: "#bba9df" },
  { key: "purple", label: "紫", text: "#7a4d9b", highlight: "#e7d7ff", border: "#c4a8e8" },
  { key: "magenta", label: "品红", text: "#974487", highlight: "#efd4ea", border: "#d7a0cc" },
  { key: "pink", label: "粉", text: "#a6476f", highlight: "#f5d0cf", border: "#d4a3a1" },
  { key: "rose", label: "玫瑰", text: "#a74755", highlight: "#f3d3d9", border: "#d99faa" },
  { key: "sand", label: "砂", text: "#836d4a", highlight: "#eadfc8", border: "#cdbd95" },
  { key: "lavender", label: "浅藤", text: "#6f5c8f", highlight: "#e5ddf0", border: "#c2b3d8" },
] as const;

export type ToolbarThemeColorKey = (typeof TOOLBAR_THEME_COLORS)[number]["key"];

/**
 * 单元格底色只提供与暖纸皮肤协调的低饱和色。
 * 完整主题色表仍保留给文字、高亮和存量文档渲染；这里仅约束新选择，不迁移旧值。
 */
export const TABLE_CELL_BACKGROUND_COLORS = [
  { key: "ink", label: "米纸", text: "#2f2a22", highlight: "#eee4cf", border: "#cdbb92" },
  { key: "gray", label: "米灰", text: "#5f625c", highlight: "#e7e1d4", border: "#c7c0ae" },
  { key: "sand", label: "细沙", text: "#836d4a", highlight: "#eadfc8", border: "#cdbd95" },
  { key: "brown", label: "茶褐", text: "#7a5234", highlight: "#e5d4c3", border: "#c5aa90" },
  { key: "amber", label: "麦秆", text: "#927016", highlight: "#ead9ae", border: "#c7b276" },
  { key: "orange", label: "浅赭", text: "#a65d1f", highlight: "#e6ceb4", border: "#c6a27e" },
  { key: "red", label: "赭红", text: "#a33a2a", highlight: "#e4c9bf", border: "#c7a096" },
  { key: "yellow", label: "稻纸", text: "#7f7418", highlight: "#eee4bd", border: "#cfc389" },
  { key: "lime", label: "苔黄", text: "#627a22", highlight: "#dde1c2", border: "#b8be8e" },
  { key: "sage", label: "艾绿", text: "#57745c", highlight: "#d6dfcf", border: "#aab9a2" },
  { key: "green", label: "黛绿", text: "#3f7a42", highlight: "#cad9c8", border: "#9eb39d" },
  { key: "teal", label: "苍绿", text: "#24777a", highlight: "#cadbd2", border: "#9eb8aa" },
  { key: "slate", label: "黛灰", text: "#44555c", highlight: "#d3d9d5", border: "#a8b2ad" },
] as const satisfies ReadonlyArray<{
  key: ToolbarThemeColorKey;
  label: string;
  text: string;
  highlight: string;
  border: string;
}>;

export const TOOLBAR_TEXT_COLORS = Object.fromEntries(
  TOOLBAR_THEME_COLORS.map((color) => [color.key, color.text]),
) as Record<ToolbarThemeColorKey, string>;

export const TOOLBAR_HIGHLIGHT_COLORS = Object.fromEntries(
  TOOLBAR_THEME_COLORS.map((color) => [color.key, color.highlight]),
) as Record<ToolbarThemeColorKey, string>;

const ENABLED_CONFIG: ToolbarUnlockConfig = {
  marks: true,
  headings: true,
  blocks: true,
  align: true,
  table: true,
  resourceRef: true,
};

export function resolveToolbarUnlockConfig(): ToolbarUnlockConfig {
  return ENABLED_CONFIG;
}

export function toolbarCommandGroup(cmd: string, val?: string | null): ToolbarCommandGroup | null {
  if (cmd === "formatBlock") {
    return val === "H3" || val === "H4" || val === "H5" || val === "H6" ? "headings" : null;
  }
  if (cmd === "justifyLeft" || cmd === "justifyCenter" || cmd === "justifyRight") {
    return "align";
  }
  if (
    cmd === "bulletList" ||
    cmd === "orderedList" ||
    cmd === "blockquote" ||
    cmd === "taskList" ||
    cmd === "callout" ||
    cmd === "insertInlineMath" ||
    cmd === "insertBlockMath" ||
    cmd === "insertDiagram" ||
    cmd === "insertDrawio" ||
    cmd === "insertTable" ||
    cmd === "insertColumns" ||
    cmd === "codeBlock" ||
    cmd === "horizontalRule"
  ) {
    return "blocks";
  }
  if (
    cmd === "bold" ||
    cmd === "italic" ||
    cmd === "underline" ||
    cmd === "strikeThrough" ||
    cmd === "code" ||
    cmd === "createLink" ||
    cmd === "textColor" ||
    cmd === "hiliteColor"
  ) {
    return "marks";
  }
  return null;
}

export function isToolbarCommandEnabled(
  cmd: string,
  val?: string | null,
  config: ToolbarUnlockConfig = resolveToolbarUnlockConfig(),
): boolean {
  const group = toolbarCommandGroup(cmd, val);
  return group ? config[group] : true;
}

export function isTableToolbarCommandEnabled(
  cmd: string,
  config: ToolbarUnlockConfig = resolveToolbarUnlockConfig(),
): boolean {
  return [
    "bold", "italic", "underline", "strike", "code", "textColor", "highlight",
    "cellBackground", "alignLeft", "alignCenter", "alignRight", "link",
  ].includes(cmd) ? config.table : true;
}

export function sanitizeToolbarLinkHref(input: string | null | undefined): string | null {
  const href = input?.trim() ?? "";
  if (!href) return null;
  if (/[\u0000-\u001f\u007f\s<>"`]/.test(href)) return null;
  return isAllowedLinkHref(href) ? href : null;
}

function normalizeToolbarThemeColor(input: string | null | undefined, values: Record<ToolbarThemeColorKey, string>): ToolbarThemeColorKey | null {
  if (!input || input === "transparent") return null;
  if (input in values) return input as ToolbarThemeColorKey;
  const match = Object.entries(values).find(([, hex]) => hex.toLowerCase() === input.toLowerCase());
  return (match?.[0] as ToolbarThemeColorKey | undefined) ?? null;
}

export function normalizeToolbarHighlightColor(input: string | null | undefined): ToolbarThemeColorKey | null {
  return normalizeToolbarThemeColor(input, TOOLBAR_HIGHLIGHT_COLORS);
}

export function normalizeToolbarTextColor(input: string | null | undefined): ToolbarThemeColorKey | null {
  return normalizeToolbarThemeColor(input, TOOLBAR_TEXT_COLORS);
}

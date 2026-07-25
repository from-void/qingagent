import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type EditContextMenuParams = Pick<
  ContextMenuParams,
  "editFlags" | "isEditable" | "selectionText"
>;

/**
 * 只提供桌面端文本编辑所需的四项原生操作。
 * 启用状态以 Chromium 给出的 editFlags 为准，再收紧可编辑区域与选区条件。
 */
export function buildEditContextMenuTemplate(
  params: EditContextMenuParams,
): MenuItemConstructorOptions[] {
  const hasSelection = params.selectionText.length > 0;

  return [
    {
      label: "剪切",
      role: "cut",
      enabled: params.isEditable && hasSelection && params.editFlags.canCut,
    },
    {
      label: "复制",
      role: "copy",
      enabled: hasSelection && params.editFlags.canCopy,
    },
    {
      label: "粘贴",
      role: "paste",
      enabled: params.isEditable && params.editFlags.canPaste,
    },
    {
      label: "全选",
      role: "selectAll",
      enabled: params.editFlags.canSelectAll,
    },
  ];
}

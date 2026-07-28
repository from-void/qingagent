import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type EditContextMenuParams = Pick<
  ContextMenuParams,
  "editFlags" | "isEditable" | "selectionText"
>;

/**
 * 可编辑区域(输入框/文本域/富文本)交给渲染进程自绘菜单:原生菜单改不了字体，四项永远是系统
 * 默认字体，与全应用宋体皮肤割裂(用户亲测点名)。主进程对可编辑区域一律不弹，避免双菜单。
 * 自绘实现见 apps/web/src/system/EditContextMenu.tsx。
 */
export function shouldUseRendererEditMenu(params: EditContextMenuParams): boolean {
  return params.isEditable;
}

/**
 * 只提供桌面端文本编辑所需的四项原生操作。
 * 启用状态以 Chromium 给出的 editFlags 为准，再收紧可编辑区域与选区条件。
 * 可编辑区域返回空模板(不弹菜单)——那里由渲染进程自绘。
 */
export function buildEditContextMenuTemplate(
  params: EditContextMenuParams,
): MenuItemConstructorOptions[] {
  if (shouldUseRendererEditMenu(params)) return [];
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

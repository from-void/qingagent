import { dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import type { DesktopDialogResult } from "../rendererDialogContract.js";

async function showMessageBoxFallback(
  owner: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<DesktopDialogResult> {
  const activeOwner = owner && !owner.isDestroyed() ? owner : null;
  const { response } = activeOwner
    ? await dialog.showMessageBox(activeOwner, options)
    : await dialog.showMessageBox(options);
  return response === 0 ? "confirm" : "cancel";
}

/** renderer 已销毁、尚未就绪或导航失联时，退出确认才允许降级为原生兜底。 */
export function showNativeQuitFallback(
  owner: BrowserWindow | null,
): Promise<DesktopDialogResult> {
  return showMessageBoxFallback(owner, {
    type: "warning",
    title: "正在生成",
    message: "正在生成，退出将中断",
    detail: "退出应用会停止当前生成，尚未完成的内容可能无法保留。",
    buttons: ["退出应用", "继续生成"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
}

/** 暖纸启动壳也不可交互时，内容恢复才允许降级为原生兜底。 */
export function showNativeContentRecoveryFallback(
  owner: BrowserWindow | null,
): Promise<DesktopDialogResult> {
  return showMessageBoxFallback(owner, {
    type: "warning",
    title: "内容页加载失败",
    message: "青简当前无法加载内容页。",
    detail: "本地服务不可用或内容页加载失败。你可以重新尝试加载，或退出应用。",
    buttons: ["重试", "退出"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
}

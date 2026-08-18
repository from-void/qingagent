export interface FatalEarlyErrorDialog {
  showErrorBox(title: string, content: string): void;
}

/**
 * 仅限渲染层不可用的致命早期错误。常规确认、告知与恢复消息必须走
 * rendererDialogBroker，由产品内浮层呈现，禁止在这里增加原生消息框调用。
 */
export function showNativeFatalEarlyErrorFallback(
  nativeDialog: FatalEarlyErrorDialog,
  title: string,
  content: string,
): void {
  nativeDialog.showErrorBox(title, content);
}

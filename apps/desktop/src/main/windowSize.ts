export interface MainWindowSize {
  width: number;
  height: number;
}

const MAX_WINDOW_WIDTH = 1480;
// 文档页舒适宽度：左栏 440 + 左内边距 60 + 纸张 800 + 右内边距 80。
const COMFORTABLE_DOCUMENT_WIDTH = 1380;

export function computeMainWindowSize(
  workAreaWidth: number,
  workAreaHeight: number,
): MainWindowSize {
  const preferredWidth = Math.round(workAreaWidth * 0.9);
  const nearFullWidth = Math.min(
    COMFORTABLE_DOCUMENT_WIDTH,
    Math.round(workAreaWidth * 0.97),
  );

  return {
    width: Math.min(MAX_WINDOW_WIDTH, Math.max(preferredWidth, nearFullWidth)),
    height: Math.round(workAreaHeight * 0.92),
  };
}

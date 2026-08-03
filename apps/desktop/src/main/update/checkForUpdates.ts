export interface UpdateChecker {
  checkForUpdates(): Promise<unknown>;
}

type UpdateCheckResultLike = {
  downloadPromise?: unknown;
};

// electron-updater 的 checkForUpdates 外层 Promise 只覆盖“查到更新”为止；自动下载是
// 返回结果里的另一个 Promise。后者失败时依赖会先 emit("error")，再 reject downloadPromise。
// 两层都必须被消费，否则 app-update.yml ENOENT 等下载准备错误会逃到 unhandledRejection。
export async function checkForUpdatesAndWatchDownload(
  updater: UpdateChecker,
  onFailure: (error: unknown) => void,
): Promise<unknown> {
  // async 函数也把非标准假实现的同步 throw 收敛为调用方可 catch 的 rejection。
  const result = await updater.checkForUpdates();
  if (!result || typeof result !== "object") return result;

  const downloadPromise = (result as UpdateCheckResultLike).downloadPromise;
  if (
    !downloadPromise ||
    (typeof downloadPromise !== "object" && typeof downloadPromise !== "function") ||
    typeof (downloadPromise as PromiseLike<unknown>).then !== "function"
  ) {
    return result;
  }

  void Promise.resolve(downloadPromise).catch((error) => {
    // 报告通道本身不能制造第二个浮动 rejection。
    try {
      onFailure(error);
    } catch {
      // console / 状态推送异常不应覆盖已经接住的 updater 失败。
    }
  });
  return result;
}

/**
 * 手动保存(updateDoc)失败的分类:决定是"瞬态网络抖动"(可静默重试、不该吓用户)
 * 还是"硬失败"(校验/冲突/服务端确认失败,该如实提示)。
 *
 * 背景:保存路径已是单飞 + 队列(同一时刻只有一条 updateDoc 在途,不会堆积连接)。
 * 用户实测的"保存请求失败:Failed to fetch"是 fetch 层瞬态失败(后端热重载/代理瞬断/
 * 浏览器网络抖动),请求多半没到服务端 → 用同一 expectedDocumentSnapshot 重试是安全的;
 * 且编辑器里内容仍在(下次编辑/离开页面都会再存),不该弹刺眼红错吓人。
 */
export type DocSaveErrorClass = "transient" | "fatal";

/**
 * fetch 在网络层失败时抛 TypeError，message 形如:
 * - Chrome: "Failed to fetch"
 * - Firefox: "NetworkError when attempting to fetch resource."
 * - Safari: "Load failed"
 * AbortError(请求被取消:会话停止/组件卸载/被取代)同样视作瞬态,不当硬失败。
 */
const TRANSIENT_MESSAGE_RE =
  /failed to fetch|networkerror|network error|load failed|fetch resource|connection|econnrefused|the operation was aborted/i;

export function classifyDocSaveError(error: unknown): DocSaveErrorClass {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "transient";
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "AbortError" || name === "TypeError") {
    // TypeError 几乎只可能是 fetch 网络层失败(JS 取值错误不会走到保存 catch)。
    if (name === "TypeError" && !TRANSIENT_MESSAGE_RE.test(message)) {
      // 保守:非网络字样的 TypeError 仍按瞬态处理(保存路径里 TypeError 来源单一),
      // 但若将来出现别的 TypeError,这里是收口点。
      return "transient";
    }
    return "transient";
  }
  if (TRANSIENT_MESSAGE_RE.test(message)) {
    return "transient";
  }
  return "fatal";
}

/** 瞬态保存失败、重试仍未成功时给用户的温和文案(不吓人,且说明数据没丢)。 */
export const TRANSIENT_DOC_SAVE_TOAST =
  "网络不稳,自动保存稍后重试——你的内容仍在,继续编辑或片刻后会自动重存。";

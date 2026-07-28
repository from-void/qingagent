export const CHUNK_RELOAD_KEY = "qj:chunk-reload-once";
export const CHUNK_RELOAD_PARAM = "qj_chunk_reload_once";

export interface PreloadRecoveryBrowser {
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly location: {
    readonly href: string;
    reload(): void;
  };
  readonly history: {
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
}

function currentUrl(browser: PreloadRecoveryBrowser): URL | null {
  try {
    return new URL(browser.location.href);
  } catch {
    return null;
  }
}

function hasReloadMarker(browser: PreloadRecoveryBrowser): boolean {
  try {
    if (browser.sessionStorage.getItem(CHUNK_RELOAD_KEY)) return true;
  } catch {
    // 受限存储环境继续检查 URL 标记。
  }
  return currentUrl(browser)?.searchParams.get(CHUNK_RELOAD_PARAM) === "1";
}

function markReload(browser: PreloadRecoveryBrowser): void {
  try {
    browser.sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    return;
  } catch {
    // URL 标记跨 reload 保留，避免受限存储环境反复刷新。
  }
  const url = currentUrl(browser);
  if (!url) return;
  url.searchParams.set(CHUNK_RELOAD_PARAM, "1");
  try {
    browser.history.replaceState(null, "", url);
  } catch {
    // 即使标记写入也受限，仍允许本次 reload 尝试自愈。
  }
}

export function createPreloadErrorHandler(
  browser: PreloadRecoveryBrowser,
): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    if (hasReloadMarker(browser)) return;
    markReload(browser);
    browser.location.reload();
  };
}

export function clearPreloadReloadMarker(browser: PreloadRecoveryBrowser): void {
  try {
    browser.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // sessionStorage 不可用时只清理 URL 标记。
  }
  const url = currentUrl(browser);
  if (!url || !url.searchParams.has(CHUNK_RELOAD_PARAM)) return;
  url.searchParams.delete(CHUNK_RELOAD_PARAM);
  try {
    browser.history.replaceState(null, "", url);
  } catch {
    // 清理失败不影响已挂载应用。
  }
}

import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_PARAM,
  clearPreloadReloadMarker,
  createPreloadErrorHandler,
  type PreloadRecoveryBrowser,
} from "./preloadRecovery";

function restrictedBrowser(url = "https://example.test/workspace?tab=review#note") {
  let currentUrl = url;
  const reload = vi.fn();
  const replaceState = vi.fn((_data: unknown, _unused: string, nextUrl?: string | URL | null) => {
    if (nextUrl) currentUrl = String(nextUrl);
  });
  const browser = {
    get sessionStorage(): Storage {
      throw new DOMException("Access is denied", "SecurityError");
    },
    get location() {
      return {
        get href() {
          return currentUrl;
        },
        reload,
      };
    },
    history: { replaceState },
  } as unknown as PreloadRecoveryBrowser;
  return { browser, reload, replaceState, url: () => currentUrl };
}

describe("preloadRecovery", () => {
  it("sessionStorage 受限时仍写入 URL 一次性标记并 reload", () => {
    const harness = restrictedBrowser();
    const preventDefault = vi.fn();
    const handler = createPreloadErrorHandler(harness.browser);

    handler({ preventDefault } as unknown as Event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.reload).toHaveBeenCalledOnce();
    const marked = new URL(harness.url());
    expect(marked.searchParams.get(CHUNK_RELOAD_PARAM)).toBe("1");
    expect(marked.searchParams.get("tab")).toBe("review");
    expect(marked.hash).toBe("#note");
  });

  it("URL 标记阻止受限存储环境重复 reload，并在稳定后清理", () => {
    const harness = restrictedBrowser(
      `https://example.test/workspace?${CHUNK_RELOAD_PARAM}=1&tab=review#note`,
    );
    const handler = createPreloadErrorHandler(harness.browser);

    handler({ preventDefault: vi.fn() } as unknown as Event);
    expect(harness.reload).not.toHaveBeenCalled();

    clearPreloadReloadMarker(harness.browser);
    const cleared = new URL(harness.url());
    expect(cleared.searchParams.has(CHUNK_RELOAD_PARAM)).toBe(false);
    expect(cleared.searchParams.get("tab")).toBe("review");
    expect(cleared.hash).toBe("#note");
  });

  it("存储可用时沿用 sessionStorage 标记且不改 URL", () => {
    const storage = new Map<string, string>();
    const replaceState = vi.fn();
    const reload = vi.fn();
    const browser = {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      location: { href: "https://example.test/", reload },
      history: { replaceState },
    } as unknown as PreloadRecoveryBrowser;

    createPreloadErrorHandler(browser)({ preventDefault: vi.fn() } as unknown as Event);
    expect(storage.get(CHUNK_RELOAD_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledOnce();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

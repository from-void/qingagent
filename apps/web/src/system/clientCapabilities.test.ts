import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveFolderCapabilityFromEnv } from "./FolderSourceControl";
import { fetchClientCapabilities } from "./clientCapabilities";

describe("client folder capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("浏览器 API 可用但 server browser folder 关闭时仍 disabled", () => {
    const capability = deriveFolderCapabilityFromEnv({
      isDesktop: false,
      hasDirectoryPicker: true,
      isSecureContext: true,
      userAgent: "Desktop Browser",
      maxTouchPoints: 0,
      serverBrowserFolderSourcesEnabled: false,
    });

    expect(capability.enabled).toBe(false);
    expect(capability.reason).toContain("服务端未启用");
  });

  it("server browser folder 开启且浏览器 API 可用时 enabled", () => {
    const capability = deriveFolderCapabilityFromEnv({
      isDesktop: false,
      hasDirectoryPicker: true,
      isSecureContext: true,
      userAgent: "Desktop Browser",
      maxTouchPoints: 0,
      serverBrowserFolderSourcesEnabled: true,
    });

    expect(capability).toEqual({ enabled: true, reason: null });
  });

  it("fetchClientCapabilities 读取 server 通告而不是本地重推导", async () => {
    const body = {
      folderSources: {
        desktopLocal: { enabled: false },
        browserFsAccess: { enabled: true },
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchClientCapabilities()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities", { signal: undefined });
  });
});

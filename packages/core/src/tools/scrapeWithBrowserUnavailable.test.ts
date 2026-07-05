import { afterEach, describe, expect, it, vi } from "vitest";

const mockBrowserDeps = vi.hoisted(() => ({
  getBrowser: vi.fn(),
}));

vi.mock("../browser/pool.js", () => ({
  getBrowser: mockBrowserDeps.getBrowser,
}));

import { scrapeWithBrowserTool } from "./scrapeWithBrowser.js";

describe("scrapeWithBrowser 浏览器启动失败降级", () => {
  afterEach(() => {
    mockBrowserDeps.getBrowser.mockReset();
  });

  it("getBrowser 抛 Executable doesn't exist 时返回 ok:false 和安装指引", async () => {
    mockBrowserDeps.getBrowser.mockRejectedValueOnce(
      new Error(
        "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
      ),
    );

    const result = await scrapeWithBrowserTool.execute!(
      { url: "http://1.1.1.1/" },
      {} as never,
    ) as {
      ok: boolean;
      error: string | null;
      text: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("未安装 Playwright 浏览器");
    expect(result.error).toContain("npx playwright install chromium");
    expect(result.text).toContain("未安装 Playwright 浏览器");
  });
});

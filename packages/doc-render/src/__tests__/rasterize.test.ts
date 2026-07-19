import { beforeEach, describe, expect, it, vi } from "vitest";

const poolMocks = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  withBrowserContextSlot: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

vi.mock("../browser/pool.js", () => poolMocks);

import { rasterizeSvgToPng } from "../export/rasterize.js";

describe("rasterizeSvgToPng", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("允许 250KB 合法 SVG 通过导出净化并栅格化为 PNG", async () => {
    const screenshot = Uint8Array.from([137, 80, 78, 71]);
    const element = {
      boundingBox: vi.fn().mockResolvedValue({ width: 800, height: 450 }),
      screenshot: vi.fn().mockResolvedValue(screenshot),
    };
    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      $: vi.fn().mockResolvedValue(element),
    };
    const context = {
      route: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    poolMocks.getBrowser.mockResolvedValue({ newContext: vi.fn().mockResolvedValue(context) });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><text>${"a".repeat(250_000)}</text></svg>`;

    const result = await rasterizeSvgToPng(svg);

    expect(result).toEqual({ data: Buffer.from(screenshot), width: 800, height: 450 });
    expect(page.setContent).toHaveBeenCalledWith(expect.stringContaining("<svg"), expect.any(Object));
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

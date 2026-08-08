import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDeadlineExceededError } from "./exportSlot.js";

const getBrowserMock = vi.hoisted(() => vi.fn());
vi.mock("../browser/pool.js", () => ({
  BrowserCapabilityUnavailableError: class extends Error {},
  getBrowser: getBrowserMock,
  getBrowserCapabilityState: () => ({ status: "available" }),
  withBrowserContextSlot: async (run: () => Promise<unknown>) => run(),
}));

import { htmlToPdf } from "./htmlToPdf.js";

describe("htmlToPdf deadline", () => {
  beforeEach(() => getBrowserMock.mockReset());

  it("page.pdf 超过端到端总时限时关闭 context 并拒绝", async () => {
    let rejectPdf: ((reason?: unknown) => void) | undefined;
    const close = vi.fn(async () => {
      rejectPdf?.(new Error("context closed"));
    });
    getBrowserMock.mockResolvedValue({
      newContext: async () => ({
        route: vi.fn(),
        newPage: async () => ({
          setContent: vi.fn(),
          evaluate: vi.fn(async () => undefined),
          pdf: vi.fn(() => new Promise<Uint8Array>((_resolve, reject) => {
            rejectPdf = reject;
          })),
        }),
        close,
      }),
    });

    await expect(
      htmlToPdf("<html><body>deadline</body></html>", { executionTimeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ExportDeadlineExceededError);
    expect(close).toHaveBeenCalled();
  });
});

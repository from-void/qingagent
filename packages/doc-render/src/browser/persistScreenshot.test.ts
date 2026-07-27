import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

import { persistScreenshot } from "./persistScreenshot.js";

describe("persistScreenshot 取消收尾", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("目录创建后收到取消会跳过写入并清理本次目录", async () => {
    const controller = new AbortController();
    fsMocks.mkdir.mockImplementationOnce(async () => {
      controller.abort(new DOMException("用户取消", "AbortError"));
    });
    fsMocks.rm.mockResolvedValueOnce(undefined);

    await expect(
      persistScreenshot(Buffer.from("image"), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.rm).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
      force: true,
    });
  });

  it("普通写盘失败也会清理本次目录和残留文件", async () => {
    fsMocks.mkdir.mockResolvedValueOnce(undefined);
    fsMocks.writeFile.mockRejectedValueOnce(new Error("ENOSPC"));
    fsMocks.rm.mockResolvedValueOnce(undefined);

    await expect(persistScreenshot(Buffer.from("image"))).rejects.toThrow("ENOSPC");

    expect(fsMocks.rm).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
      force: true,
    });
  });
});

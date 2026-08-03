import { describe, expect, it, vi } from "vitest";
import { exportDerivativeImage } from "./DerivativeView";
import { ImageExportError } from "./exportElementAsPng";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("衍生稿图片导出反馈", () => {
  it("落盘 Promise 未完成时不 toast，成功后提示完整路径", async () => {
    const saved = createDeferred<{ path: string | null }>();
    const exporter = vi.fn(() => saved.promise);
    const onToast = vi.fn();
    const target = document.createElement("article");

    const pending = exportDerivativeImage(
      target,
      "公众号稿-测试标题",
      onToast,
      exporter,
    );

    expect(exporter).toHaveBeenCalledWith(target, "公众号稿-测试标题");
    expect(onToast).not.toHaveBeenCalled();

    saved.resolve({
      path: "C:\\Users\\tester\\Downloads\\公众号稿-测试标题.png",
    });
    await pending;

    expect(onToast).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith(
      "图片已导出：C:\\Users\\tester\\Downloads\\公众号稿-测试标题.png",
    );
  });

  it("落盘失败只提示人话错误，不出现成功 toast", async () => {
    const exporter = vi.fn(async () => {
      throw new ImageExportError("图片未保存，请重试");
    });
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await exportDerivativeImage(
      document.createElement("section"),
      "小红书稿-封面",
      onToast,
      exporter,
    );

    expect(onToast).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith("图片未保存，请重试");
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("已导出"));
    consoleError.mockRestore();
  });

  it("Web 端只确认浏览器下载已开始，不宣称已经落盘", async () => {
    const onToast = vi.fn();

    await exportDerivativeImage(
      document.createElement("article"),
      "公众号稿-Web",
      onToast,
      vi.fn(async () => ({ path: null })),
    );

    expect(onToast).toHaveBeenCalledWith("图片已开始下载");
  });

  it("未知内部错误只显示统一中文提示，不泄露原始错误详情", async () => {
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await exportDerivativeImage(
      document.createElement("article"),
      "公众号稿-异常",
      onToast,
      vi.fn(async () => {
        throw new Error("raw disk path and internal stack");
      }),
    );

    expect(onToast).toHaveBeenCalledWith("图片导出失败，请重试");
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("raw disk path"));
    consoleError.mockRestore();
  });
});

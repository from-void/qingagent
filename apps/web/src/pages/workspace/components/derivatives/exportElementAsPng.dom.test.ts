import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportElementAsPng,
  measureExportLayoutBounds,
  serializeElementAsSelfContainedSvg,
} from "./exportElementAsPng";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type ImageSaveResult =
  | {
      saved: true;
      filename: string;
      path: string;
      revealToken: string;
    }
  | {
      saved: false;
      filename: string;
      reason: "write-failed";
    };

function mockBox(
  element: HTMLElement,
  layout: { height: number; width: number },
  visual: { height: number; width: number },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: layout.height },
    clientWidth: { configurable: true, value: layout.width },
    offsetHeight: { configurable: true, value: layout.height },
    offsetWidth: { configurable: true, value: layout.width },
    scrollHeight: { configurable: true, value: layout.height },
    scrollWidth: { configurable: true, value: layout.width },
  });
  element.getBoundingClientRect = () => ({
    bottom: visual.height,
    height: visual.height,
    left: 0,
    right: visual.width,
    top: 0,
    width: visual.width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function px(value: string | null | undefined): number {
  return Number.parseFloat(value ?? "0");
}

function installRasterMocks(): void {
  class LoadedImage {
    decoding = "auto";
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    scale: vi.fn(),
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    callback({
      arrayBuffer: async () => bytes.buffer,
      type: "image/png",
    } as Blob);
  });
}

describe("衍生稿 PNG 导出布局", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: undefined,
    });
  });

  it("桌面端等主进程落盘成功后才允许成功 toast，并返回完整路径", async () => {
    installRasterMocks();
    const saveFinished = createDeferred<ImageSaveResult>();
    const saveExportDownload = vi.fn(() => saveFinished.promise);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { isDesktop: true, saveExportDownload },
    });
    const createObjectURL = vi.fn(() => "blob:should-not-be-used");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    const target = document.createElement("article");
    target.textContent = "公众号图片导出";
    document.body.append(target);
    mockBox(target, { width: 320, height: 240 }, { width: 320, height: 240 });
    const onToast = vi.fn();

    const pending = exportElementAsPng(target, "公众号稿-测试标题")
      .then((result) => onToast(
        `图片已导出：${(result as unknown as { path: string }).path}`,
      ))
      .catch(() => onToast("图片未保存，请重试"));

    await vi.waitFor(() => expect(saveExportDownload).toHaveBeenCalledTimes(1));
    expect(onToast).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(saveExportDownload).toHaveBeenCalledWith({
      filename: "公众号稿-测试标题.png",
      format: "png",
      bytes: expect.any(Uint8Array),
    });

    saveFinished.resolve({
      saved: true,
      filename: "公众号稿-测试标题.png",
      path: "C:\\Users\\tester\\Downloads\\公众号稿-测试标题.png",
      revealToken: "reveal-image",
    });
    await pending;

    expect(onToast).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith(
      "图片已导出：C:\\Users\\tester\\Downloads\\公众号稿-测试标题.png",
    );
  });

  it("桌面端落盘失败只给中文失败 toast，绝不误报图片已导出", async () => {
    installRasterMocks();
    const saveFinished = createDeferred<ImageSaveResult>();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        isDesktop: true,
        saveExportDownload: vi.fn(() => saveFinished.promise),
      },
    });
    const target = document.createElement("section");
    target.textContent = "小红书封面导出";
    document.body.append(target);
    mockBox(target, { width: 343, height: 457 }, { width: 343, height: 457 });
    const onToast = vi.fn();

    const pending = exportElementAsPng(target, "小红书稿-封面")
      .then((result) => onToast(
        `图片已导出：${(result as unknown as { path: string }).path}`,
      ))
      .catch(() => onToast("图片未保存，请重试"));

    await vi.waitFor(() => {
      expect(window.electron?.saveExportDownload).toHaveBeenCalledTimes(1);
    });
    expect(onToast).not.toHaveBeenCalled();

    saveFinished.resolve({
      saved: false,
      filename: "小红书稿-封面.png",
      reason: "write-failed",
    });
    await pending;

    expect(onToast).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith("图片未保存，请重试");
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("已导出"));
  });

  it("图片渲染静默不返回时按阶段超时，且不会进入主进程落盘", async () => {
    const fontsReady = createDeferred<void>();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: fontsReady.promise },
    });
    const saveExportDownload = vi.fn();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { isDesktop: true, saveExportDownload },
    });
    const target = document.createElement("article");
    document.body.append(target);
    mockBox(target, { width: 320, height: 240 }, { width: 320, height: 240 });

    await expect(exportElementAsPng(target, "渲染超时", { renderTimeoutMs: 10 }))
      .rejects.toThrow("图片渲染超时，请重试");
    expect(saveExportDownload).not.toHaveBeenCalled();

    fontsReady.resolve();
    await fontsReady.promise;
  });

  it("正文图片仅在单次导出内去重，导出结束后不跨文档常驻", async () => {
    const article = document.createElement("article");
    const first = document.createElement("img");
    const second = document.createElement("img");
    first.src = "/uploads/document-image.png";
    second.src = "/uploads/document-image.png";
    article.append(first, second);
    document.body.append(article);
    mockBox(article, { width: 320, height: 240 }, { width: 320, height: 240 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await serializeElementAsSelfContainedSvg(article);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await serializeElementAsSelfContainedSvg(article);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("祖先缩放时使用缩放前布局边界，长标题和页脚都在导出可视区内", async () => {
    const cover = document.createElement("section");
    cover.style.cssText = [
      "box-sizing:border-box",
      "position:relative",
      "width:343px",
      "height:457px",
      "overflow:hidden",
      "background:#f7f3ea",
    ].join(";");
    const title = document.createElement("strong");
    title.textContent = "下班后别瘫着了！夜跑真的能重置心情";
    title.style.cssText = "position:absolute;left:31px;top:119px;width:281px;height:160px";
    const footer = document.createElement("span");
    footer.className = "xhs-cover-footer";
    footer.textContent = "·青简·";
    footer.style.cssText = "position:absolute;left:139px;top:420px;width:65px;height:18px";
    cover.append(title, footer);
    document.body.append(cover);
    // R32 现场：343×457 的布局盒被 PhoneShell 缩放成约 254×339。
    mockBox(cover, { width: 343, height: 457 }, { width: 253.681, height: 338.241 });

    expect(measureExportLayoutBounds(cover)).toMatchObject({
      width: 343,
      height: 457,
      visualWidth: 253.681,
      visualHeight: 338.241,
    });

    const serialized = await serializeElementAsSelfContainedSvg(cover);
    const xml = new DOMParser().parseFromString(serialized.svg, "image/svg+xml");
    const exportedTitle = xml.querySelector("strong") as HTMLElement | null;
    const exportedFooter = xml.querySelector(".xhs-cover-footer") as HTMLElement | null;

    expect(serialized).toMatchObject({ width: 343, height: 457 });
    expect(serialized.svg).toContain('width="343" height="457"');
    expect(exportedTitle?.textContent).toBe("下班后别瘫着了！夜跑真的能重置心情");
    expect(px(exportedTitle?.style.left) + px(exportedTitle?.style.width)).toBeLessThanOrEqual(serialized.width);
    expect(exportedFooter?.textContent).toBe("·青简·");
    expect(px(exportedFooter?.style.top) + px(exportedFooter?.style.height)).toBeLessThanOrEqual(serialized.height);
  });
});

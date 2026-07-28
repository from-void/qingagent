import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureExportLayoutBounds,
  serializeElementAsSelfContainedSvg,
} from "./exportElementAsPng";

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

describe("衍生稿 PNG 导出布局", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
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

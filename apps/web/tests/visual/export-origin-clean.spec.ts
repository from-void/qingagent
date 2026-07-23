import { expect, test } from "@playwright/test";

test("衍生稿封面导出画布保持 origin-clean", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const loadModule = new Function(
      "return import('/src/pages/workspace/components/derivatives/exportElementAsPng.ts')",
    ) as () => Promise<typeof import("../../src/pages/workspace/components/derivatives/exportElementAsPng")>;
    const {
      externalSvgResourceReferences,
      renderElementToOriginCleanCanvas,
      serializeElementAsSelfContainedSvg,
    } = await loadModule();
    const cases = [
      { family: "Qing Smiley Sans", weight: 700 },
      { family: "Qing LXGW WenKai", weight: 400 },
    ];
    const results = [];
    for (const font of cases) {
      const cover = document.createElement("section");
      cover.style.cssText = [
        "box-sizing:border-box",
        "width:420px",
        "height:560px",
        "padding:48px",
        "background:#ff6b35",
        "color:#fff",
        `font:${font.weight} 58px/1.05 "${font.family}",sans-serif`,
      ].join(";");
      cover.textContent = "城市阳台种菜";
      document.body.append(cover);
      try {
        const serialized = await serializeElementAsSelfContainedSvg(cover);
        const canvas = await renderElementToOriginCleanCanvas(cover);
        const pixel = Array.from(canvas.getContext("2d")!.getImageData(20, 20, 1, 1).data);
        const png = canvas.toDataURL("image/png");
        results.push({
          externalResources: externalSvgResourceReferences(serialized.svg),
          family: font.family,
          fontInlined: serialized.svg.includes(`font-family:"${font.family}";src:url("data:font/woff2;base64,`),
          pixel,
          pngPrefix: png.slice(0, 22),
          svgUsesDataUrl: serialized.dataUrl.startsWith("data:image/svg+xml;charset=utf-8,%3C"),
        });
      } finally {
        cover.remove();
      }
    }
    return results;
  });

  expect(result.map((item) => item.family)).toEqual(["Qing Smiley Sans", "Qing LXGW WenKai"]);
  for (const item of result) {
    expect(item.svgUsesDataUrl).toBe(true);
    expect(item.externalResources).toEqual([]);
    expect(item.fontInlined).toBe(true);
    expect(item.pixel[3]).toBe(255);
    expect(item.pngPrefix).toBe("data:image/png;base64,");
  }
});

test("缩放预览中的五款封面按原布局尺寸导出，长标题与页脚不裁切", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const loadStyles = new Function(
      "return import('/src/pages/workspace/components/derivatives/dtypeRegistry.tsx')",
    ) as () => Promise<unknown>;
    const loadExporter = new Function(
      "return import('/src/pages/workspace/components/derivatives/exportElementAsPng.ts')",
    ) as () => Promise<typeof import("../../src/pages/workspace/components/derivatives/exportElementAsPng")>;
    await loadStyles();
    const { serializeElementAsSelfContainedSvg } = await loadExporter();
    const templates = ["poster", "magazine", "wenkai", "impact", "note"] as const;
    const titles = ["夜跑重启心情", "下班后别瘫着了！夜跑真的能重置心情"];
    const results = [];

    for (const template of templates) {
      for (const title of titles) {
        const scaledPreview = document.createElement("div");
        scaledPreview.className = "xhs-phone-content";
        scaledPreview.style.cssText = "position:fixed;left:0;top:0;width:343px;transform:scale(.74);transform-origin:top left";
        const cover = document.createElement("div");
        cover.className = `xhs-cover xhs-cover--${template}${Array.from(title).length > 12 ? " is-long" : ""}`;
        cover.style.cssText = "width:343px;height:457px";
        if (template === "poster") {
          cover.innerHTML = `<span class="xhs-cover-kicker">青简笔记</span><strong><span>${title.slice(0, -4)}</span><mark>${title.slice(-4)}</mark></strong>`;
        } else if (template === "magazine") {
          cover.innerHTML = `<span class="xhs-cover-eyebrow">NOTES</span><strong>${title}</strong><i class="xhs-cover-rule"></i><span class="xhs-cover-footer">·青简·</span>`;
        } else if (template === "wenkai") {
          cover.innerHTML = `<i class="xhs-cover-boundary"></i><strong>${title}</strong><span class="xhs-cover-seal">记</span>`;
        } else if (template === "impact") {
          cover.innerHTML = `<span class="xhs-cover-number">01</span><strong>${title}<i aria-hidden="true"></i></strong>`;
        } else {
          cover.innerHTML = `<div class="xhs-cover-note"><i class="xhs-cover-tape"></i><strong>${title}</strong><span class="xhs-cover-lines" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
        }
        scaledPreview.append(cover);
        document.body.append(scaledPreview);
        const visualRect = cover.getBoundingClientRect();
        const serialized = await serializeElementAsSelfContainedSvg(cover);
        const parsed = new DOMParser().parseFromString(serialized.svg, "text/html");
        const exportContext = parsed.querySelector("foreignObject > div") as HTMLElement;
        const measurementHost = document.createElement("div");
        measurementHost.style.cssText = "position:fixed;left:-10000px;top:0";
        measurementHost.append(document.importNode(exportContext, true));
        document.body.append(measurementHost);
        const exportedCover = measurementHost.querySelector(".xhs-cover") as HTMLElement;
        const exportedTitle = exportedCover.querySelector("strong") as HTMLElement;
        const exportedFooter = exportedCover.querySelector(".xhs-cover-footer") as HTMLElement | null;
        const rootRect = exportedCover.getBoundingClientRect();
        const titleRect = exportedTitle.getBoundingClientRect();
        const footerRect = exportedFooter?.getBoundingClientRect();
        results.push({
          footerInside: !footerRect || footerRect.bottom <= rootRect.bottom + 1,
          hasFooter: template !== "magazine" || exportedFooter?.textContent === "·青简·",
          height: serialized.height,
          template,
          title,
          titleInside: titleRect.left >= rootRect.left - 1
            && titleRect.right <= rootRect.right + 1
            && titleRect.bottom <= rootRect.bottom + 1,
          visualHeight: visualRect.height,
          visualWidth: visualRect.width,
          width: serialized.width,
        });
        measurementHost.remove();
        scaledPreview.remove();
      }
    }
    return results;
  });

  expect(result).toHaveLength(10);
  for (const item of result) {
    expect(item.visualWidth).toBeCloseTo(343 * 0.74, 0);
    expect(item.visualHeight).toBeCloseTo(457 * 0.74, 0);
    expect(item.width).toBe(343);
    expect(item.height).toBe(457);
    expect(item.titleInside, `${item.template}: ${item.title}`).toBe(true);
    expect(item.hasFooter, `${item.template}: ${item.title}`).toBe(true);
    expect(item.footerInside, `${item.template}: ${item.title}`).toBe(true);
  }
});

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

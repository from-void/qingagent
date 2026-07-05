import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// boot 底色契约:首页固定浅色后,React 挂载前的 boot 壳层底色(index.html inline <style>+script、
// App.tsx Suspense 兜底)必须是首页浅色纸底,绝不能是旧版深色首页遗留的深底——否则懒加载大 chunk
// 下载期(VPS 慢网)露深底=生产"中间黑块"(daf414e 修)。这是跨副本契约:三处字面量易"改一漏二"。
// 真值 = #ece4d3(首页 body 暖纸稳态色 rgb(236,228,211)=--bg-window 运行时值,浏览器实测)。
// 注:主题暖化后旧冷灰 #e9eae6 与两侧暖底不匹配,首帧闪"暖两侧+冷中心",故 boot 兜底同步为暖值。

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../..");
const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
const appTsx = readFileSync(path.join(webRoot, "src/App.tsx"), "utf8");

const BOOT_LIGHT = "#ece4d3";
// 禁止:旧深色首页遗留的深底(亮度极低,出现即黑块回归)。
const FORBIDDEN_DARK = ["#14171a", "#0e1114", "#2a2620", "#000000", "#000 "];

describe("boot 底色契约(防黑块回归·跨副本一致)", () => {
  it("index.html 的 html 兜底底色 = 首页暖纸 #ece4d3", () => {
    expect(indexHtml).toContain("background: var(--app-boot-bg, #ece4d3)");
  });

  it("index.html inline script 把 --app-boot-bg 设成暖纸 #ece4d3(运行时分支)", () => {
    expect(indexHtml).toMatch(/var bg = "#ece4d3"/);
  });

  it("App.tsx Suspense 兜底底色 = #ece4d3(与 boot 同色,消除路由切换色阶)", () => {
    expect(appTsx).toContain("background: \"var(--app-boot-bg, #ece4d3)\"");
  });

  it("三处 boot 副本都不得出现旧版深色(黑块回归红线)", () => {
    for (const dark of FORBIDDEN_DARK) {
      // 注释里允许提及历史深色(说明用),只校验实际 CSS/JS 值行:
      const bootStyleLine = indexHtml
        .split("\n")
        .filter((l) => /background|var bg|--app-boot-bg/.test(l) && !l.trim().startsWith("//") && !l.includes("注:"))
        .join("\n");
      expect(bootStyleLine).not.toContain(dark);
      expect(appTsx).not.toContain(`var(--app-boot-bg, ${dark})`);
    }
  });

  it("boot 浅色亮度足够(L* 高,确保不是黑块)", () => {
    // #ece4d3 → sRGB(236,228,211),相对亮度应远高于深色阈值。
    const r = 0xec / 255, g = 0xe4 / 255, b = 0xd3 / 255;
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    expect(luminance).toBeGreaterThan(0.7); // 浅色;深底 #14171a 的 luminance ≈ 0.006
  });
});

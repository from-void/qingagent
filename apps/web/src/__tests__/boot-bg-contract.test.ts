import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// boot 底色契约分两层：React 挂载前的 index.html 继续用暖纸兜底；React 接管后的 Suspense
// 必须按目标路由匹配页面最底层颜色。页面 CSS 随 lazy chunk 才到，映射值需要与 CSS 副本同步。

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../..");
const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
const appTsx = readFileSync(path.join(webRoot, "src/App.tsx"), "utf8");
const appCss = readFileSync(path.join(webRoot, "src/app.css"), "utf8");
const desktopMain = readFileSync(path.join(webRoot, "../desktop/src/main/index.ts"), "utf8");
const homeCss = readFileSync(path.join(webRoot, "src/pages/home/components/qingjian.css"), "utf8");
const newSessionCss = readFileSync(path.join(webRoot, "src/pages/new-session/new-session-qing.css"), "utf8");
const workspaceCss = readFileSync(path.join(webRoot, "src/pages/workspace/workspace-ink-skin.css"), "utf8");

const BOOT_LIGHT = "#ece4d3";
// 禁止:旧深色首页遗留的深底(亮度极低,出现即黑块回归)。
const FORBIDDEN_DARK = ["#14171a", "#0e1114", "#2a2620", "#000000", "#000 "];

describe("boot 与切页底色契约", () => {
  it("index.html 的 html 兜底底色 = 首页暖纸 #ece4d3", () => {
    expect(indexHtml).toContain("background: var(--app-boot-bg, #ece4d3)");
  });

  it("index.html inline script 把 --app-boot-bg 设成暖纸 #ece4d3(运行时分支)", () => {
    expect(indexHtml).toMatch(/var bg = "#ece4d3"/);
  });

  it("桌面原生底色与自包含启动壳复用同一暖纸 boot 契约", () => {
    const shellHtml = desktopMain.match(/const STARTUP_SHELL_HTML = `([\s\S]*?)`;/)?.[1] ?? "";
    expect(desktopMain).toContain('backgroundColor: "#ece4d3"');
    expect(shellHtml).toMatch(/background:\s*#ece4d3/);
    expect(shellHtml).toMatch(/color:\s*#2f2a22/);
    expect(shellHtml).not.toContain("#1a1a1a");
  });

  it("Suspense 按 home/new-session/workspace 的真实底色映射", () => {
    expect(appTsx).toContain('home: { pageFrameModifier: "web-page-frame--qingjian-home", suspenseBackground: "#1c1915" }');
    expect(appTsx).toContain('"new-session": { suspenseBackground: "#16212c" }');
    expect(appTsx).toContain('workspace: { pageFrameModifier: "web-page-frame--workspace", suspenseBackground: "#16212c" }');
    expect(appTsx).toContain("background: suspenseBackground");
  });

  it("路由映射值与对应页面 CSS 的底层色一致", () => {
    expect(homeCss).toMatch(/#view-home\.home-qingjian\s*\{[^}]*background:\s*#1c1915/s);
    expect(appCss).toContain("--desk-base: #16212c");
    expect(newSessionCss).toMatch(/\.ccx-space\s*\{[^}]*background-color:\s*var\(--desk-base\)/s);
    expect(workspaceCss).toMatch(/#view-workspace\s*\{[^}]*background-color:\s*var\(--desk-base\)/s);
  });

  it("React 挂载前的 index.html 不得回退到旧版深色", () => {
    for (const dark of FORBIDDEN_DARK) {
      // 注释里允许提及历史深色(说明用),只校验实际 CSS/JS 值行:
      const bootStyleLine = indexHtml
        .split("\n")
        .filter((l) => /background|var bg|--app-boot-bg/.test(l) && !l.trim().startsWith("//") && !l.includes("注:"))
        .join("\n");
      expect(bootStyleLine).not.toContain(dark);
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

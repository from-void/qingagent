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
const viteConfig = readFileSync(path.join(webRoot, "vite.config.ts"), "utf8");
const appCss = readFileSync(path.join(webRoot, "src/app.css"), "utf8");
const desktopMain = readFileSync(path.join(webRoot, "../desktop/src/main/index.ts"), "utf8");
const homeCss = readFileSync(path.join(webRoot, "src/pages/home/components/qingjian.css"), "utf8");
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

  it("Suspense 按 home/workspace 的真实底色映射", () => {
    expect(appTsx).toContain('home: { pageFrameModifier: "web-page-frame--qingjian-home", suspenseBackground: "#1c1915" }');
    expect(appTsx).toContain('workspace: { pageFrameModifier: "web-page-frame--workspace", suspenseBackground: "#16212c" }');
    expect(appTsx).toContain("background: suspenseBackground");
  });

  it("路由映射值与对应页面 CSS 的底层色一致", () => {
    expect(homeCss).toMatch(/#view-home\.home-qingjian\s*\{[^}]*background:\s*#1c1915/s);
    expect(appCss).toContain("--desk-base: #16212c");
    expect(workspaceCss).toMatch(/#view-workspace\s*\{[^}]*background-color:\s*var\(--desk-base\)/s);
  });

  it("路由工厂必须 onceAsync 记忆化:预热与 lazy 共用同一次 __vitePreload(治「无样式裸 DOM」)", () => {
    // 主防线。每次调用路由工厂都会走一遍 Vite 的 __vitePreload,而它用模块级 seen 表去重 ——
    // 只有第一次碰到某个 CSS 才返回「等 link load」的 promise。预热调一次(等待被 void 掉)、
    // 切页时 lazy 再调一次,第二次就 seen 命中直接短路,不等 CSS 就交出 chunk → 组件先挂载、
    // 样式后到,那几百毫秒是完全无样式的裸 DOM。记忆化后只有一次调用,它会老实等 CSS。
    // 谁把 onceAsync 摘掉(退回每次新建 promise),那类闪烁立刻回归。
    expect(appTsx).toContain('import { onceAsync } from "./system/onceAsync"');
    for (const factory of [
      'onceAsync(() => import("./pages/home/HomePage").then(styled))',
      'import("./pages/workspace/WorkspacePage").then(styled),',
    ]) {
      expect(appTsx).toContain(factory);
    }
    // 两个生产页面工厂都得包上,别漏
    expect(appTsx.match(/onceAsync\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("CSS 保持按页分割:首屏不该被全站样式拖重", () => {
    // 无样式裸 DOM 由 onceAsync 治(见上),不需要牺牲首屏把全站 CSS 变成渲染阻塞单文件。
    expect(viteConfig).not.toMatch(/cssCodeSplit:\s*false/);
  });

  it("样式表就绪等待作为第二道保留(兜 seen 已被别处污染的边缘情况)", () => {
    // 零成本:没有 pending 样式表就立即 resolve。但它的等待必须带超时(网络异常不能卡死导航),
    // 所以一超时裸 DOM 照旧 —— 只能当第二道,主防线是上面的 onceAsync。
    expect(appTsx).toContain("awaitPendingStylesheets(PAGE_STYLE_TIMEOUT_MS)");
  });

  it("主包给编辑页兜底玄青底 + 页框满铺(样式表等待超时后的最后一道)", () => {
    // 兜底必须留在主包 app.css:上面的等待有超时(网络挂了不能卡死导航),超时放行后
    // 若 app.css 仍铺亮色 --bg-canvas、页框仍受 1440 限宽,就会露亮底 + 两侧暖纸边。
    // Suspense 兜底那一屏也靠这两条才能铺满(否则纯色块只有 1440 宽)。
    expect(appCss).toMatch(/#view-workspace\s*\{[^}]*background:\s*var\(--desk-base\)/s);
    expect(appCss).not.toMatch(/#view-workspace\s*\{[^}]*background:\s*var\(--bg-canvas\)/s);
    expect(appCss).toMatch(
      /\.web-page-frame--workspace\s*\{[^}]*width:\s*100%;[^}]*background:\s*var\(--desk-base\)/s,
    );
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

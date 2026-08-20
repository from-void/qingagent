import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/pages/home/components/qingjian.css"),
  "utf8",
);
const scrollSource = readFileSync(
  resolve(process.cwd(), "src/pages/home/components/QingjianScroll.tsx"),
  "utf8",
);
const iconSource = readFileSync(resolve(process.cwd(), "src/system/icons.tsx"), "utf8");
const uikitSource = readFileSync(
  resolve(process.cwd(), "src/pages/uikit/UIKitPage.tsx"),
  "utf8",
);

function cssBlock(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedSelector}\\s*\\{`, "m").exec(css);
  const start = match?.index ?? -1;
  if (start < 0) throw new Error(`CSS selector not found: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

describe("QingjianScroll 三枚图标按钮契约", () => {
  it("生产入口与 UIKit 样张共用基类和 18 / 1.8 的同款图标", () => {
    expect(scrollSource).toContain('className={`qj-icon-btn qj-settings-btn${');
    expect(scrollSource).toContain('className={`qj-icon-btn qj-dock-search-btn${');
    expect(scrollSource).toContain('className="qj-icon-btn qj-new-fab"');
    expect(scrollSource).toContain("<SettingsIcon size={18} />");
    expect(scrollSource).toContain("<SearchIcon size={18} />");

    expect(iconSource).toMatch(
      /export function SettingsIcon[\s\S]*?<IconSvg size=\{size\} className=\{className\} strokeWidth=\{1\.8\}>/,
    );

    expect(uikitSource).toContain('className="qj-icon-btn qj-settings-btn"');
    expect(uikitSource).toContain('className="qj-icon-btn qj-settings-btn qj-on"');
    expect(uikitSource).toContain('className="qj-icon-btn qj-new-fab qj-show"');
    expect(uikitSource).toContain('className="qj-icon-btn qj-dock-search-btn qj-on"');
    expect(uikitSource).toContain("<SettingsIcon size={18} />");
    expect(uikitSource).toContain("<PlusIcon size={18} />");
    expect(uikitSource).toContain("<SearchIcon size={18} />");
  });

  it("基类统一方角、表面、反馈与 0.22s 节奏", () => {
    const base = cssBlock(".qj-icon-btn");
    expect(base).toMatch(/border-radius:\s*0;/);
    expect(base).toMatch(/cursor:\s*pointer;/);
    expect(base).toMatch(/display:\s*flex;/);
    expect(base).toMatch(/align-items:\s*center;/);
    expect(base).toMatch(/justify-content:\s*center;/);
    expect(base).toMatch(/border:\s*1px solid var\(--qj-switch-border\);/);
    expect(base).toMatch(/background:\s*var\(--qj-switch-bg\);/);
    expect(base).toMatch(/color:\s*var\(--qj-switch-text\);/);
    expect(base).toMatch(/outline:\s*none;/);
    expect(base).toMatch(
      /transition:\s*border-color 0\.22s, background 0\.22s, transform 0\.22s;/,
    );

    expect(css).toMatch(
      /\.qj-icon-btn:hover,\s*\.qj-icon-btn:focus-visible\s*\{[^}]*transform:\s*translateY\(-1px\);[^}]*border-color:\s*var\(--qj-cinnabar\);[^}]*background:\s*var\(--qj-switch-active-bg\);/s,
    );
    expect(css).toMatch(
      /\.qj-icon-btn\.qj-on\s*\{[^}]*border-color:\s*var\(--qj-cinnabar\);[^}]*background:\s*var\(--qj-switch-active-bg\);/s,
    );
  });

  it("保持 42 / 42 / 34 尺寸和 dock 无独立阴影的语境差异", () => {
    const settings = cssBlock(".qj-settings-btn");
    const fab = cssBlock(".qj-new-fab");
    const search = cssBlock(".qj-dock-search-btn");

    expect(settings).toMatch(/width:\s*42px;/);
    expect(settings).toMatch(/height:\s*42px;/);
    expect(settings).toMatch(/box-shadow:\s*0 10px 26px rgba\(0, 0, 0, 0\.22\);/);
    expect(fab).toMatch(/width:\s*42px;/);
    expect(fab).toMatch(/height:\s*42px;/);
    expect(fab).toMatch(/box-shadow:\s*0 10px 26px rgba\(0, 0, 0, 0\.22\);/);
    expect(search).toMatch(/width:\s*34px;/);
    expect(search).toMatch(/height:\s*34px;/);
    expect(search).not.toContain("box-shadow");
  });

  it("FAB 进出场保持 0.42s 缓动，只有 hover / focus 抬升改走短过渡", () => {
    expect(cssBlock(".qj-new-fab")).toMatch(
      /transition:\s*transform 0\.42s cubic-bezier\(0\.2, 0\.8, 0\.2, 1\), opacity 0\.42s ease,/,
    );
    expect(cssBlock(".qj-new-fab.qj-show")).toMatch(
      /transition:\s*transform 0\.42s cubic-bezier\(0\.2, 0\.8, 0\.2, 1\), opacity 0\.42s ease,/,
    );
    expect(css).toMatch(
      /\.qj-new-fab\.qj-show:hover,\s*\.qj-new-fab\.qj-show:focus-visible\s*\{[^}]*transform:\s*translateY\(-1px\);[^}]*transition:\s*border-color 0\.22s, background 0\.22s, transform 0\.22s;/s,
    );
  });
});

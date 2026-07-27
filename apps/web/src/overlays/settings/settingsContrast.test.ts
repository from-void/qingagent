import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/overlays/settings/settings.css"),
  "utf8",
);

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  return hexToRgb(hex)
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("设置面板说明文字对比度契约", () => {
  it("代表性说明元素遵循各自层级并统一使用通过 AA 的 --ink-desc", () => {
    const selectors = [
      ".security-description",
      ".qj-sheet-body .sk-card-desc",
      ".settings-feedback .fb-desc",
      ".settings-search .ss-meta",
      ".settings-about .ab-intro",
      ".cnd-note",
    ];

    for (const selector of selectors) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = css.match(new RegExp(`${escaped}\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule, selector).toContain("color:var(--ink-desc)");
      if (selector !== ".security-description") {
        expect(Number(rule.match(/font-size:([\d.]+)px/)?.[1]), selector)
          .toBeGreaterThanOrEqual(13);
      }
      expect(rule, selector).not.toMatch(/opacity:/);
    }
  });

  it("--ink-desc 在墨迹背景最浅色上仍达到 WCAG AA", () => {
    const inkDesc = css.match(/--ink-desc:(#[0-9a-f]{6})/i)?.[1];
    expect(inkDesc).toBeDefined();

    // SettingsInkBackdrop 的墨色范围为 #080706～#332b25；最浅端对比最低。
    expect(contrastRatio(inkDesc!, "#332b25")).toBeGreaterThanOrEqual(4.5);
  });
});

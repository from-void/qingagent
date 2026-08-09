import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/pages/home/components/qingjian.css"),
  "utf8",
);

describe("QingjianScroll opening pointer contract", () => {
  it("keeps the opening FAB hidden until the new-document card leaves view", () => {
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-scroll\s*\{[^}]*pointer-events:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-roller\s*\{[^}]*pointer-events:\s*none;/s,
    );
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-new-fab\s*\{[^}]*pointer-events:\s*none;/s,
    );
    // 只有新建卡离开视野、组件加上 qj-show 后，浮钮才恢复命中并参与开卷渐入。
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-new-fab\.qj-show\s*\{[^}]*pointer-events:\s*auto;[^}]*animation:\s*qj-opening-ui-fade/s,
    );
    expect(css).toContain("@keyframes qj-opening-real-unroll");
    expect(css).toContain("@keyframes qj-opening-real-roller");
  });
});

describe("QingjianScroll 卡片键盘焦点", () => {
  it("为卡槽提供清晰的 focus-visible 轮廓与卡片反馈", () => {
    expect(css).toMatch(
      /\.qj-card-slot:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--qj-cinnabar\);[^}]*outline-offset:\s*6px;/s,
    );
    expect(css).toMatch(
      /\.qj-card-slot:focus-visible \.cm-card\s*\{[^}]*transform:\s*translateY\(-7px\) scale\(1\.02\);/s,
    );
  });
});

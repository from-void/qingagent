import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/pages/home/components/qingjian.css"),
  "utf8",
);

describe("QingjianScroll opening pointer contract", () => {
  it("keeps the opening animation while allowing new-document clicks through", () => {
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-scroll\s*\{[^}]*pointer-events:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-roller\s*\{[^}]*pointer-events:\s*none;/s,
    );
    expect(css).toMatch(
      /\.qj-root\.qj-opening \.qj-new-fab\s*\{[^}]*pointer-events:\s*auto;[^}]*animation:\s*qj-opening-ui-fade/s,
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

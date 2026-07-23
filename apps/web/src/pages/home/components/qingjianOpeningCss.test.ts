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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/pages/home/components/qingjian.css"),
  "utf8",
);

const cardTransitionTargets = [
  ".cm-image",
  ".cm-line",
  ".cm-card-color-overlay",
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectTransitionDisabled(selector: string, source: string) {
  expect(source).toMatch(
    new RegExp(
      `${escapeRegExp(selector)}[^{}]*\\{[^}]*transition:\\s*none\\s*!important;`,
      "s",
    ),
  );
}

function extractCssBlock(source: string, startIndex: number) {
  const openingBrace = source.indexOf("{", startIndex);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(startIndex, index + 1);
  }

  throw new Error("CSS block is not closed");
}

describe("QingjianScroll reduced-motion contract", () => {
  it("disables card descendant transitions for the application preference", () => {
    for (const target of cardTransitionTargets) {
      expectTransitionDisabled(
        `.qj-root[data-reduce-motion="true"] .qj-card-slot ${target}`,
        css,
      );
    }
  });

  it("disables card descendant transitions for the system preference", () => {
    const mediaStart = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    const reducedMotionMedia = extractCssBlock(css, mediaStart);

    for (const target of cardTransitionTargets) {
      expectTransitionDisabled(
        `.qj-root .qj-card-slot ${target}`,
        reducedMotionMedia,
      );
    }
  });
});

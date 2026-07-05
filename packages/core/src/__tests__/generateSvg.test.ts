import { describe, expect, it } from "vitest";
import { hasVisibleSvgContent, sanitizeSvg } from "../browser/svgSanitize.js";

const size = { width: 800, height: 450 };

describe("generateSvg SVG content validation", () => {
  it("rejects sanitized SVGs that contain no visible content", () => {
    const empty = sanitizeSvg("<svg></svg>", size);
    const scriptOnly = sanitizeSvg("<svg><script>alert(1)</script></svg>", size);
    const visible = sanitizeSvg(`<svg><rect width="10" height="10" fill="red"/></svg>`, size);

    expect(empty).toMatch(/^<svg\b/i);
    expect(empty.length).toBeGreaterThan(64);
    expect(hasVisibleSvgContent(empty)).toBe(false);
    expect(hasVisibleSvgContent(scriptOnly)).toBe(false);
    expect(hasVisibleSvgContent(visible)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { hasVisibleSvgContent, sanitizeSvg } from "@qingagent/doc-render/browser";
import { buildGenerateSvgBranchTail } from "../tools/generateSvg.js";

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

  it("BranchCall 尾巴保留 SVG 专有安全规则与任务，并明确抑制工具", () => {
    const tail = buildGenerateSvgBranchTail("严禁 script 与外链", "插图内容：缓存树");
    expect(tail).toContain("不要调用任何工具");
    expect(tail).toContain("严禁 script 与外链");
    expect(tail).toContain("插图内容：缓存树");
    expect(tail).toContain("只输出一个完整 SVG 元素");
  });
});

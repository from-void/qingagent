// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { decodeSvgDataUrl, isAllowedImageSrc, safeParsePmDoc } from "../validators";

describe("imageSrcWhitelist", () => {
  it("rejects blob URLs", () => {
    expect(isAllowedImageSrc("blob:http://localhost/image")).toBe(false);
  });

  it("allows persisted file URLs", () => {
    expect(isAllowedImageSrc("/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png")).toBe(true);
    expect(isAllowedImageSrc("/api/v1/files/image_123")).toBe(false);
  });

  it("allows percent-encoded filenames (中文/空格/括号),拦截编码后的路径穿越", () => {
    // 回归:uploadedAssetUrl 用 encodeURIComponent 编码文件名,中文/空格图片名会变 %XX,
    // 此前被白名单静默拒绝 → setImage 返回 false → 图片插不进文档。
    const fid = "550e8400-e29b-41d4-a716-446655440000";
    const url = (name: string) => `/api/v1/files/${fid}/${encodeURIComponent(name)}`;
    expect(isAllowedImageSrc(url("测试图片.png"))).toBe(true);
    expect(isAllowedImageSrc(url("my photo.png"))).toBe(true);
    expect(isAllowedImageSrc(url("screenshot (1).png"))).toBe(true);
    // 编码后的 / 与 .. 仍必须拦住
    expect(isAllowedImageSrc(`/api/v1/files/${fid}/..%2f..%2fetc`)).toBe(false);
    expect(isAllowedImageSrc(`/api/v1/files/${fid}/%2e%2e.png`)).toBe(false);
    expect(isAllowedImageSrc(`/api/v1/files/${fid}/a/b.png`)).toBe(false);
  });

  it("rejects external image URLs from canonical PM", () => {
    expect(isAllowedImageSrc("https://example.com/image.png")).toBe(false);
  });

  it("allows sanitized svg data URLs and rejects unsafe svg", () => {
    const safe = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>")}`;
    const unsafe = `data:image/svg+xml,${encodeURIComponent("<svg onload='alert(1)'><script>alert(1)</script></svg>")}`;

    expect(isAllowedImageSrc(safe)).toBe(true);
    expect(isAllowedImageSrc(unsafe)).toBe(false);
  });

  it("统一解码 percent-encoded 与 base64 SVG，保留 UTF-8 文本", () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><text>中文图</text></svg>";
    const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const utf8Alias = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const base64 = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

    expect(decodeSvgDataUrl(encoded)).toBe(svg);
    expect(decodeSvgDataUrl(utf8Alias)).toBe(svg);
    expect(decodeSvgDataUrl(base64)).toBe(svg);
    expect(isAllowedImageSrc(base64)).toBe(true);
    expect(decodeSvgDataUrl("data:image/svg+xml,%E0%A4%A")).toBeNull();
  });

  it("validates image nodes through the PM validator", () => {
    const result = safeParsePmDoc({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "image",
          attrs: {
            blockId: "block-image",
            src: "blob:http://localhost/image",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects disallowed image src through the TipTap setImage command", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "paragraph", attrs: { blockId: "p" }, content: [] }],
      },
    });
    const setImage = editor.commands.setImage as (options: { src: string; alt?: string }) => boolean;

    try {
      expect(setImage({ src: "https://example.com/evil.png" })).toBe(false);
      expect(JSON.stringify(editor.getJSON())).not.toContain("evil.png");

      expect(setImage({
        src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
        alt: "figure",
      })).toBe(true);
      expect(JSON.stringify(editor.getJSON())).toContain("/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png");
    } finally {
      editor.destroy();
    }
  });
});

import { describe, expect, it } from "vitest";
import { ImageInputError, resolveImageInput } from "../tools/imageInput.js";

// data:image/...;base64,...(正文内联图 / 文档编辑区插入的 base64 图)。
// 真实 1x1 PNG(魔数 89 50 4E 47),用于走通 解码 + 魔数 + MIME 校验。
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function expectKind(image: string, kind: string): Promise<void> {
  await expect(resolveImageInput(image)).rejects.toMatchObject({ kind });
}

describe("resolveImageInput data: URL", () => {
  it("合法 data:image/png;base64 → 解码为 buffer + image/png", async () => {
    const r = await resolveImageInput(`data:image/png;base64,${PNG_1X1}`);
    expect(r.mimeType).toBe("image/png");
    expect(r.buffer.length).toBeGreaterThan(0);
    expect([0x89, 0x50, 0x4e, 0x47]).toEqual([...r.buffer.subarray(0, 4)]);
  });

  it("声明 image/png 但数据不是 PNG(魔数不符)→ unsupported_media", async () => {
    // "AAAA..." 解码后不是任何图片魔数
    await expectKind("data:image/png;base64,QUFBQUFBQUFBQUFBQUFB", "unsupported_media");
  });

  it("声明非图片 MIME → unsupported_media", async () => {
    await expectKind(`data:text/plain;base64,${PNG_1X1}`, "unsupported_media");
  });

  it("data: 但非 base64 编码 → unsupported_media", async () => {
    await expectKind("data:image/png,%89PNG", "unsupported_media");
  });

  it("裸 base64(无 data: 前缀)仍被拒,提示用 data: 前缀", async () => {
    await expect(resolveImageInput(PNG_1X1)).rejects.toBeInstanceOf(ImageInputError);
  });
});

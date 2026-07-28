import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IMPORT_GENERATED_IMAGE_MAX_BYTES,
  importGeneratedImageTool,
  importGeneratedImageFromPath,
} from "../tools/importGeneratedImage.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ONE_PIXEL_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af3//2Q==",
  "base64",
);
const JPEG_WITHOUT_SCAN = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);
const ONE_PIXEL_WEBP = Buffer.from(
  // webp-wasm@1.0.6 对不透明红色单像素以 lossless: 1 编码的真实 VP8L 码流。
  "UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA",
  "base64",
);
const INVALID_VP8_WEBP = Buffer.from(
  "524946461800000057454250565038200c0000003000009d012a01000100ffff",
  "hex",
);
const INVALID_VP8L_WEBP = Buffer.from(
  "5249464612000000574542505650384c060000002f00000000ff",
  "hex",
);
const TWO_FRAME_ANIMATED_WEBP = Buffer.from(
  // 两个 ANMF 均封装上方经真实编码、解码验证的 VP8L 帧。
  "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAAAAAAAAGMAAABWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAAAAAAAAGMAAABWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQA=",
  "base64",
);
const VP8X_ONLY_WEBP = Buffer.alloc(30);
VP8X_ONLY_WEBP.write("RIFF", 0, "ascii");
VP8X_ONLY_WEBP.writeUInt32LE(VP8X_ONLY_WEBP.length - 8, 4);
VP8X_ONLY_WEBP.write("WEBP", 8, "ascii");
VP8X_ONLY_WEBP.write("VP8X", 12, "ascii");
VP8X_ONLY_WEBP.writeUInt32LE(10, 16);
const tempDirs: string[] = [];

async function fixture(): Promise<{
  root: string;
  workspaceRoot: string;
  uploadsRoot: string;
  outsideRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-import-image-"));
  tempDirs.push(root);
  const workspaceRoot = join(root, "workspace");
  const uploadsRoot = join(root, "uploads");
  const outsideRoot = join(root, "outside");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(uploadsRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  return { root, workspaceRoot, uploadsRoot, outsideRoot };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("importGeneratedImage", () => {
  it("工具契约允许导入 Codex 生成或修改的图片产物", () => {
    expect(importGeneratedImageTool.description).toContain("生成或修改图片");
  });

  it("导入当前会话工作区内的合法 PNG，并返回真实尺寸与公开 src", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "codex-output.png");
    await writeFile(sourcePath, ONE_PIXEL_PNG);

    const result = await importGeneratedImageFromPath(
      { path: sourcePath, alt: "单像素测试图" },
      { workspaceRoot, uploadsRoot },
    );

    expect(result).toMatchObject({
      imageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      src: `/api/v1/files/${result.imageId}/generated-image.png`,
      width: 1,
      height: 1,
      alt: "单像素测试图",
    });
    await expect(
      readFile(join(uploadsRoot, result.imageId, "generated-image.png")),
    ).resolves.toEqual(ONE_PIXEL_PNG);
  });

  it("未传 alt 时结果不包含 alt 字段", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "without-alt.png");
    await writeFile(sourcePath, ONE_PIXEL_PNG);

    const result = await importGeneratedImageFromPath(
      { path: sourcePath },
      { workspaceRoot, uploadsRoot },
    );

    expect(result).not.toHaveProperty("alt");
  });

  it("接受 EOI 后带尾随字节的 JPEG", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "trailing-bytes.jpg");
    const jpegWithTrailingBytes = Buffer.concat([ONE_PIXEL_JPEG, Buffer.from([0x00, 0x01])]);
    await writeFile(sourcePath, jpegWithTrailingBytes);

    const result = await importGeneratedImageFromPath(
      { path: sourcePath },
      { workspaceRoot, uploadsRoot },
    );

    expect(result).toMatchObject({ width: 1, height: 1 });
    await expect(
      readFile(join(uploadsRoot, result.imageId, "generated-image.jpg")),
    ).resolves.toEqual(jpegWithTrailingBytes);
  });

  it("拒绝 SOI 错误的伪 JPEG", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "wrong-soi.jpg");
    const wrongSoi = Buffer.from(ONE_PIXEL_JPEG);
    wrongSoi[1] = 0xd7;
    await writeFile(sourcePath, wrongSoi);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("JPEG 段结构或尺寸无效");
  });

  it("拒绝只有 SOI 或缺少 EOI 的截断 JPEG", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const onlySoiPath = join(workspaceRoot, "only-soi.jpg");
    const missingEoiPath = join(workspaceRoot, "missing-eoi.jpg");
    await writeFile(onlySoiPath, Buffer.from([0xff, 0xd8]));
    await writeFile(missingEoiPath, ONE_PIXEL_JPEG.subarray(0, -2));

    await expect(
      importGeneratedImageFromPath({ path: onlySoiPath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("JPEG 段结构或尺寸无效");
    await expect(
      importGeneratedImageFromPath({ path: missingEoiPath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("JPEG 段结构或尺寸无效");
  });

  it("拒绝有 SOF 和 EOI 但没有扫描数据的伪 JPEG 且不落盘", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "without-scan.jpg");
    await writeFile(sourcePath, JPEG_WITHOUT_SCAN);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("JPEG 段结构或尺寸无效");
    await expect(readdir(uploadsRoot)).resolves.toEqual([]);
  });

  it("完整解码 WebP 后导入并返回正尺寸", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "one-pixel.webp");
    await writeFile(sourcePath, ONE_PIXEL_WEBP);

    const result = await importGeneratedImageFromPath(
      { path: sourcePath },
      { workspaceRoot, uploadsRoot },
    );

    expect(result).toMatchObject({ width: 1, height: 1 });
    await expect(
      readFile(join(uploadsRoot, result.imageId, "generated-image.webp")),
    ).resolves.toEqual(ONE_PIXEL_WEBP);
  });

  it("拒绝头部与尺寸伪装合法但码流不可解码的 VP8/VP8L 且不落盘", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const invalidVp8Path = join(workspaceRoot, "invalid-vp8.webp");
    const invalidVp8lPath = join(workspaceRoot, "invalid-vp8l.webp");
    await writeFile(invalidVp8Path, INVALID_VP8_WEBP);
    await writeFile(invalidVp8lPath, INVALID_VP8L_WEBP);

    await expect(
      importGeneratedImageFromPath({ path: invalidVp8Path }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
    await expect(
      importGeneratedImageFromPath({ path: invalidVp8lPath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
    await expect(readdir(uploadsRoot)).resolves.toEqual([]);
  });

  it("完整解码并导入 VP8X/ANIM/ANMF 动画 WebP", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "animated.webp");
    await writeFile(sourcePath, TWO_FRAME_ANIMATED_WEBP);

    const result = await importGeneratedImageFromPath(
      { path: sourcePath },
      { workspaceRoot, uploadsRoot },
    );

    expect(result).toMatchObject({ width: 1, height: 1 });
    await expect(
      readFile(join(uploadsRoot, result.imageId, "generated-image.webp")),
    ).resolves.toEqual(TWO_FRAME_ANIMATED_WEBP);
  });

  it("拒绝只有 RIFF/WEBP 魔数或声明长度超过实长的截断 WebP", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const magicOnlyPath = join(workspaceRoot, "magic-only.webp");
    const truncatedPath = join(workspaceRoot, "truncated.webp");
    const magicOnly = Buffer.alloc(12);
    magicOnly.write("RIFF", 0, "ascii");
    magicOnly.writeUInt32LE(4, 4);
    magicOnly.write("WEBP", 8, "ascii");
    await writeFile(magicOnlyPath, magicOnly);
    await writeFile(truncatedPath, ONE_PIXEL_WEBP.subarray(0, -1));

    await expect(
      importGeneratedImageFromPath({ path: magicOnlyPath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
    await expect(
      importGeneratedImageFromPath({ path: truncatedPath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
  });

  it("拒绝只有 VP8X 画布而没有图像码流的 WebP 且不落盘", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "vp8x-only.webp");
    await writeFile(sourcePath, VP8X_ONLY_WEBP);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
    await expect(readdir(uploadsRoot)).resolves.toEqual([]);
  });

  it("拒绝图片白名单之外的扩展名", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "codex-output.gif");
    await writeFile(sourcePath, ONE_PIXEL_PNG);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("只允许导入 png、jpg、jpeg、webp 或 svg 图片");
  });

  it("拒绝超过 10MB 上限的文件", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "oversized.png");
    await writeFile(sourcePath, Buffer.alloc(IMPORT_GENERATED_IMAGE_MAX_BYTES + 1));

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow(`图片超过 ${IMPORT_GENERATED_IMAGE_MAX_BYTES} 字节上限`);
  });

  it("拒绝当前会话工作区之外的绝对路径", async () => {
    const { workspaceRoot, uploadsRoot, outsideRoot } = await fixture();
    const sourcePath = join(outsideRoot, "other-session.png");
    await writeFile(sourcePath, ONE_PIXEL_PNG);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("只能导入当前会话沙箱工作区内的图片");
  });

  it("拒绝扩展名与真实图片字节不匹配的伪 PNG", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "fake.png");
    await writeFile(sourcePath, "这不是图片");

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("PNG 文件头或尺寸无效");
  });

  it("公开落盘前加固 SVG，移除脚本与事件属性", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "unsafe.svg");
    await writeFile(
      sourcePath,
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>',
      "utf8",
    );

    const result = await importGeneratedImageFromPath(
      { path: sourcePath },
      { workspaceRoot, uploadsRoot },
    );
    const persisted = await readFile(
      join(uploadsRoot, result.imageId, "generated-image.svg"),
      "utf8",
    );
    expect(persisted).toContain("<rect");
    expect(persisted).not.toMatch(/<script|onload=/i);
  });

  it("即使 uploads 位于工作区内也禁止从 uploads 自身重复导入", async () => {
    const { workspaceRoot } = await fixture();
    const uploadsRoot = join(workspaceRoot, "uploads");
    const sourceDir = join(uploadsRoot, "existing-id");
    const sourcePath = join(sourceDir, "generated-image.png");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourcePath, ONE_PIXEL_PNG);

    await expect(
      importGeneratedImageFromPath({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
    ).rejects.toThrow("禁止从 uploads 目录重复导入图片");
  });

  it("webp-wasm 模块缺失时严格拒绝 WebP 且不落盘", async () => {
    const { workspaceRoot, uploadsRoot } = await fixture();
    const sourcePath = join(workspaceRoot, "without-decoder.webp");
    await writeFile(sourcePath, ONE_PIXEL_WEBP);

    vi.resetModules();
    vi.doMock("webp-wasm", () => {
      throw new Error("测试模拟 webp-wasm 模块缺失");
    });
    try {
      const { importGeneratedImageFromPath: importWithoutWebpWasm } = await import(
        "../tools/importGeneratedImage.js"
      );
      await expect(
        importWithoutWebpWasm({ path: sourcePath }, { workspaceRoot, uploadsRoot }),
      ).rejects.toThrow("WebP RIFF 结构、图像区块或码流无效");
    } finally {
      vi.doUnmock("webp-wasm");
      vi.resetModules();
    }

    await expect(readdir(uploadsRoot)).resolves.toEqual([]);
  });
});

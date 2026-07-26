import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const ONE_PIXEL_JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);
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
    ).rejects.toThrow("JPEG 文件头无效");
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
});

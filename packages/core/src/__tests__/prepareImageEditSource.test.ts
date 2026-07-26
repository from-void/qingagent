import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareImageEditSourceTool,
  prepareImageEditSourceFromReference,
} from "../tools/prepareImageEditSource.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tempDirs: string[] = [];

async function workspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-image-edit-source-"));
  tempDirs.push(root);
  return join(root, "workspace");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareImageEditSource", () => {
  it("工具面把桌面、用户确认和受限源图引用写进触发契约", () => {
    expect(prepareImageEditSourceTool.id).toBe("prepareImageEditSource");
    expect(prepareImageEditSourceTool.description).toContain("仅当运行在桌面客户端");
    expect(prepareImageEditSourceTool.description).toContain("用户已经确认");
    expect(prepareImageEditSourceTool.description).toContain("不得输入或探测任意宿主文件路径");
  });

  it("把通过校验的上传图片副本写进会话工作区唯一绝对路径", async () => {
    const workspaceRoot = await workspaceFixture();
    const result = await prepareImageEditSourceFromReference(
      { image: "11111111-1111-4111-8111-111111111111" },
      {
        workspaceRoot,
        resolveImage: vi.fn(async (image) => {
          expect(image).toBe("11111111-1111-4111-8111-111111111111");
          return { buffer: ONE_PIXEL_PNG, mimeType: "image/png" };
        }),
      },
    );

    expect(dirname(result.path)).toBe(workspaceRoot);
    expect(basename(result.path)).toMatch(/^codex-image-source-[0-9a-f-]+\.png$/);
    expect(result).toMatchObject({
      mimeType: "image/png",
      bytes: ONE_PIXEL_PNG.length,
    });
    await expect(readFile(result.path)).resolves.toEqual(ONE_PIXEL_PNG);
  });

  it("图片素材 materialId 必须先解析到原始 fileId，再复制进工作区", async () => {
    const workspaceRoot = await workspaceFixture();
    const resolveImage = vi.fn(async () => ({
      buffer: ONE_PIXEL_PNG,
      mimeType: "image/png",
    }));
    const materials = new Map([
      ["material-image", {
        fileId: "22222222-2222-4222-8222-222222222222",
        mimeType: "image/png",
        filename: "素材图.png",
      }],
    ]);

    await prepareImageEditSourceFromReference(
      { image: "material-image" },
      { workspaceRoot, materials, resolveImage },
    );

    expect(resolveImage).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("拒绝把非图片素材当作图生图源图", async () => {
    const workspaceRoot = await workspaceFixture();
    const resolveImage = vi.fn();
    const materials = new Map([
      ["material-pdf", {
        fileId: "33333333-3333-4333-8333-333333333333",
        mimeType: "application/pdf",
        filename: "报告.pdf",
      }],
    ]);

    await expect(
      prepareImageEditSourceFromReference(
        { image: "material-pdf" },
        { workspaceRoot, materials, resolveImage },
      ),
    ).rejects.toThrow("不是图片文件");
    expect(resolveImage).not.toHaveBeenCalled();
  });

  it("拒绝解析器返回的非白名单图片格式，不在工作区伪造扩展名", async () => {
    const workspaceRoot = await workspaceFixture();

    await expect(
      prepareImageEditSourceFromReference(
        { image: "source" },
        {
          workspaceRoot,
          resolveImage: async () => ({
            buffer: Buffer.from("<svg/>"),
            mimeType: "image/svg+xml",
          }),
        },
      ),
    ).rejects.toThrow("源图只支持 png、jpg、jpeg、webp 或 gif");
  });
});

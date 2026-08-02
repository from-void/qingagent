import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { editFileTool, LocalFilesystem, Workspace } from "@mastra/core/workspace";
import {
  prepareImageEditSourceTool,
  prepareImageEditSourceFromReference,
} from "../tools/prepareImageEditSource.js";
import { importGeneratedImageFromPath } from "../tools/importGeneratedImage.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const TARGETED_REDRAW_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">' +
    '<rect width="120" height="80" fill="#efe7d6"/>' +
    '<g id="sun"><circle cx="90" cy="20" r="8" fill="#d7a928"/></g>' +
    '<path d="M0 60H120" stroke="#315c72"/></svg>',
  "utf8",
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
  it("工具面把受限源图引用、SVG 与原生定点编辑写进触发契约", () => {
    expect(prepareImageEditSourceTool.id).toBe("prepareImageEditSource");
    expect(prepareImageEditSourceTool.description).toContain("png/jpg/jpeg/webp/gif/svg");
    expect(prepareImageEditSourceTool.description).toContain("原生 SVG 定点编辑");
    expect(prepareImageEditSourceTool.description).toContain("editablePath");
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
      workspacePath: expect.stringMatching(/^\/workspace\/codex-image-source-[0-9a-f-]+\.png$/),
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

  it("SVG 源图通过真实 data URL 校验，并准备逐元素编辑副本", async () => {
    const workspaceRoot = await workspaceFixture();
    const image = `data:image/svg+xml;base64,${TARGETED_REDRAW_SVG.toString("base64")}`;

    const result = await prepareImageEditSourceFromReference(
      { image },
      { workspaceRoot },
    );

    expect(basename(result.path)).toMatch(/^codex-image-source-[0-9a-f-]+\.svg$/);
    expect(result).toMatchObject({
      mimeType: "image/svg+xml",
      bytes: TARGETED_REDRAW_SVG.length,
    });
    expect(result.editablePath).toBeTruthy();
    expect(result.editableWorkspacePath).toBeTruthy();
    expect(result.editablePath).not.toBe(result.path);
    expect(basename(result.editablePath!)).toMatch(/^svg-edit-output-[0-9a-f-]+\.svg$/);
    expect(result.workspacePath).toMatch(/^\/workspace\/codex-image-source-[0-9a-f-]+\.svg$/);
    expect(result.editableWorkspacePath).toMatch(/^\/workspace\/svg-edit-output-[0-9a-f-]+\.svg$/);
    await expect(readFile(result.path)).resolves.toEqual(TARGETED_REDRAW_SVG);
    await expect(readFile(result.editablePath!)).resolves.toEqual(TARGETED_REDRAW_SVG);
  });

  it("SVG 声明与内容不符时仍拒绝，不为脏输入准备编辑副本", async () => {
    const workspaceRoot = await workspaceFixture();
    const image = `data:image/svg+xml;base64,${Buffer.from("not svg", "utf8").toString("base64")}`;

    await expect(
      prepareImageEditSourceFromReference({ image }, { workspaceRoot }),
    ).rejects.toMatchObject({ kind: "unsupported_media" });
  });

  it("原生定点编辑只替换目标图元，导入后未点名图元保持不变", async () => {
    const workspaceRoot = await workspaceFixture();
    const uploadsRoot = join(dirname(workspaceRoot), "uploads");
    const image = `data:image/svg+xml;base64,${TARGETED_REDRAW_SVG.toString("base64")}`;
    const prepared = await prepareImageEditSourceFromReference({ image }, { workspaceRoot });
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: workspaceRoot }),
    });
    const oldSun = '<g id="sun"><circle cx="90" cy="20" r="8" fill="#d7a928"/></g>';
    const newMoon = '<g id="moon"><path d="M94 12a9 9 0 1 0 0 16 7 7 0 1 1 0-16Z" fill="#d7a928"/></g>';

    try {
      await editFileTool.execute!(
        {
          path: prepared.editablePath!,
          old_string: oldSun,
          new_string: newMoon,
          replace_all: false,
        },
        { workspace } as never,
      );

      const expected = TARGETED_REDRAW_SVG.toString("utf8").replace(oldSun, newMoon);
      await expect(readFile(prepared.path, "utf8")).resolves.toBe(TARGETED_REDRAW_SVG.toString("utf8"));
      await expect(readFile(prepared.editablePath!, "utf8")).resolves.toBe(expected);

      const imported = await importGeneratedImageFromPath(
        { path: prepared.editablePath!, alt: "月亮版插图" },
        { workspaceRoot, uploadsRoot },
      );
      const importedSvg = await readFile(
        join(uploadsRoot, imported.imageId, basename(imported.src)),
        "utf8",
      );
      expect(importedSvg).toContain('id="moon"');
      expect(importedSvg).not.toContain('id="sun"');
      expect(importedSvg).toContain('<rect width="120" height="80" fill="#efe7d6"');
      expect(importedSvg).toContain('d="M0 60H120" stroke="#315c72"');
    } finally {
      await workspace.destroy();
    }
  });
});

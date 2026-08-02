import { createTool } from "@mastra/core/tools";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import {
  resolveImageInput,
  type ResolvedImageInput,
} from "./imageInput.js";

type ImageMaterialLookup = {
  get?: (id: string) => {
    fileId?: string | null;
    mimeType?: string;
    filename?: string;
  } | undefined;
};

export type SupportedImageEditSourceMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/svg+xml";

export interface PrepareImageEditSourceInput {
  image: string;
}

export interface PrepareImageEditSourceResult {
  path: string;
  workspacePath: string;
  mimeType: SupportedImageEditSourceMimeType;
  bytes: number;
  editablePath?: string;
  editableWorkspacePath?: string;
}

export interface PrepareImageEditSourceOptions {
  workspaceRoot: string;
  materials?: ImageMaterialLookup;
  resolveImage?: (image: string) => Promise<ResolvedImageInput>;
}

function sourceExtension(
  mimeType: string,
): {
  extension: "png" | "jpg" | "webp" | "gif" | "svg";
  mimeType: SupportedImageEditSourceMimeType;
} {
  switch (mimeType) {
    case "image/png":
      return { extension: "png", mimeType };
    case "image/jpeg":
      return { extension: "jpg", mimeType };
    case "image/webp":
      return { extension: "webp", mimeType };
    case "image/gif":
      return { extension: "gif", mimeType };
    case "image/svg+xml":
      return { extension: "svg", mimeType };
    default:
      throw new Error("源图只支持 png、jpg、jpeg、webp、gif 或 svg");
  }
}

function resolveMaterialImageReference(
  image: string,
  materials?: ImageMaterialLookup,
): string {
  const material =
    materials && typeof materials.get === "function"
      ? materials.get(image)
      : undefined;
  if (!material || typeof material !== "object") return image;
  if (material.mimeType && !material.mimeType.startsWith("image/")) {
    throw new Error(`素材「${material.filename ?? image}」不是图片文件`);
  }
  if (!material.fileId) {
    throw new Error(`素材「${material.filename ?? image}」没有可用的原始图片文件`);
  }
  return material.fileId;
}

/**
 * 把用户明确引用的源图安全复制进当前会话工作区，供本机 Codex 或原生 SVG 定点编辑读取。
 * 不接受任意宿主文件路径；图片引用仍统一经过 imageInput 的路径、大小、魔数与 SSRF 校验。
 */
export async function prepareImageEditSourceFromReference(
  input: PrepareImageEditSourceInput,
  options: PrepareImageEditSourceOptions,
): Promise<PrepareImageEditSourceResult> {
  const imageReference = resolveMaterialImageReference(
    input.image.trim(),
    options.materials,
  );
  const resolved = await (
    options.resolveImage ??
    ((image: string) => resolveImageInput(image, undefined, { allowSvg: true }))
  )(imageReference);
  const sourceType = sourceExtension(resolved.mimeType);
  await mkdir(options.workspaceRoot, { recursive: true });
  const sourceId = randomUUID();
  const destination = join(
    options.workspaceRoot,
    `codex-image-source-${sourceId}.${sourceType.extension}`,
  );
  const workspacePath = `/workspace/codex-image-source-${sourceId}.${sourceType.extension}`;
  await writeFile(destination, resolved.buffer, { flag: "wx" });
  const editablePath =
    sourceType.mimeType === "image/svg+xml"
      ? join(options.workspaceRoot, `svg-edit-output-${sourceId}.svg`)
      : undefined;
  const editableWorkspacePath = editablePath
    ? `/workspace/svg-edit-output-${sourceId}.svg`
    : undefined;
  if (editablePath) {
    await writeFile(editablePath, resolved.buffer, { flag: "wx" });
  }
  return {
    path: destination,
    workspacePath,
    mimeType: sourceType.mimeType,
    bytes: resolved.buffer.length,
    ...(editablePath ? { editablePath } : {}),
    ...(editableWorkspacePath ? { editableWorkspacePath } : {}),
  };
}

export const prepareImageEditSourceTool = createTool({
  id: "prepareImageEditSource",
  description:
    "【触发限制：仅供 image-gen 修改现有图片流程使用】" +
    "可用于确认源图格式并准备本机 Codex 修改，或在 Codex 不可用时准备原生 SVG 定点编辑。" +
    "输入必须是用户明确指定的源图引用：刚上传图片的 fileId、正文图片块的 src、图片素材的 materialId，" +
    "或该正文图片原有的 http(s)/data:image 引用；不得输入或探测任意宿主文件路径。" +
    "工具会把通过大小、格式、路径和网络安全校验的源图复制到当前会话沙箱工作区，支持 png/jpg/jpeg/webp/gif/svg；" +
    "返回只读源图的绝对 path 与文件工具可读的 workspacePath；SVG 还返回初始内容逐字节相同的" +
    " editablePath 与 editableWorkspacePath 供定点修改。" +
    "本工具不会修改源图、生成图片或导入产物。",
  inputSchema: z.object({
    image: z.string().min(1).describe(
      "用户明确指定的源图引用：fileId、/api/v1/files/... src、图片 materialId、http(s) 图片 URL 或 data:image URL",
    ),
  }),
  outputSchema: z.object({
    path: z.string(),
    workspacePath: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]),
    bytes: z.number().int().positive(),
    editablePath: z.string().optional(),
    editableWorkspacePath: z.string().optional(),
  }),
  execute: async (input, context) => {
    const sessionId = context?.requestContext?.get("sessionId");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("缺少当前会话，无法准备图片修改源图");
    }
    const materials = context?.requestContext?.get("materials") as
      | ImageMaterialLookup
      | undefined;
    return prepareImageEditSourceFromReference(input, {
      workspaceRoot: sessionWorkspaceDir(sessionId),
      materials,
    });
  },
});

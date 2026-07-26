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
  | "image/gif";

export interface PrepareImageEditSourceInput {
  image: string;
}

export interface PrepareImageEditSourceResult {
  path: string;
  mimeType: SupportedImageEditSourceMimeType;
  bytes: number;
}

export interface PrepareImageEditSourceOptions {
  workspaceRoot: string;
  materials?: ImageMaterialLookup;
  resolveImage?: (image: string) => Promise<ResolvedImageInput>;
}

function sourceExtension(
  mimeType: string,
): {
  extension: "png" | "jpg" | "webp" | "gif";
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
    default:
      throw new Error("源图只支持 png、jpg、jpeg、webp 或 gif");
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
 * 把用户明确引用的源图安全复制进当前会话工作区，供本机 Codex 图生图读取。
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
  const resolved = await (options.resolveImage ?? resolveImageInput)(imageReference);
  const sourceType = sourceExtension(resolved.mimeType);
  await mkdir(options.workspaceRoot, { recursive: true });
  const destination = join(
    options.workspaceRoot,
    `codex-image-source-${randomUUID()}.${sourceType.extension}`,
  );
  await writeFile(destination, resolved.buffer, { flag: "wx" });
  return {
    path: destination,
    mimeType: sourceType.mimeType,
    bytes: resolved.buffer.length,
  };
}

export const prepareImageEditSourceTool = createTool({
  id: "prepareImageEditSource",
  description:
    "【触发限制：仅供 image-gen/codex-image 的修改现有图片流程使用】" +
    "仅当运行在桌面客户端、已检测到本机 Codex，且用户已经确认让本机 Codex 修改图片后才可调用。" +
    "输入必须是用户明确指定的源图引用：刚上传图片的 fileId、正文图片块的 src、图片素材的 materialId，" +
    "或该正文图片原有的 http(s)/data:image 引用；不得输入或探测任意宿主文件路径。" +
    "工具会把通过大小、格式、路径和网络安全校验的源图复制到当前会话沙箱工作区，" +
    "返回供 codex exec 读取的唯一绝对 path。本工具不会修改源图、生成图片或导入产物。",
  inputSchema: z.object({
    image: z.string().min(1).describe(
      "用户明确指定的源图引用：fileId、/api/v1/files/... src、图片 materialId、http(s) 图片 URL 或 data:image URL",
    ),
  }),
  outputSchema: z.object({
    path: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    bytes: z.number().int().positive(),
  }),
  execute: async (input, context) => {
    if (process.env.QINGAGENT_RUNTIME !== "desktop") {
      throw new Error("当前不是桌面环境，无法调用本机 Codex 修改图片");
    }
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

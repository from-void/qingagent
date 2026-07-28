import { createTool } from "@mastra/core/tools";
import { hardenInlineSvg } from "@qingagent/doc-render/browser";
import { uploadsBaseDir } from "@qingagent/doc-render/paths";
import { decode as decodeJpeg } from "jpeg-js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

export const IMPORT_GENERATED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

type GeneratedImageExtension = "png" | "jpg" | "jpeg" | "webp" | "svg";

export interface ImportGeneratedImageInput {
  path: string;
  alt?: string | null;
}

export interface ImportGeneratedImageResult {
  imageId: string;
  src: string;
  alt?: string | null;
  width?: number;
  height?: number;
}

export interface ImportGeneratedImageOptions {
  workspaceRoot: string;
  uploadsRoot?: string;
  maxBytes?: number;
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(normalizedPath(root), normalizedPath(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function generatedImageExtension(path: string): GeneratedImageExtension {
  const extension = extname(path).slice(1).toLowerCase();
  if (
    extension === "png" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "webp" ||
    extension === "svg"
  ) {
    return extension;
  }
  throw new Error("只允许导入 png、jpg、jpeg、webp 或 svg 图片");
}

function hasPngSignature(buffer: Buffer): boolean {
  return buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a &&
    buffer.subarray(12, 16).toString("ascii") === "IHDR";
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!hasPngSignature(buffer)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function hasJpegSignature(buffer: Buffer): boolean {
  return buffer.length >= 2 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!hasJpegSignature(buffer)) return null;
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  let hasEndOfImage = false;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xd9) {
      hasEndOfImage = true;
      break;
    }
    if (marker === 0xda) {
      if (offset + 1 >= buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      const endOfImage = buffer.indexOf(
        Buffer.from([0xff, 0xd9]),
        offset + segmentLength,
      );
      if (endOfImage === -1) break;
      hasEndOfImage = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  if (!hasEndOfImage || !dimensions) return null;
  try {
    const decoded = decodeJpeg(buffer, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: 40,
      maxMemoryUsageInMB: 256,
    });
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) {
      return null;
    }
  } catch {
    return null;
  }
  return dimensions;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function vp8Dimensions(
  buffer: Buffer,
  dataOffset: number,
  chunkSize: number,
): { width: number; height: number } | null {
  if (
    chunkSize < 11 ||
    buffer[dataOffset + 3] !== 0x9d ||
    buffer[dataOffset + 4] !== 0x01 ||
    buffer[dataOffset + 5] !== 0x2a
  ) {
    return null;
  }
  const frameTag = readUInt24LE(buffer, dataOffset);
  const firstPartitionLength = frameTag >>> 5;
  if (
    (frameTag & 0x01) !== 0 ||
    ((frameTag >>> 1) & 0x07) > 3 ||
    ((frameTag >>> 4) & 0x01) !== 1 ||
    firstPartitionLength === 0 ||
    10 + firstPartitionLength >= chunkSize
  ) {
    return null;
  }
  const width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
  const height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : null;
}

function vp8lDimensions(
  buffer: Buffer,
  dataOffset: number,
  chunkSize: number,
): { width: number; height: number } | null {
  if (chunkSize < 6 || buffer[dataOffset] !== 0x2f) return null;
  const bits = buffer.readUInt32LE(dataOffset + 1);
  if ((bits >>> 29) !== 0) return null;
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

type ImageDimensions = { width: number; height: number };

type WebpChunk = {
  type: string;
  dataOffset: number;
  dataEnd: number;
  size: number;
};

type ParsedWebp = {
  dimensions: ImageDimensions;
  decodeTargets: Array<{ buffer: Buffer; dimensions: ImageDimensions }>;
};

const WEBP_MAX_DECODED_PIXELS = 40_000_000;

function webpChunks(
  buffer: Buffer,
  start: number,
  end: number,
): WebpChunk[] | null {
  const chunks: WebpChunk[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return null;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    const nextOffset = dataEnd + (size % 2);
    if (dataEnd > end || nextOffset > end) return null;
    chunks.push({ type, dataOffset, dataEnd, size });
    offset = nextOffset;
  }
  return offset === end ? chunks : null;
}

function webpChunkDimensions(buffer: Buffer, chunk: WebpChunk): ImageDimensions | null {
  if (chunk.type === "VP8 ") {
    return vp8Dimensions(buffer, chunk.dataOffset, chunk.size);
  }
  if (chunk.type === "VP8L") {
    return vp8lDimensions(buffer, chunk.dataOffset, chunk.size);
  }
  return null;
}

function hasSafeDecodedPixelCount(dimensions: ImageDimensions): boolean {
  return dimensions.width * dimensions.height <= WEBP_MAX_DECODED_PIXELS;
}

function standaloneWebpFrame(
  buffer: Buffer,
  chunks: WebpChunk[],
  dimensions: ImageDimensions,
): Buffer | null {
  const alphaChunk = chunks.find((chunk) => chunk.type === "ALPH");
  const imageChunk = chunks.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
  if (!imageChunk) return null;

  const frameChunksStart = alphaChunk
    ? alphaChunk.dataOffset - 8
    : imageChunk.dataOffset - 8;
  const frameChunksEnd = imageChunk.dataEnd + (imageChunk.size % 2);
  const frameChunks = buffer.subarray(frameChunksStart, frameChunksEnd);
  const vp8xChunk = alphaChunk ? Buffer.alloc(18) : null;
  if (vp8xChunk) {
    vp8xChunk.write("VP8X", 0, "ascii");
    vp8xChunk.writeUInt32LE(10, 4);
    vp8xChunk[8] = 0x10;
    vp8xChunk.writeUIntLE(dimensions.width - 1, 12, 3);
    vp8xChunk.writeUIntLE(dimensions.height - 1, 15, 3);
  }

  const payload = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    ...(vp8xChunk ? [vp8xChunk] : []),
    frameChunks,
  ]);
  const standalone = Buffer.alloc(8 + payload.length);
  standalone.write("RIFF", 0, "ascii");
  standalone.writeUInt32LE(payload.length, 4);
  payload.copy(standalone, 8);
  return standalone;
}

function parseAnimatedWebp(
  buffer: Buffer,
  chunks: WebpChunk[],
  canvasDimensions: ImageDimensions,
): ParsedWebp | null {
  const animChunks = chunks.filter((chunk) => chunk.type === "ANIM");
  const frameChunks = chunks.filter((chunk) => chunk.type === "ANMF");
  if (animChunks.length !== 1 || frameChunks.length === 0) return null;

  const animIndex = chunks.indexOf(animChunks[0]!);
  if (
    animChunks[0]!.size !== 6 ||
    frameChunks.some((frame) => chunks.indexOf(frame) < animIndex)
  ) {
    return null;
  }

  const decodeTargets: ParsedWebp["decodeTargets"] = [];
  let totalPixels = 0;
  for (const frame of frameChunks) {
    if (frame.size < 24) return null;
    const frameX = readUInt24LE(buffer, frame.dataOffset) * 2;
    const frameY = readUInt24LE(buffer, frame.dataOffset + 3) * 2;
    const dimensions = {
      width: readUInt24LE(buffer, frame.dataOffset + 6) + 1,
      height: readUInt24LE(buffer, frame.dataOffset + 9) + 1,
    };
    const frameFlags = buffer[frame.dataOffset + 15]!;
    if (
      (frameFlags & 0xfc) !== 0 ||
      frameX + dimensions.width > canvasDimensions.width ||
      frameY + dimensions.height > canvasDimensions.height
    ) {
      return null;
    }

    totalPixels += dimensions.width * dimensions.height;
    if (totalPixels > WEBP_MAX_DECODED_PIXELS) return null;

    const nestedChunks = webpChunks(buffer, frame.dataOffset + 16, frame.dataEnd);
    if (!nestedChunks) return null;
    const imageChunks = nestedChunks.filter(
      (chunk) => chunk.type === "VP8 " || chunk.type === "VP8L",
    );
    const alphaChunks = nestedChunks.filter((chunk) => chunk.type === "ALPH");
    if (
      nestedChunks.some(
        (chunk) => chunk.type !== "ALPH" && chunk.type !== "VP8 " && chunk.type !== "VP8L",
      ) ||
      imageChunks.length !== 1 ||
      alphaChunks.length > 1 ||
      (alphaChunks.length === 1 &&
        (
          imageChunks[0]!.type !== "VP8 " ||
          nestedChunks.indexOf(alphaChunks[0]!) > nestedChunks.indexOf(imageChunks[0]!)
        ))
    ) {
      return null;
    }

    const bitstreamDimensions = webpChunkDimensions(buffer, imageChunks[0]!);
    if (
      !bitstreamDimensions ||
      bitstreamDimensions.width !== dimensions.width ||
      bitstreamDimensions.height !== dimensions.height
    ) {
      return null;
    }
    const standalone = standaloneWebpFrame(buffer, nestedChunks, dimensions);
    if (!standalone) return null;
    decodeTargets.push({ buffer: standalone, dimensions });
  }

  return { dimensions: canvasDimensions, decodeTargets };
}

function parseWebp(buffer: Buffer): ParsedWebp | null {
  if (
    buffer.length < 20 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    return null;
  }

  const chunks = webpChunks(buffer, 12, buffer.length);
  if (!chunks || chunks.length === 0) return null;
  const extendedChunks = chunks.filter((chunk) => chunk.type === "VP8X");
  const imageChunks = chunks.filter(
    (chunk) => chunk.type === "VP8 " || chunk.type === "VP8L",
  );
  const hasAnimationChunks = chunks.some(
    (chunk) => chunk.type === "ANIM" || chunk.type === "ANMF",
  );

  if (extendedChunks.length === 0) {
    if (chunks.length !== 1 || imageChunks.length !== 1) return null;
    const dimensions = webpChunkDimensions(buffer, imageChunks[0]!);
    if (!dimensions || !hasSafeDecodedPixelCount(dimensions)) return null;
    return { dimensions, decodeTargets: [{ buffer, dimensions }] };
  }

  const extendedChunk = extendedChunks[0]!;
  if (
    extendedChunks.length !== 1 ||
    chunks[0] !== extendedChunk ||
    extendedChunk.size !== 10 ||
    (buffer[extendedChunk.dataOffset]! & 0xc1) !== 0 ||
    buffer[extendedChunk.dataOffset + 1] !== 0 ||
    buffer[extendedChunk.dataOffset + 2] !== 0 ||
    buffer[extendedChunk.dataOffset + 3] !== 0
  ) {
    return null;
  }

  const canvasDimensions = {
    width: readUInt24LE(buffer, extendedChunk.dataOffset + 4) + 1,
    height: readUInt24LE(buffer, extendedChunk.dataOffset + 7) + 1,
  };
  if (!hasSafeDecodedPixelCount(canvasDimensions)) return null;
  const animationFlag = (buffer[extendedChunk.dataOffset]! & 0x02) !== 0;
  if (animationFlag !== hasAnimationChunks) return null;

  if (animationFlag) {
    if (
      imageChunks.length !== 0 ||
      chunks.some((chunk) => chunk.type === "ALPH")
    ) {
      return null;
    }
    return parseAnimatedWebp(buffer, chunks, canvasDimensions);
  }

  if (hasAnimationChunks || imageChunks.length !== 1) return null;
  const imageDimensions = webpChunkDimensions(buffer, imageChunks[0]!);
  if (
    !imageDimensions ||
    imageDimensions.width !== canvasDimensions.width ||
    imageDimensions.height !== canvasDimensions.height
  ) {
    return null;
  }
  return {
    dimensions: canvasDimensions,
    decodeTargets: [{ buffer, dimensions: canvasDimensions }],
  };
}

async function webpDimensions(buffer: Buffer): Promise<ImageDimensions | null> {
  const parsed = parseWebp(buffer);
  if (!parsed) return null;

  try {
    const imported = await import("webp-wasm");
    const decoder = (
      "default" in imported ? imported.default : imported
    ) as typeof import("webp-wasm");
    for (const target of parsed.decodeTargets) {
      const exactBuffer = Uint8Array.from(target.buffer).buffer;
      // webp-wasm@1.0.6 的 CommonJS 方法依赖 this.loadDecoder，不能解构后调用。
      const decoded = await decoder.decode(exactBuffer);
      if (
        !decoded ||
        decoded.width !== target.dimensions.width ||
        decoded.height !== target.dimensions.height ||
        decoded.data.length !== decoded.width * decoded.height * 4
      ) {
        return null;
      }
    }
  } catch {
    return null;
  }
  return parsed.dimensions;
}

async function validateAndPrepareImage(
  buffer: Buffer,
  extension: GeneratedImageExtension,
  maxBytes: number,
): Promise<{ buffer: Buffer; dimensions: ImageDimensions | null }> {
  if (buffer.length === 0) throw new Error("图片文件为空");
  if (buffer.length > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节上限`);

  if (extension === "png") {
    const dimensions = pngDimensions(buffer);
    if (!dimensions) throw new Error("PNG 文件头或尺寸无效");
    return { buffer, dimensions };
  }
  if (extension === "jpg" || extension === "jpeg") {
    const dimensions = jpegDimensions(buffer);
    if (!dimensions) throw new Error("JPEG 段结构或尺寸无效");
    return { buffer, dimensions };
  }
  if (extension === "webp") {
    const dimensions = await webpDimensions(buffer);
    if (!dimensions) throw new Error("WebP RIFF 结构、图像区块或码流无效");
    return { buffer, dimensions };
  }

  const hardened = hardenInlineSvg(buffer.toString("utf8"), { maxBytes });
  if (!hardened) throw new Error("SVG 内容无效或包含不安全结构");
  const hardenedBuffer = Buffer.from(hardened, "utf8");
  if (hardenedBuffer.length > maxBytes) {
    throw new Error(`SVG 安全处理后超过 ${maxBytes} 字节上限`);
  }
  return { buffer: hardenedBuffer, dimensions: null };
}

/**
 * 把当前会话沙箱内由 codex-image 流程生成或修改的图片产物复制到公开 uploads。
 * 单独导出纯函数，便于对路径边界与脏文件输入做密闭回归测试。
 */
export async function importGeneratedImageFromPath(
  input: ImportGeneratedImageInput,
  options: ImportGeneratedImageOptions,
): Promise<ImportGeneratedImageResult> {
  if (!isAbsolute(input.path)) throw new Error("path 必须是沙箱内的绝对路径");
  const extension = generatedImageExtension(input.path);
  const maxBytes = options.maxBytes ?? IMPORT_GENERATED_IMAGE_MAX_BYTES;
  const uploadsRoot = resolve(options.uploadsRoot ?? uploadsBaseDir());

  let workspaceReal: string;
  let sourceReal: string;
  try {
    [workspaceReal, sourceReal] = await Promise.all([
      realpath(options.workspaceRoot),
      realpath(input.path),
    ]);
  } catch {
    throw new Error("图片文件不存在或路径不可访问");
  }
  if (!isInsideRoot(sourceReal, workspaceReal)) {
    throw new Error("只能导入当前会话沙箱工作区内的图片");
  }

  const uploadsReal = await realpath(uploadsRoot).catch(() => uploadsRoot);
  if (isInsideRoot(sourceReal, uploadsReal)) {
    throw new Error("禁止从 uploads 目录重复导入图片");
  }

  const fileStat = await stat(sourceReal);
  if (!fileStat.isFile()) throw new Error("path 必须指向普通图片文件");
  if (fileStat.size > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节上限`);

  // stat 只用于尽早拒绝；仍真实读取并按 buffer 长度复核，避免竞态替换绕过大小上限。
  const rawBuffer = await readFile(sourceReal);
  const prepared = await validateAndPrepareImage(rawBuffer, extension, maxBytes);
  const imageId = randomUUID();
  const filename = `generated-image.${extension}`;
  const destinationDir = join(uploadsRoot, imageId);
  await mkdir(destinationDir, { recursive: true });
  await writeFile(join(destinationDir, filename), prepared.buffer);

  return {
    imageId,
    src: `/api/v1/files/${imageId}/${filename}`,
    ...(input.alt !== undefined ? { alt: input.alt } : {}),
    ...(prepared.dimensions ?? {}),
  };
}

export const importGeneratedImageTool = createTool({
  id: "importGeneratedImage",
  description:
    "【触发限制：仅供 image-gen/codex-image 子技能使用】" +
    "仅当本轮已经通过本机 codex exec 在当前会话沙箱工作区生成或修改图片后，才可调用本工具将该产物导入文档图片库；" +
    "不得用于用户上传文件、资料库文件、uploads 文件或任意宿主路径，也不得借此绕过工作区路径边界。" +
    "输入沙箱内图片的绝对 path（只允许 png/jpg/jpeg/webp/svg）和可选 alt，返回真实 imageId、src 并回显 alt，" +
    "PNG/JPEG 可廉价识别时还返回 width/height。本工具只导入资产，不会把图片插进文档；" +
    "拿到 src 后必须另用 editDraft insertBlock 插入 <img>，并用 readDiff 核对。",
  inputSchema: z.object({
    path: z.string().min(1).refine(isAbsolute, "path 必须是沙箱内的绝对路径"),
    alt: z.string().max(500).nullable().optional().describe("图片的简短替代文本，供后续插入文档时沿用"),
  }),
  outputSchema: z.object({
    imageId: z.string().uuid(),
    src: z.string(),
    alt: z.string().max(500).nullable().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  execute: async (input, context) => {
    const stopHeartbeat = startToolHeartbeat(context, { tool: "importGeneratedImage" });
    try {
      const sessionId = context?.requestContext?.get("sessionId");
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("缺少当前会话，无法校验沙箱图片路径");
      }
      return await importGeneratedImageFromPath(input, {
        workspaceRoot: sessionWorkspaceDir(sessionId),
      });
    } finally {
      stopHeartbeat();
    }
  },
});

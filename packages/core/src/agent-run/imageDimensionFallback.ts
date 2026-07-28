import type { AiBlock, AiListItem, AiTaskListItem, BlockEdit } from "@qingagent/pm-schema";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { localUploadPath } from "@qingagent/doc-render";

const MAX_SVG_BYTES = 200 * 1024;
const DEFAULT_SVG_WIDTH = 800;
const DEFAULT_SVG_HEIGHT = 450;
const VIEWBOX_RE = /viewBox\s*=\s*["']\s*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.+-]+)[\s,]+([\d.+-]+)/i;

type MutableImageBlock = Extract<AiBlock, { type: "image" }>;
type ChildListItem = AiListItem | AiTaskListItem;

export async function fillLocalSvgImageDimensions(blockOps: BlockEdit[]): Promise<void> {
  try {
    for (const op of blockOps) {
      if (op.action === "insertBlock") {
        await fillBlocks(op.blocks);
      } else if (op.action === "replaceBlock") {
        await fillBlock(op.block);
      }
    }
  } catch {
    // 尺寸兜底不能影响正文编辑主链。
  }
}

async function fillBlocks(blocks: readonly unknown[]): Promise<void> {
  for (const block of blocks) {
    await fillBlock(block);
  }
}

async function fillBlock(block: unknown): Promise<void> {
  if (!isRecord(block)) return;
  if (isFillableImageBlock(block)) {
    // image 是叶子块(无 items/columns/children),处理完即返回;
    // 同时避免类型守卫把 block 收窄成 image 联合类型、后续访问 items/columns 报错。
    await fillImageBlock(block);
    return;
  }

  if ((block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") && Array.isArray(block.items)) {
    for (const item of block.items) {
      await fillListItem(item);
    }
  }

  if (block.type === "columnList" && Array.isArray(block.columns)) {
    for (const column of block.columns) {
      if (isRecord(column) && Array.isArray(column.blocks)) {
        await fillBlocks(column.blocks);
      }
    }
  }
}

async function fillListItem(item: unknown): Promise<void> {
  if (!isRecord(item)) return;
  const listItem = item as ChildListItem;
  if (Array.isArray(listItem.children)) {
    await fillBlocks(listItem.children);
  }
}

async function fillImageBlock(block: MutableImageBlock): Promise<void> {
  try {
    const src = block.src;
    if (!src.startsWith("/api/v1/files/")) return;
    if (extname(src).toLowerCase() !== ".svg") return;

    const path = localUploadPath(src);
    if (!path) return;

    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_SVG_BYTES) return;

    const svg = await readFile(path, "utf8");
    const dimensions = viewBoxDimensions(svg) ?? { width: DEFAULT_SVG_WIDTH, height: DEFAULT_SVG_HEIGHT };
    const width = positiveDimension(block.width);
    const height = positiveDimension(block.height);
    if (width !== null) {
      block.height = Math.max(1, Math.round(width * dimensions.height / dimensions.width));
    } else if (height !== null) {
      block.width = Math.max(1, Math.round(height * dimensions.width / dimensions.height));
    } else {
      block.width = dimensions.width;
      block.height = dimensions.height;
    }
  } catch {
    // 文件缺失、不可读或竞态删除时保持原块不变。
  }
}

function viewBoxDimensions(svg: string): { width: number; height: number } | null {
  const match = svg.match(VIEWBOX_RE);
  if (!match) return null;
  const width = Math.round(Number(match[1]));
  const height = Math.round(Number(match[2]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function isFillableImageBlock(block: unknown): block is MutableImageBlock {
  if (!isRecord(block)) return false;
  return block.type === "image" &&
    typeof block.src === "string" &&
    (positiveDimension(block.width) === null || positiveDimension(block.height) === null);
}

function positiveDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

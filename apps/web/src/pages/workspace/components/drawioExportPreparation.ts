import {
  hardenInlineSvg,
  normalizePmDoc,
  type PmDoc,
  type PmNode,
} from "@qingagent/pm-schema";
import type { Editor } from "@tiptap/react";
import { renderDrawio } from "./drawioRender";

export interface DrawioExportBlock {
  blockId: string;
  source: string;
}

export interface DrawioCachePreparationResult {
  total: number;
  rendered: number;
  failed: number;
}

export interface PrepareMissingDrawioCachesOptions {
  doc: PmDoc | null;
  render: (source: string) => Promise<string>;
  persist: (block: DrawioExportBlock, svg: string) => void | Promise<void>;
  yieldToMainThread?: () => Promise<void>;
  onProgress?: (current: number, total: number) => void;
  onRenderError?: (block: DrawioExportBlock, error: unknown) => void;
}

export function findDrawioBlocksMissingCache(doc: PmDoc | null): DrawioExportBlock[] {
  if (!doc) return [];
  const missing: DrawioExportBlock[] = [];
  const visit = (node: PmNode) => {
    if (
      node.type === "diagram"
      && node.attrs.lang === "drawio"
      && !hasUsableSvgCache(node.attrs.svg)
    ) {
      missing.push({
        blockId: node.attrs.blockId,
        source: node.attrs.source,
      });
    }
    const content = (node as { content?: readonly PmNode[] }).content;
    if (Array.isArray(content)) {
      for (const child of content) visit(child);
    }
  };
  for (const node of doc.content) visit(node);
  return missing;
}

/**
 * 导出前只编排缺缓存的 drawio。每块必须完整渲染并持久化后才处理下一块；
 * 单块失败只记录并跳过，块间主动让出一帧，避免长文档连续渲染阻塞交互。
 */
export async function prepareMissingDrawioCaches(
  options: PrepareMissingDrawioCachesOptions,
): Promise<DrawioCachePreparationResult> {
  const blocks = findDrawioBlocksMissingCache(options.doc);
  let rendered = 0;
  let failed = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    options.onProgress?.(index + 1, blocks.length);
    if (index > 0) {
      // 先更新下一块进度，再让浏览器完成一帧，确保文案在同步渲染前可见。
      await (options.yieldToMainThread ?? yieldBrowserFrame)();
    }
    try {
      const svg = await options.render(block.source);
      await options.persist(block, svg);
      rendered += 1;
    } catch (error) {
      failed += 1;
      options.onRenderError?.(block, error);
    }
  }

  return { total: blocks.length, rendered, failed };
}

export async function prepareEditorDrawioCaches(
  editor: Editor,
  options: {
    onProgress?: (current: number, total: number) => void;
    onRenderError?: (block: DrawioExportBlock, error: unknown) => void;
  } = {},
): Promise<DrawioCachePreparationResult> {
  if (editor.isDestroyed) return { total: 0, rendered: 0, failed: 0 };
  const doc = normalizePmDoc(editor.getJSON());
  return prepareMissingDrawioCaches({
    doc,
    render: renderDrawio,
    persist: (block, svg) => {
      persistDrawioCache(editor, block, svg);
    },
    onProgress: options.onProgress,
    onRenderError: options.onRenderError,
  });
}

function hasUsableSvgCache(svg: unknown): boolean {
  return typeof svg === "string" && hardenInlineSvg(svg) !== null;
}

function persistDrawioCache(
  editor: Editor,
  block: DrawioExportBlock,
  svg: string,
): void {
  if (editor.isDestroyed) return;
  const safeSvg = hardenInlineSvg(svg);
  if (!safeSvg) throw new Error("drawio SVG 安全校验失败");

  let targetPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === "diagram"
      && node.attrs.lang === "drawio"
      && node.attrs.blockId === block.blockId
      && node.attrs.source === block.source
    ) {
      targetPos = pos;
      return false;
    }
    return true;
  });
  if (targetPos === null) return;

  const currentNode = editor.state.doc.nodeAt(targetPos);
  if (!currentNode || hasUsableSvgCache(currentNode.attrs.svg)) return;
  const transaction = editor.state.tr.setNodeMarkup(targetPos, undefined, {
    ...currentNode.attrs,
    svg: safeSvg,
  });
  // 与正常图表视图补缓存一致：缓存写入不进入用户撤销历史。
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
}

function yieldBrowserFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

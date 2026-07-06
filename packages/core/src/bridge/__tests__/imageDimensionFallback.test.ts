import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyBlockEdits,
  type BlockEdit,
  type PmBlockNode,
  type PmDoc,
  type PmNode,
} from "@qingagent/pm-schema";
import { uploadsBaseDir } from "../../workspace/uploadsDir.js";
import { fillLocalSvgImageDimensions } from "../imageDimensionFallback.js";

const SVG_ID = "550e8400-e29b-41d4-a716-446655440000";
const MISSING_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEXT_ID = "550e8400-e29b-41d4-a716-446655440002";
const NESTED_ID = "550e8400-e29b-41d4-a716-446655440003";

describe("fillLocalSvgImageDimensions", () => {
  let tmpUploads: string;
  let previousUploadsDir: string | undefined;

  beforeEach(async () => {
    previousUploadsDir = process.env.QINGAGENT_UPLOADS_DIR;
    tmpUploads = await mkdtemp(join(tmpdir(), "qingagent-uploads-"));
    process.env.QINGAGENT_UPLOADS_DIR = tmpUploads;
  });

  afterEach(async () => {
    if (previousUploadsDir === undefined) {
      delete process.env.QINGAGENT_UPLOADS_DIR;
    } else {
      process.env.QINGAGENT_UPLOADS_DIR = previousUploadsDir;
    }
    await rm(tmpUploads, { recursive: true, force: true });
  });

  it("insertBlock 的本地 SVG image 缺尺寸时,从 viewBox 回填到应用后的 PM attrs", async () => {
    await writeUpload(SVG_ID, "illustration.svg", '<svg viewBox="0 0 640 360"><rect width="640" height="360"/></svg>');
    const ops: BlockEdit[] = [{
      action: "insertBlock",
      position: "end",
      blocks: [{
        type: "image",
        src: `/api/v1/files/${SVG_ID}/illustration.svg`,
        alt: "插图",
      }],
    }];

    await fillLocalSvgImageDimensions(ops);
    const result = applyBlockEdits(docWithParagraph(), ops);

    expect(result.ok).toBe(true);
    expect(collectImages(result.doc!)[0]?.attrs).toMatchObject({ width: 640, height: 360 });
  });

  it("src 含路径穿越时不读文件,块保持无尺寸", async () => {
    const block = {
      type: "image",
      src: `/api/v1/files/${SVG_ID}/../secret.svg`,
      alt: "非法路径",
    };
    const ops: BlockEdit[] = [{ action: "insertBlock", position: "end", blocks: [block] }];

    await fillLocalSvgImageDimensions(ops);

    expect(block).not.toHaveProperty("width");
    expect(block).not.toHaveProperty("height");
  });

  it("文件不存在时静默跳过,helper 不给 block 补尺寸且不影响应用", async () => {
    const block = {
      type: "image",
      src: `/api/v1/files/${MISSING_ID}/missing.svg`,
      alt: "缺失文件",
    };
    const ops: BlockEdit[] = [{ action: "insertBlock", position: "end", blocks: [block] }];

    await fillLocalSvgImageDimensions(ops);
    // helper 契约:缺文件时静默,不给 block 加 width/height(直接断言 block,不耦合 aiIrToPm 缺省行为)。
    expect(block).not.toHaveProperty("width");
    expect(block).not.toHaveProperty("height");
    // 块照常能应用。
    expect(applyBlockEdits(docWithParagraph(), ops).ok).toBe(true);
  });

  it("非 svg 后缀跳过,helper 不给 block 补尺寸", async () => {
    await writeUpload(TEXT_ID, "note.txt", '<svg viewBox="0 0 640 360"></svg>');
    const block = {
      type: "image",
      src: `/api/v1/files/${TEXT_ID}/note.txt`,
      alt: "文本文件",
    };
    const ops: BlockEdit[] = [{ action: "insertBlock", position: "end", blocks: [block] }];

    await fillLocalSvgImageDimensions(ops);
    expect(block).not.toHaveProperty("width");
    expect(block).not.toHaveProperty("height");
    expect(applyBlockEdits(docWithParagraph(), ops).ok).toBe(true);
  });

  it("replaceBlock 内的 columnList 嵌套 image 也会递归回填尺寸", async () => {
    await writeUpload(NESTED_ID, "nested.svg", '<svg viewBox="0 0 320 180"><rect width="320" height="180"/></svg>');
    const ops: BlockEdit[] = [{
      action: "replaceBlock",
      ref: "block-a",
      block: {
        type: "columnList",
        columns: [
          {
            widthRatio: 0.5,
            blocks: [{ type: "paragraph", runs: [{ text: "左栏" }] }],
          },
          {
            widthRatio: 0.5,
            blocks: [{
              type: "image",
              src: `/api/v1/files/${NESTED_ID}/nested.svg`,
              alt: "嵌套图",
            }],
          },
        ],
      },
    }];

    await fillLocalSvgImageDimensions(ops);
    const result = applyBlockEdits(docWithParagraph(), ops);

    expect(result.ok).toBe(true);
    expect(collectImages(result.doc!)[0]?.attrs).toMatchObject({ width: 320, height: 180 });
  });
});

async function writeUpload(id: string, filename: string, content: string): Promise<void> {
  const dir = join(uploadsBaseDir(), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf8");
}

function docWithParagraph(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "block-a" },
      content: [{ type: "text", text: "正文" }],
    }],
  };
}

function collectImages(doc: PmDoc): Extract<PmBlockNode, { type: "image" }>[] {
  const images: Extract<PmBlockNode, { type: "image" }>[] = [];
  const visit = (node: PmNode) => {
    if (node.type === "image") images.push(node as Extract<PmBlockNode, { type: "image" }>);
    if ("content" in node && Array.isArray(node.content)) {
      node.content.forEach(visit);
    }
  };
  doc.content.forEach(visit);
  return images;
}

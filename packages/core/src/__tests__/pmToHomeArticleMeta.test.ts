import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { pmToHomeArticleMeta } from "../home/pmToHomeArticleMeta.js";

const imageUrl = "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png";

function docWithImage(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "heading",
        attrs: { blockId: "h-1", level: 2 },
        content: [{ type: "text", text: "首页标题" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text: "这是一段用于首页摘要的正文。" }],
      },
      {
        type: "image",
        attrs: { blockId: "img-1", src: imageUrl, alt: "配图", caption: "图 1" },
      },
    ],
  };
}

function docWithoutImage(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text: "无图正文" }],
      },
    ],
  };
}

function docWithColumnImage(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "columnList",
        attrs: { blockId: "columns-home" },
        content: [
          {
            type: "column",
            attrs: { blockId: "column-home-left", widthRatio: 0.5 },
            content: [{
              type: "paragraph",
              attrs: { blockId: "column-home-p" },
              content: [{ type: "text", text: "左栏正文" }],
            }],
          },
          {
            type: "column",
            attrs: { blockId: "column-home-right", widthRatio: 0.5 },
            content: [{
              type: "image",
              attrs: { blockId: "column-home-img", src: imageUrl, alt: "分栏配图", caption: "分栏图" },
            }],
          },
        ],
      },
    ],
  };
}

function docWithTaskListImage(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "taskList",
      attrs: { blockId: "tasks-home" },
      content: [{
        type: "taskItem",
        attrs: { blockId: "task-home-1", checked: false },
        content: [{
          type: "image",
          attrs: { blockId: "task-home-img", src: imageUrl, alt: "任务配图" },
        }],
      }],
    }],
  };
}

function docWithNonFileImageBeforeLocal(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "blockquote",
      attrs: { blockId: "quote-home" },
      content: [
        {
          type: "image",
          attrs: { blockId: "preview-home-img", src: "/preview/generated.svg", alt: "非文件预览图" },
        },
        {
          type: "image",
          attrs: { blockId: "file-home-img", src: imageUrl, alt: "本地文件图" },
        },
      ],
    }],
  };
}

function template(id: string, requiresImage: boolean, dynamicImage: boolean, weight = 1) {
  return {
    id,
    name: id,
    version: 1,
    width: 290,
    height: 360,
    elements: [
      {
        id: "title",
        type: "text",
        role: "title",
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        fontSize: 24,
        color: "#111",
        direction: "horizontal",
        maxLines: 2,
      },
      ...(dynamicImage
        ? [{
            id: "image",
            type: "image" as const,
            source: "dynamic" as const,
            x: 0,
            y: 80,
            width: 200,
            height: 120,
            shape: "rectangle" as const,
          }]
        : []),
    ],
    meta: {
      category: "long",
      tags: [],
      requiresImage,
      preferVerticalText: false,
      weight,
    },
  } as const;
}

describe("pmToHomeArticleMeta", () => {
  it("derives title, description, and first PM imageUrl", () => {
    expect(pmToHomeArticleMeta(docWithImage(), { fallbackTitle: "回退标题" })).toMatchObject({
      title: "首页标题",
      description: "首页标题 这是一段用于首页摘要的正文。 图 1",
      imageUrl,
    });

    expect(pmToHomeArticleMeta(docWithoutImage(), { fallbackTitle: "回退标题" })).toMatchObject({
      title: "回退标题",
      imageUrl: null,
    });
  });

  it("recurses into columnList when deriving the first PM imageUrl", () => {
    expect(pmToHomeArticleMeta(docWithColumnImage(), { fallbackTitle: "分栏" })).toMatchObject({
      imageUrl,
      description: "左栏正文 分栏图",
    });
  });

  it("遍历任务列表，并跳过容器内不合格图片继续寻找本地文件图", () => {
    expect(pmToHomeArticleMeta(docWithTaskListImage())).toMatchObject({ imageUrl });
    expect(pmToHomeArticleMeta(docWithNonFileImageBeforeLocal())).toMatchObject({ imageUrl });
  });

  it("feeds imageUrl into masonry selector requiresImage and dynamic image scores", async () => {
    const masonryBundlePath = "../../../../apps/web/src/system/chinese-masonry/index.ts";
    const { TemplateRegistry, createTemplateSelector } = await import(masonryBundlePath) as {
      TemplateRegistry: new () => { register: (template: unknown) => void };
      createTemplateSelector: (registry: unknown, options: { random: () => number }) => {
        score: (article: Record<string, unknown>, template: unknown) => number;
      };
    };
    const registry = new TemplateRegistry();
    const plain = template("plain", false, false, 1);
    const dynamic = template("dynamic", true, true, 1);
    registry.register(plain);
    registry.register(dynamic);
    const selector = createTemplateSelector(registry, { random: () => 0 });
    const meta = pmToHomeArticleMeta(docWithImage(), { category: "long", tags: ["pm"] });
    const article = {
      id: "doc-1",
      title: meta.title,
      description: meta.description,
      imageUrl: meta.imageUrl ?? undefined,
      category: meta.category,
      tags: meta.tags,
    };

    expect(selector.score({ ...article, imageUrl: undefined }, dynamic)).toBe(0);
    expect(selector.score(article, dynamic)).toBeGreaterThan(selector.score(article, plain));
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import {
  findDrawioBlocksMissingCache,
  prepareMissingDrawioCaches,
} from "./drawioExportPreparation";

describe("drawio 导出前缓存补渲染编排", () => {
  it("递归枚举无缓存或缓存无效的 drawio，跳过有效缓存与 Mermaid", () => {
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        diagram("missing", "drawio", "source-missing", null),
        diagram("invalid", "drawio", "source-invalid", "not svg"),
        diagram("truncated", "drawio", "source-truncated", "<svg><g>"),
        diagram(
          "doctype",
          "drawio",
          "source-doctype",
          '<!DOCTYPE svg [<!ENTITY x "y">]><svg><text>&x;</text></svg>',
        ),
        diagram("cached", "drawio", "source-cached", '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
        diagram("mermaid", "mermaid", "flowchart TD\nA-->B", null),
        {
          type: "columnList",
          attrs: { blockId: "columns" },
          content: [
            {
              type: "column",
              attrs: { blockId: "column", widthRatio: 1 },
              content: [diagram("nested", "drawio", "source-nested", undefined)],
            },
          ],
        },
      ],
    } as unknown as PmDoc;

    expect(findDrawioBlocksMissingCache(doc)).toEqual([
      { blockId: "missing", source: "source-missing" },
      { blockId: "invalid", source: "source-invalid" },
      { blockId: "truncated", source: "source-truncated" },
      { blockId: "doctype", source: "source-doctype" },
      { blockId: "nested", source: "source-nested" },
    ]);
  });

  it("全部已有有效缓存时不调用渲染、持久化或让帧", async () => {
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        diagram("cached", "drawio", "source-cached", '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
      ],
    } as unknown as PmDoc;
    const render = vi.fn(async () => "<svg/>");
    const persist = vi.fn();
    const yieldToMainThread = vi.fn(async () => undefined);

    await expect(prepareMissingDrawioCaches({
      doc,
      render,
      persist,
      yieldToMainThread,
    })).resolves.toEqual({ total: 0, rendered: 0, failed: 0 });
    expect(render).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(yieldToMainThread).not.toHaveBeenCalled();
  });

  it("逐块串行渲染并在块间让帧，单块失败后继续且持续上报进度", async () => {
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        diagram("first", "drawio", "source-first", null),
        diagram("broken", "drawio", "source-broken", null),
        diagram("last", "drawio", "source-last", null),
      ],
    } as unknown as PmDoc;
    const events: string[] = [];
    let activeRenders = 0;
    let maxActiveRenders = 0;
    const render = vi.fn(async (source: string) => {
      events.push(`render:${source}`);
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      await Promise.resolve();
      activeRenders -= 1;
      if (source === "source-broken") throw new Error("坏图");
      return `<svg data-source="${source}"/>`;
    });
    const persist = vi.fn(async (block: { blockId: string }, svg: string) => {
      events.push(`persist:${block.blockId}:${svg}`);
    });
    const yieldToMainThread = vi.fn(async () => {
      events.push("yield");
    });
    const onProgress = vi.fn((current: number, total: number) => {
      events.push(`progress:${current}/${total}`);
    });
    const onRenderError = vi.fn((block: { blockId: string }) => {
      events.push(`error:${block.blockId}`);
    });

    const result = await prepareMissingDrawioCaches({
      doc,
      render,
      persist,
      yieldToMainThread,
      onProgress,
      onRenderError,
    });

    expect(maxActiveRenders).toBe(1);
    expect(events).toEqual([
      "progress:1/3",
      "render:source-first",
      'persist:first:<svg data-source="source-first"/>',
      "progress:2/3",
      "yield",
      "render:source-broken",
      "error:broken",
      "progress:3/3",
      "yield",
      "render:source-last",
      'persist:last:<svg data-source="source-last"/>',
    ]);
    expect(result).toEqual({ total: 3, rendered: 2, failed: 1 });
    expect(yieldToMainThread).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

function diagram(
  blockId: string,
  lang: "drawio" | "mermaid",
  source: string,
  svg: string | null | undefined,
) {
  return {
    type: "diagram",
    attrs: { blockId, lang, source, svg },
  };
}

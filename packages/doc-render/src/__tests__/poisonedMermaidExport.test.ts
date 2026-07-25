import type { PmDoc } from "@qingagent/pm-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderedDiagrams } from "../export/mermaidServer.js";

const { getBrowserMock, withBrowserContextSlotMock } = vi.hoisted(() => ({
  getBrowserMock: vi.fn(),
  withBrowserContextSlotMock: vi.fn(
    async (run: () => Promise<unknown>) => run(),
  ),
}));

vi.mock("../browser/pool.js", () => ({
  getBrowser: getBrowserMock,
  withBrowserContextSlot: withBrowserContextSlotMock,
}));

const SOURCE = "flowchart TD\n  A[开始] --> B[结束]";
const POISONED_SVG = '<svg viewBox="0 0 120 60"><rect width="120" height="60"/></svg>';
const FRESH_SVG = '<svg viewBox="0 0 120 60"><text x="10" y="30">开始 → 结束</text></svg>';

function mermaidDoc(svg: string | null): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "diagram",
      attrs: { blockId: "mermaid-1", lang: "mermaid", source: SOURCE, svg },
    }],
  };
}

function installFakeMermaidServer(): { render: ReturnType<typeof vi.fn> } {
  const mermaid = {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: FRESH_SVG })),
  };
  getBrowserMock.mockResolvedValue({
    newContext: vi.fn(async () => ({
      addInitScript: vi.fn(),
      route: vi.fn(),
      newPage: vi.fn(async () => ({
        setContent: vi.fn(),
        addScriptTag: vi.fn(),
        evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => {
          const previous = (globalThis as { mermaid?: typeof mermaid }).mermaid;
          (globalThis as { mermaid?: typeof mermaid }).mermaid = mermaid;
          try {
            return await fn(arg);
          } finally {
            (globalThis as { mermaid?: typeof mermaid }).mermaid = previous;
          }
        }),
      })),
      close: vi.fn(async () => undefined),
    })),
  });
  return mermaid;
}

beforeEach(() => {
  getBrowserMock.mockReset();
  withBrowserContextSlotMock.mockClear();
});

describe("Mermaid 无文字毒缓存导出自愈", () => {
  it("可渲染但无 text 的 Mermaid 缓存仍走服务端补渲染", async () => {
    const mermaid = installFakeMermaidServer();
    const input = mermaidDoc(POISONED_SVG);

    const prepared = await withRenderedDiagrams(input) as PmDoc;
    const block = prepared.content[0];

    expect(getBrowserMock).toHaveBeenCalledOnce();
    expect(withBrowserContextSlotMock).toHaveBeenCalledOnce();
    expect(mermaid.render).toHaveBeenCalledWith("exp-0", SOURCE);
    expect(block?.type === "diagram" ? block.attrs.svg : null).toBe(FRESH_SVG);
    expect(input.content[0]?.type === "diagram" ? input.content[0].attrs.svg : null).toBe(POISONED_SVG);
  });

  it("已有原生 text 的 Mermaid 缓存不重复服务端渲染", async () => {
    const input = mermaidDoc(FRESH_SVG);

    const prepared = await withRenderedDiagrams(input) as PmDoc;

    expect(getBrowserMock).not.toHaveBeenCalled();
    expect(withBrowserContextSlotMock).not.toHaveBeenCalled();
    expect(prepared.content[0]?.type === "diagram" ? prepared.content[0].attrs.svg : null).toBe(FRESH_SVG);
  });
});

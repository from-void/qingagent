import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDiagramSvgs, withRenderedDiagrams } from "../export/mermaidServer.js";
import { toHtml } from "../export/toHtml.js";
import { setDocRenderLogger } from "../renderLogger.js";
import { hasChromium } from "./browserTestGate.js";

const getBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("../browser/pool.js", () => ({
  getBrowser: getBrowserMock,
  withBrowserContextSlot: async (run: () => Promise<unknown>) => run(),
}));

type FakeMermaid = {
  initialize: ReturnType<typeof vi.fn>;
  parse: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
};

function installFakeBrowser(mermaid: FakeMermaid): void {
  getBrowserMock.mockResolvedValue({
    newContext: async () => ({
      // __name 兜底 initScript(回归 mermaid-export-__name):fake 页与测试同 realm,
      // 无需真执行;真实序列化路径由下方 tsx 子进程回归测试覆盖。
      addInitScript: vi.fn(),
      route: vi.fn(),
      newPage: async () => ({
        setContent: vi.fn(),
        addScriptTag: vi.fn(),
        evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
          const previous = (globalThis as { mermaid?: FakeMermaid }).mermaid;
          (globalThis as { mermaid?: FakeMermaid }).mermaid = mermaid;
          try {
            return await fn(arg);
          } finally {
            (globalThis as { mermaid?: FakeMermaid }).mermaid = previous;
          }
        },
      }),
      close: vi.fn(async () => undefined),
    }),
  });
}

beforeEach(() => {
  getBrowserMock.mockReset();
  setDocRenderLogger(console);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mermaidServer 引号 normalization", () => {
  it("原文 parse 失败后用弯/全角引号 normalization 重试并渲染 SVG", async () => {
    const parsedSources: string[] = [];
    const renderedSources: string[] = [];
    const mermaid: FakeMermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async (source: string) => {
        parsedSources.push(source);
        return !/[“”＂]/.test(source);
      }),
      render: vi.fn(async (_id: string, source: string) => {
        renderedSources.push(source);
        return { svg: `<svg data-source="${source.replaceAll('"', "&quot;")}"></svg>` };
      }),
    };
    installFakeBrowser(mermaid);

    const raw = "flowchart TD\n  A[“完成”] --> B[＂结束＂]";
    const [svg] = await renderDiagramSvgs([raw]);

    expect(svg).toContain("<svg");
    expect(parsedSources).toEqual([
      raw,
      'flowchart TD\n  A["完成"] --> B["结束"]',
    ]);
    expect(renderedSources).toEqual(['flowchart TD\n  A["完成"] --> B["结束"]']);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: "sans-serif",
      htmlLabels: false,
    }));
  });

  it("非法 Mermaid 即使带 overlay 也保留源码回退，不导出自研布局的残缺 SVG", async () => {
    const source = "flowchart TD\n  A --> B\n  C[未闭合";
    const mermaid: FakeMermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async () => false),
      render: vi.fn(),
    };
    installFakeBrowser(mermaid);
    const document = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-invalid-overlay",
          lang: "mermaid",
          source,
          svg: null,
          overlay: { positions: { A: { x: 120, y: 80 } } },
        },
      }],
    } as unknown as PmDoc;

    const prepared = await withRenderedDiagrams(document) as PmDoc;
    const diagram = prepared.content[0] as { attrs: { svg: string | null } };
    expect(diagram.attrs.svg).toBeNull();
    expect(mermaid.parse).toHaveBeenCalledWith(source, { suppressErrors: true });
    expect(mermaid.render).not.toHaveBeenCalled();

    const html = toHtml(prepared);
    expect(html).toContain("code-block");
    expect(html).toContain("C[未闭合");
    expect(html).not.toContain('<div class="pm-diagram">');
  });

  it("合法 flowchart/sequence 原文 parse 成功时不改写引号正文", async () => {
    const renderedSources: string[] = [];
    const mermaid: FakeMermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async () => true),
      render: vi.fn(async (_id: string, source: string) => {
        renderedSources.push(source);
        return { svg: `<svg>${source}</svg>` };
      }),
    };
    installFakeBrowser(mermaid);

    const flowchart = "flowchart TD\n  A[«书名»] --> B[结束]";
    const sequence = "sequenceDiagram\n  participant A as “甲方”\n  A->>B: “你好”";
    const svgs = await renderDiagramSvgs([flowchart, sequence]);

    expect(svgs).toHaveLength(2);
    expect(renderedSources).toEqual([flowchart, sequence]);
  });

  it("真失败时返回 null 并记录 warn，包含原因、图型和源码摘要", async () => {
    const warn = vi.fn();
    setDocRenderLogger({ warn });
    const mermaid: FakeMermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async () => false),
      render: vi.fn(),
    };
    installFakeBrowser(mermaid);

    const [svg] = await renderDiagramSvgs(["flowchart TD\n  A[“坏图” -- B"]);

    expect(svg).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Mermaid server render failed; export will fall back to source",
      expect.objectContaining({
        diagramType: "flowchart",
        reason: expect.stringContaining("quote normalization"),
        sourceSummary: expect.stringContaining("A[“坏图” -- B"),
      }),
    );
  });
});

describe("mermaid 渲染在 tsx 运行时下的序列化健壮性", () => {
  // 回归(lane-C-r2·9ab2eeee 引入):tsx(esbuild keepNames)把 evaluate 回调里的
  // `const parseMermaid = async …` 包成 __name(fn,"parseMermaid");Playwright 把回调
  // toString 序列化进浏览器后 __name helper 不存在 → ReferenceError → 全部图表静默
  // 回退源码。vitest 转换不开 keepNames、且上面的 fake evaluate 在进程内直调回调,
  // 都复现不了这条脏路径——必须真跑 tsx 子进程 + 真 Chromium 序列化执行。
  it.skipIf(!hasChromium)(
    "evaluate 回调经 tsx(keepNames)序列化后仍能渲染(回归 __name ReferenceError 全量回退源码)",
    () => {
      const tsxBin = fileURLToPath(
        new URL("../../../server/node_modules/.bin/tsx", import.meta.url),
      );
      const fixture = fileURLToPath(new URL("./fixtures/mermaid-tsx-smoke.ts", import.meta.url));
      const res = spawnSync(tsxBin, [fixture], { encoding: "utf8", timeout: 120_000 });
      const lastLine = res.stdout.trim().split("\n").at(-1) ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        throw new Error(
          `fixture 输出不可解析。stdout 尾部: ${res.stdout.slice(-400)} | stderr 尾部: ${res.stderr.slice(-400)}`,
        );
      }
      expect(parsed).toMatchObject({ ok: true });
    },
    150_000,
  );
});

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { graphToSvg, type DiagramOverlay } from "@qingagent/diagram-engine";
import {
  isPoisonedMermaidSvg,
  normalizeMermaidQuotes,
  prepareDrawioModelXmlForRender,
} from "@qingagent/pm-schema";
import { getBrowser } from "../browser/pool.js";
import { getDocRenderLogger } from "../renderLogger.js";
import {
  ExportBusyError,
  ExportDeadlineExceededError,
  withExportSlot,
  type ExportRunContext,
  type ExportSlotOptions,
} from "./exportSlot.js";
import { isRenderableSvg, type ExportDocument } from "./shared.js";

/**
 * 服务端渲染 mermaid 源码 → SVG(供导出用)。
 *
 * 背景:图表块的 svg 是可持久化缓存，但 agent 新生成内容、旧数据或异常中断仍可能没有缓存。
 * Mermaid 可在服务端安全补渲染；drawio 按 W4 设计只消费客户端加固后持久化的 SVG，缺失时
 * 明确告警并回退源码，不在导出进程里另起一套 mxGraph XML 执行面。
 *
 * 这里复用 browser/pool 的 Chromium,加载与前端同版本的 mermaid bundle,用同款暖墨主题 + strict
 * 安全级,把源码渲染成 SVG,让导出(PDF / HTML)拿到与前端一致的图表。
 */

// 与前端 mermaidRender.ts 的 WARM_THEME_VARS 保持一致(暖墨纸面配色)。
const WARM_THEME_VARS = {
  background: "#faf6ec",
  textColor: "#2f2a22",
  primaryColor: "#efe3cc",
  primaryTextColor: "#2f2a22",
  primaryBorderColor: "#b08a3e",
  secondaryColor: "#e3d3b0",
  secondaryTextColor: "#2f2a22",
  secondaryBorderColor: "#b3a07a",
  tertiaryColor: "#f5ecda",
  tertiaryTextColor: "#2f2a22",
  tertiaryBorderColor: "#cdbfa3",
  lineColor: "#9c8552",
  mainBkg: "#efe3cc",
  nodeBorder: "#b08a3e",
  clusterBkg: "#f3ecdd",
  clusterBorder: "#cdbfa3",
  titleColor: "#5c5346",
  edgeLabelBackground: "#faf6ec",
  noteBkgColor: "#fbf3e2",
  noteBorderColor: "#cdbfa3",
  noteTextColor: "#2f2a22",
  actorBkg: "#efe3cc",
  actorBorder: "#b08a3e",
  actorTextColor: "#2f2a22",
  signalColor: "#7a6a48",
  signalTextColor: "#2f2a22",
  cScale0: "#efe3cc",
  cScale1: "#dcc39a",
  cScale2: "#c9a86f",
  cScale3: "#e8d5b0",
  cScale4: "#d4b886",
  cScale5: "#bfa471",
  cScaleLabel0: "#2f2a22",
  cScaleLabel1: "#2f2a22",
  cScaleLabel2: "#2f2a22",
  cScaleLabel3: "#2f2a22",
  cScaleLabel4: "#2f2a22",
  cScaleLabel5: "#2f2a22",
};
// 导出 SVG 会脱离宿主文档单独栅格化；与已验证的 generateSvg 路径一致，交给系统
// sans-serif 做中文字体回退，避免依赖 Google Fonts 的家族名。
const DIAGRAM_FONT = "sans-serif";
interface MermaidRenderInput {
  source: string;
  normalizedSource: string;
  diagramType: string;
  sourceSummary: string;
}

interface MermaidRenderResult {
  svg: string | null;
  reason?: string;
}

let cachedBundle: string | null = null;
function loadMermaidBundle(): string {
  if (cachedBundle !== null) return cachedBundle;
  const require = createRequire(import.meta.url);
  const path = require.resolve("mermaid/dist/mermaid.min.js");
  cachedBundle = readFileSync(path, "utf8");
  return cachedBundle;
}

function diagramTypeOf(source: string): string {
  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"));
  return firstLine?.split(/\s+/)[0] ?? "unknown";
}

function summarizeMermaidSource(source: string): string {
  const normalized = source.trim().replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function renderInputForSource(source: string): MermaidRenderInput {
  return {
    source,
    normalizedSource: normalizeMermaidQuotes(source),
    diagramType: diagramTypeOf(source),
    sourceSummary: summarizeMermaidSource(source),
  };
}

function warnMermaidRenderFailure(input: MermaidRenderInput, reason: string): void {
  getDocRenderLogger().warn("Mermaid server render failed; export will fall back to source", {
    reason,
    diagramType: input.diagramType,
    sourceSummary: input.sourceSummary,
  });
}

function isExportOperationalError(error: unknown): boolean {
  return (
    error instanceof ExportBusyError ||
    error instanceof ExportDeadlineExceededError ||
    (typeof error === "object" &&
      error !== null &&
      ((error as { code?: unknown }).code === "EXPORT_BUSY" ||
        (error as { code?: unknown }).code === "EXPORT_DEADLINE_EXCEEDED"))
  );
}

function warnMermaidExportAbort(input: MermaidRenderInput, error: unknown): void {
  getDocRenderLogger().warn("Mermaid server render aborted; export will return a diagnosable error", {
    code:
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined,
    reason: error instanceof Error ? error.message : String(error),
    diagramType: input.diagramType,
    sourceSummary: input.sourceSummary,
  });
}

/**
 * 批量把 mermaid 源码渲染成 SVG。返回与输入等长的数组,单个失败处为 null(调用方回退源码)。
 * 一次性在同一个 Chromium 页里渲染所有图,减少开销。
 */
export async function renderDiagramSvgs(
  sources: readonly string[],
  slotOptions: ExportSlotOptions = {},
): Promise<(string | null)[]> {
  if (sources.length === 0) return [];
  const inputs = sources.map(renderInputForSource);
  try {
    return await withExportSlot(
      (context) => renderDiagramSvgsInSlot(inputs, context),
      slotOptions,
    );
  } catch (error) {
    if (isExportOperationalError(error)) {
      for (const input of inputs) warnMermaidExportAbort(input, error);
      throw error;
    }
    for (const input of inputs) {
      warnMermaidRenderFailure(
        input,
        error instanceof Error ? error.message : "Mermaid server render failed",
      );
    }
    return sources.map(() => null);
  }
}

async function renderDiagramSvgsInSlot(
  inputs: readonly MermaidRenderInput[],
  exportContext: ExportRunContext,
): Promise<(string | null)[]> {
  let browser;
  try {
    browser = await getBrowser();
    exportContext.signal.throwIfAborted();
  } catch (error) {
    if (exportContext.signal.aborted) throw exportContext.signal.reason ?? error;
    // 无 Chromium → 全部回退(调用方据此让图表退回源码),不让 docx/导出整体崩。
    for (const input of inputs) {
      warnMermaidRenderFailure(
        input,
        error instanceof Error ? `Chromium unavailable: ${error.message}` : "Chromium unavailable",
      );
    }
    return inputs.map(() => null);
  }
  const context = await browser.newContext();
  const closeOnAbort = () => {
    void context.close().catch(() => undefined);
  };
  exportContext.signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    // tsx/esbuild(keepNames)会把下方 evaluate 回调里的 `const parseMermaid = async …` 包成
    // __name(fn,"parseMermaid");回调经 toString 序列化进浏览器后 __name helper 不存在 →
    // ReferenceError → 全部图表静默回退源码(9ab2eeee 引入;dev 与生产都是 tsx 直跑 src,必中)。
    // 与 scrapeWithBrowser 同款兜底:页面 realm 先补一个恒等 __name。
    await context.addInitScript(() => {
      (globalThis as unknown as { __name?: (fn: unknown) => unknown }).__name ||= (fn) => fn;
    });
    // 自包含渲染,拦截一切外部请求(防 SSRF + 提速)。
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") void route.continue();
      else void route.abort();
    });
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>", {
      waitUntil: "load",
      timeout: Math.min(30_000, exportContext.remainingMs()),
    });
    await page.addScriptTag({ content: loadMermaidBundle() });
    exportContext.signal.throwIfAborted();
    const results = (await page.evaluate(
      async ({ items, theme, fontFamily }) => {
        const mermaid = (globalThis as unknown as { mermaid: any }).mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: theme,
          fontFamily,
          // Mermaid 11 默认把流程图节点标签写成 foreignObject + HTML span；
          // 导出安全净化必须删除 foreignObject，旧链路因而只剩框线。强制生成原生
          // SVG text/tspan，让标签既能通过 hardenInlineSvg，也能被 Chromium 栅格化。
          htmlLabels: false,
        });
        const parseMermaid = async (source: string): Promise<{ ok: boolean; reason?: string }> => {
          try {
            if (typeof mermaid.parse === "function") {
              const ok = await mermaid.parse(source, { suppressErrors: true });
              if (ok === false) return { ok: false, reason: "Mermaid parse failed" };
            }
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const out: MermaidRenderResult[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          let source = item.source;
          const originalParse = await parseMermaid(source);
          if (!originalParse.ok) {
            if (item.normalizedSource !== item.source) {
              const normalizedParse = await parseMermaid(item.normalizedSource);
              if (normalizedParse.ok) {
                source = item.normalizedSource;
              } else {
                out.push({
                  svg: null,
                  reason: `Mermaid parse failed after quote normalization: ${normalizedParse.reason ?? originalParse.reason ?? "unknown error"}`,
                });
                continue;
              }
            } else {
              out.push({ svg: null, reason: originalParse.reason ?? "Mermaid parse failed" });
              continue;
            }
          }
          try {
            const { svg } = await mermaid.render(`exp-${i}`, source);
            out.push(
              typeof svg === "string"
                ? { svg }
                : { svg: null, reason: "Mermaid render returned empty SVG" },
            );
          } catch (error) {
            out.push({
              svg: null,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return out;
      },
      { items: inputs, theme: WARM_THEME_VARS, fontFamily: DIAGRAM_FONT },
    )) as MermaidRenderResult[];
    results.forEach((result, index) => {
      if (!result.svg) {
        warnMermaidRenderFailure(
          inputs[index]!,
          result.reason ?? "Mermaid render returned null SVG",
        );
      }
    });
    return results.map((result) => result.svg);
  } catch (error) {
    if (exportContext.signal.aborted) throw exportContext.signal.reason ?? error;
    // 整体渲染失败(mermaid 加载异常等)→ 全部回退,绝不让图表毁掉导出。
    for (const input of inputs) {
      warnMermaidRenderFailure(
        input,
        error instanceof Error ? error.message : "Mermaid server render failed",
      );
    }
    return inputs.map(() => null);
  } finally {
    exportContext.signal.removeEventListener("abort", closeOnAbort);
    await context.close().catch(() => undefined);
  }
}

interface DiagramRef {
  lang: "mermaid" | "drawio";
  source: string;
  overlay?: DiagramOverlay | null;
  assign: (svg: string) => void;
  assignSource: (source: string) => void;
}

/** 递归收集文档里所有"有源码但缺可用 svg"的图表节点(PmDoc 节点 + Legacy 段都覆盖)。 */
function collectDiagrams(value: unknown, acc: DiagramRef[]): void {
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;

  // PmDoc 图表节点:{ type: "diagram", attrs: { source, svg } }
  if (obj.type === "diagram" && obj.attrs && typeof obj.attrs === "object") {
    const attrs = obj.attrs as Record<string, unknown>;
    const source = typeof attrs.source === "string" ? attrs.source : "";
    const lang = attrs.lang === "drawio" ? "drawio" : "mermaid";
    const svg = attrs.svg as string | null;
    const hasUsableCache = isRenderableSvg(svg)
      && (lang === "drawio" || !isPoisonedMermaidSvg(svg, source));
    if (source.trim() && !hasUsableCache) {
      acc.push({
        lang,
        source,
        overlay: readOverlay(attrs.overlay),
        assign: (svg) => { attrs.svg = svg; },
        assignSource: (source) => { attrs.source = source; },
      });
    }
  }
  // Legacy 段:{ kind: "diagram", data: { source, svg } }
  if (obj.kind === "diagram" && obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>;
    const source = typeof data.source === "string" ? data.source : "";
    const lang = data.lang === "drawio" ? "drawio" : "mermaid";
    const svg = data.svg as string | null;
    const hasUsableCache = isRenderableSvg(svg)
      && (lang === "drawio" || !isPoisonedMermaidSvg(svg, source));
    if (source.trim() && !hasUsableCache) {
      acc.push({
        lang,
        source,
        assign: (svg) => { data.svg = svg; },
        assignSource: (source) => { data.source = source; },
      });
    }
  }

  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) collectDiagrams(item, acc);
    } else if (v && typeof v === "object") {
      collectDiagrams(v, acc);
    }
  }
}

/**
 * 导出前预处理:Mermaid 缺缓存时服务端补渲染；drawio 使用客户端安全 SVG 缓存。
 * PDF / HTML 导出在序列化前调用,确保图表以真实渲染样子导出,而非回退源码。
 * drawio 无缓存时不在 Node/Chromium 重复打包渲染器，保持 svg=null 并回退源码；用户在
 * 编辑器打开一次图表即可生成经加固并持久化的缓存。这样导出路径不执行不可信 mxGraph XML。
 */
export async function withRenderedDiagrams(document: ExportDocument): Promise<ExportDocument> {
  const clone = structuredClone(document) as ExportDocument;
  const refs: DiagramRef[] = [];
  collectDiagrams(clone, refs);
  if (refs.length === 0) return clone;
  const mermaidRefs: DiagramRef[] = [];
  for (const ref of refs) {
    if (ref.lang === "drawio") {
      try {
        // 服务端不重复运行 maxGraph；缺缓存回退源码时仍必须经过与前端相同的
        // render-only 归一化，避免把 `%23` 非法颜色继续导出给用户复制。
        // mxfile 可能含多页，不能用首个 modelXml 覆盖整个容器；AI 常规产出的
        // 单页 mxGraphModel 和压缩 diagram 则可安全替换为准备后的明文模型。
        const prepared = prepareDrawioModelXmlForRender(ref.source);
        if (!ref.source.trimStart().startsWith("<mxfile")) {
          ref.source = prepared.modelXml;
          ref.assignSource(prepared.modelXml);
        }
      } catch (error) {
        getDocRenderLogger().warn("Drawio export source normalization failed; preserving original source", {
          reason: error instanceof Error ? error.message : String(error),
          sourceBytes: Buffer.byteLength(ref.source, "utf8"),
        });
      }
      getDocRenderLogger().warn("Drawio export cache missing; open the diagram in the client before exporting", {
        sourceBytes: Buffer.byteLength(ref.source, "utf8"),
      });
      continue;
    }
    mermaidRefs.push(ref);
  }
  // overlay 只负责布局/样式，不能替代 Mermaid 的语法判定。所有 Mermaid 源码先经过
  // 与前端同版本的 parse+render；drawio 则绝不送进 Mermaid 解析器。
  const mermaidSvgs = await renderDiagramSvgs(mermaidRefs.map((ref) => ref.source));
  mermaidRefs.forEach((ref, index) => {
    const mermaidSvg = mermaidSvgs[index];
    if (!mermaidSvg) return;
    if (hasOverlay(ref.overlay)) {
      const svg = graphToSvg(ref.source, ref.overlay);
      if (svg && isRenderableSvg(svg)) {
        ref.assign(svg);
        return;
      }
    }
    ref.assign(mermaidSvg);
  });
  return clone;
}

function readOverlay(value: unknown): DiagramOverlay | null {
  if (!value || typeof value !== "object") return null;
  return value as DiagramOverlay;
}

function hasOverlay(overlay: DiagramOverlay | null | undefined): overlay is DiagramOverlay {
  return !!overlay && (
    Object.keys(overlay.positions ?? {}).length > 0 ||
    Object.keys(overlay.styles ?? {}).length > 0 ||
    Object.keys(overlay.edgeStyles ?? {}).length > 0
  );
}

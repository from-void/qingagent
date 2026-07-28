import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPartialSvgDraft, hasVisibleSvgContent, sanitizeSvg, SVG_MAX_BYTES, utf8ByteLength } from "@qingagent/doc-render/browser";
import { lintSvg, type SvgLintIssue } from "@qingagent/doc-render/browser";
import {
  resolveModelParams,
} from "../llm/modelConfig.js";
import { streamInnerModel } from "../llm/innerModelStream.js";
import { startToolHeartbeat, writeToolStreamChunk } from "./toolHeartbeat.js";
import { uploadsBaseDir } from "@qingagent/doc-render/paths";
import { SVG_TEMPLATES } from "@qingagent/doc-render/svg-templates";

// 空闲看门狗:连续无任何输出超过该时长才判定卡死掐断——只要还在流式吐字就不断重置,
// 不会误杀"图很大、一直在画"的正常生成。另设宽松的总硬上限兜底极端情况。
export const SVG_IDLE_TIMEOUT_MS = 45_000;
export const SVG_HARD_TIMEOUT_MS = 180_000;
export const GENERATE_SVG_MAX_OUTPUT_TOKENS = 65_536;
export const GENERATE_SVG_RAW_MAX_BYTES = SVG_MAX_BYTES * 2;
const SVG_PROGRESS_THROTTLE_MS = 400;
const SVG_PROGRESS_KEEPALIVE_MS = 8_000;

type GenerateSvgStage = "starting" | "streaming" | "sanitizing" | "done" | "failed";

interface GenerateSvgProgress {
  stage: GenerateSvgStage;
  elapsedMs: number;
  rawKb: number;
  message: string;
  error?: string;
  src?: string;
  width?: number;
  height?: number;
  partialSvg?: string | null;
}

type ProgressWriter = {
  write: (chunk: Record<string, unknown>) => Promise<unknown> | unknown;
};

function createLinkedAbortController(parent?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, cleanup: () => undefined };

  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abort();
    return { controller, cleanup: () => undefined };
  }

  parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => parent.removeEventListener("abort", abort),
  };
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

function friendlyGenerateSvgError(error: unknown, opts: {
  timedOut: boolean;
  parentAborted: boolean;
}): string {
  if (opts.timedOut) {
    return "SVG 生成长时间无响应已停止，请稍后重试或用更简洁的配图描述。";
  }
  if (opts.parentAborted) {
    return "SVG 生成已取消。";
  }
  if (isAbortLike(error)) {
    return "SVG 生成已停止，请稍后重试。";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message ? `SVG 生成失败：${message}` : "SVG 生成失败。";
}

function rawKb(rawBytes: number): number {
  return Math.round((rawBytes / 1024) * 10) / 10;
}

async function persistSvg(svg: string): Promise<{ imageId: string; src: string }> {
  const imageId = randomUUID();
  const filename = "illustration.svg";
  const dir = join(uploadsBaseDir(), imageId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), svg, "utf8");
  return {
    imageId,
    src: `/api/v1/files/${imageId}/${filename}`,
  };
}

function issueSummaries(issues: SvgLintIssue[]): string[] {
  return issues.map((issue) => `${issue.rule}: ${issue.detail}`);
}

function zodErrorSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "params";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

// 推理模型有时会把 SVG 包在 ```svg / ```xml markdown 围栏里，strict XML 解析会拒绝。
// 这里先剥掉围栏并抽取 <svg>…</svg> 主体；抽取不到则返回原文，交给 sanitizeSvg 处理。
export function extractSvg(raw: string): string {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  text = text.replace(/^```(?:svg|xml)?[ \t]*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");
  text = text.trim();
  const start = text.search(/<svg[\s>]/i);
  if (start !== -1) {
    const lower = text.toLowerCase();
    const close = lower.lastIndexOf("</svg>");
    if (close !== -1 && close + 6 > start) {
      return text.slice(start, close + 6).trim();
    }
  }
  return text;
}

export function buildGenerateSvgBranchTail(systemPrompt: string, userPrompt: string): string {
  return [
    "不要调用任何工具。现在进入 generateSvg 旁支生成模式。",
    systemPrompt,
    userPrompt,
    "只输出一个完整 SVG 元素，不要解释或 Markdown fence。",
  ].join("\n\n");
}

export const generateSvgTool = createTool({
  id: "generateSvg",
  description: "【触发限制：仅当用户在本轮或对话中明确要求配图/插图/SVG/矢量图/示意图时才调用；" +
    "用户没要求配图就绝不主动配图，也不要因为‘文章可以更有画面感’之类理由自作主张生成】" +
    "生成一张安全、可消毒的 SVG 矢量插图。传入对插图内容的中文描述，可选 style/aspect。" +
    "适合：装饰性插画/图标/自由构图/氛围配图/数据示意卡。图表交给 diagram-viz 技能裁决；不要用于照片级写实图。" +
    "【本工具只负责生成图片资产，不会把图插进文档】返回 imageId 与 src（形如 /api/v1/files/<id>/illustration.svg）。" +
    "要把图放进文档，请在本工具返回后【另调 editDraft 的 insertBlock】插入一个 image QingML 片段来放置，例如 " +
    'editDraft({ops:[{action:"insertBlock",position:"after",ref:"<目标块 blockId>",blocks:"<img src=\\"<本工具返回的 src>\\" alt=\\"<简短说明>\\" width=\\"<本工具返回的 width>\\" height=\\"<本工具返回的 height>\\"/>"}]})。' +
    "内置模板（对比/要点/数据条形这三类需求必须用 template 参数，不要自由描述直出；自由插画才用 description 直出）：compare-card 双栏对比卡，params={title?,left:{title,items},right:{title,items},accent?}; points-card 要点卡，params={title?,points:[{label,desc?}],accent?}; bar-card 数据条形示意，params={title?,unit?,bars:[{label,value}],accent?}。accent 可为 warm/cool/mono。" +
    "（position 可用 after/before + ref 指定相邻块，或 start/end 放文首文末；需要 ref 时先 readDraft 取目标块 blockId。）" +
    "务必先用 writeDraft 出完整文本文档，再配图；一轮最多 1-2 张，失败后不要反复重试。",
  inputSchema: z.object({
    description: z.string().optional().default("").describe("自由插画内容的详细描述；使用 template 时可留空"),
    style: z.string().nullable().optional().describe("风格，如 简约线条/扁平填色/手绘/等距3D；默认简约"),
    aspect: z.enum(["16:9", "4:3", "1:1", "3:2"]).nullable().optional().describe("宽高比，默认 16:9"),
    template: z.enum(["compare-card", "points-card", "bar-card"]).nullable().optional()
      .describe("套用内置模板(质量稳定、秒出),能套用时优先于自由描述"),
    params: z.record(z.string(), z.unknown()).nullable().optional().describe("模板参数,见工具说明"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    imageId: z.string(),
    src: z.string(),
    svg: z.string(),
    width: z.number(),
    height: z.number(),
    alt: z.string(),
    lintIssues: z.array(z.string()),
  }),
  execute: async (input, context) => {
    const requestContext = context?.requestContext as RequestContext | undefined;
    const writer = (
      context as
        | { writer?: ProgressWriter }
        | undefined
    )?.writer;
    const aspect = input.aspect ?? "16:9";
    const [aw, ah] = aspect.split(":").map(Number) as [number, number];
    const width = 800;
    const height = Math.round((width * ah) / aw);
    const alt = input.description.slice(0, 120).trim() || "文档插图";
    const startedAt = Date.now();
    let rawBytes = 0;
    let currentStage: GenerateSvgStage = "starting";
    let currentMessage = "正在启动 SVG 生成";
    let currentPartialSvg: string | null = null;
    let lastEmitAt = 0;

    const fail = (error: string) => ({
      ok: false,
      error,
      imageId: "",
      src: "",
      svg: "",
      width,
      height,
      alt,
      lintIssues: [],
    });
    const emitProgress = async (
      stage: GenerateSvgStage,
      patch: Partial<Omit<GenerateSvgProgress, "stage" | "elapsedMs" | "rawKb">> = {},
      force = false,
      observedAt = Date.now(),
    ) => {
      if (!writer) return;
      const now = observedAt;
      if (!force && now - lastEmitAt < SVG_PROGRESS_THROTTLE_MS) return;
      currentStage = stage;
      currentMessage = patch.message ?? currentMessage;
      // 草稿:streaming 阶段沿用最近一次草稿(keepalive 不带 partialSvg 时不丢);
      // 一旦进入非 streaming(消毒/完成/失败)就清空,前端切回最终 src。
      if (stage === "streaming") {
        if (patch.partialSvg !== undefined && patch.partialSvg !== null) {
          currentPartialSvg = patch.partialSvg;
        }
      } else {
        currentPartialSvg = null;
      }
      lastEmitAt = now;
      try {
        await writeToolStreamChunk(writer, {
          type: "generatesvg-progress",
          progress: {
            stage,
            elapsedMs: now - startedAt,
            rawKb: rawKb(rawBytes),
            message: currentMessage,
            ...patch,
            partialSvg: stage === "streaming" ? currentPartialSvg : null,
          } satisfies GenerateSvgProgress,
        });
      } catch {
        // 进度推送失败不影响生成
      }
    };

    if (input.template) {
      const template = SVG_TEMPLATES[input.template];
      if (!template) {
        return fail(`未知 SVG 模板:${input.template}`);
      }
      const parsed = template.paramsSchema.safeParse(input.params ?? {});
      if (!parsed.success) {
        return fail(`模板参数不合法:${zodErrorSummary(parsed.error)}`);
      }
      try {
        const rendered = template.render(parsed.data, { width, height });
        const svg = sanitizeSvg(rendered, { width, height });
        if (!hasVisibleSvgContent(svg)) {
          const error = "模板 SVG 消毒后没有可见内容。";
          await emitProgress("failed", { message: error, error }, true);
          return fail(error);
        }
        const issues = lintSvg(svg, { width, height });
        const { imageId, src } = await persistSvg(svg);
        await emitProgress("done", {
          message: "SVG 已生成",
          src,
          width,
          height,
        }, true);
        return {
          ok: true,
          error: null,
          imageId,
          src,
          svg,
          width,
          height,
          alt,
          lintIssues: issueSummaries(issues),
        };
      } catch (error) {
        const reason = error instanceof Error ? `模板 SVG 生成失败：${error.message}` : "模板 SVG 生成失败。";
        await emitProgress("failed", { message: reason, error: reason }, true);
        return fail(reason);
      }
    }

    const sys = `你是 SVG 插画师。仅输出一个完整、自包含的 <svg> 元素，不要任何解释或 markdown 代码块。
硬性要求：
- 根 <svg> 必须含 xmlns="http://www.w3.org/2000/svg" 和 viewBox="0 0 ${width} ${height}"，不要写 width/height 属性。
- 只允许：svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop title desc。
- 严禁：<script> <foreignObject> <image> <use> <a>、任何 on* 事件属性、任何 href/xlink:href、任何 url(http...) 外部引用、<style> 中的 @import。
- 背景与对比度（重要）：成品会嵌在【米黄色纸张 #efe7d6】上展示。请二选一处理底色：
  ① 画一个铺满画布的背景矩形(把 <rect x="0" y="0" width="${width}" height="${height}" fill="某个明确底色"/> 作为第一个元素),并保证其上所有文字/图形与该底色高对比;
  ② 或不画背景(透明),此时所有文字、线条、浅色元素必须用【深色】(如 #2b2b2b、#333)以便在米黄纸上清晰可读——严禁用白色/浅黄/浅米/接近 #efe7d6 的浅色做文字或细线(在米黄纸上会糊成一片看不清)。
- 版式与几何（硬性）：
  ① 按 12 列网格布局(viewBox 宽 ${width},列宽 ${Math.round(width / 12)}px),主元素贴列线;外留白 ≥32px,间距 ≥16px。
  ② 文字宽度自检:CJK≈fontSize×1.0,英数≈×0.6;每个 <text> 先算 x+宽 ≤ 容器右缘;超长用 <tspan x=".." dy="1.4em"> 换行或降字号,禁溢出。
  ③ 字号阶梯:标题28-36/正文16-20/标注12-14,最小12;同层级字号一致。
  ④ 文本禁止互相重叠;色块文字必须与底色高对比。
- 骨架:双栏对比卡
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#f7f1e6"/><text x="48" y="56" font-size="30" fill="#2b2b2b">标题</text>
    <rect x="48" y="96" width="320" height="270" fill="#ffffff"/><text x="72" y="138" font-size="20" fill="#2b2b2b">左栏</text>
    <text x="72" y="178" font-size="16" fill="#333333"><tspan x="72">要点</tspan><tspan x="72" dy="1.4em">换行</tspan></text>
    <rect x="432" y="96" width="320" height="270" fill="#2f5d62"/><text x="456" y="138" font-size="20" fill="#ffffff">右栏</text>
    <text x="456" y="178" font-size="16" fill="#ffffff"><tspan x="456">要点</tspan><tspan x="456" dy="1.4em">换行</tspan></text>
  </svg>
- 骨架:概念示意
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#efe7d6"/><circle cx="260" cy="220" r="74" fill="#d9b45f"/><circle cx="540" cy="220" r="74" fill="#315c72"/>
    <line x1="334" y1="220" x2="466" y2="220" stroke="#2b2b2b" stroke-width="4"/>
    <text x="260" y="224" text-anchor="middle" font-size="20" fill="#2b2b2b">概念A</text><text x="540" y="224" text-anchor="middle" font-size="20" fill="#ffffff">概念B</text>
    <text x="400" y="196" text-anchor="middle" font-size="14" fill="#2b2b2b">关系</text>
  </svg>
- 颜色用十六进制；中文文字 font-family="sans-serif"。风格：${input.style ?? "简约线条扁平填色"}。`;

    const stopHeartbeat = startToolHeartbeat(context, { tool: "generateSvg" });
    let timedOut = false;
    const keepAliveId = setInterval(() => {
      void emitProgress(currentStage, { message: currentMessage }, true);
    }, SVG_PROGRESS_KEEPALIVE_MS);

    try {
      await emitProgress("starting", { message: "正在启动 SVG 生成" }, true);
      const { maxOutputTokens, temperature } = resolveModelParams(requestContext);
      const maxTokens = Math.min(
        maxOutputTokens ?? GENERATE_SVG_MAX_OUTPUT_TOKENS,
        GENERATE_SVG_MAX_OUTPUT_TOKENS,
      );
      let modelAttempt = 0;

      const runDraftAttempt = async (
        userPrompt: string,
        streamingMessage = "正在生成 SVG 结构",
      ): Promise<{ raw: string }> => {
        const attempt = ++modelAttempt;
        const linked = createLinkedAbortController(context?.abortSignal);
        rawBytes = 0;
        // 空闲看门狗:每收到一段输出就重置;只有连续 idle 超时(真卡死、没在吐字)才掐。
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const armIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            linked.controller.abort(new DOMException("SVG idle timeout", "AbortError"));
          }, SVG_IDLE_TIMEOUT_MS);
        };
        // 流式阶段硬上限:给上游 DeepSeek 流一个总时长上限(即便一直缓慢吐字也不无限等);
        // 流结束即清理,不覆盖后续 sanitize/writeFile(本地快操作)。
        const hardTimeoutId = setTimeout(() => {
          timedOut = true;
          linked.controller.abort(new DOMException("SVG hard timeout", "AbortError"));
        }, SVG_HARD_TIMEOUT_MS);
        armIdleTimer();
        try {
          const result = await streamInnerModel({
            requestContext,
            callSite: "generateSvg",
            lane: null,
            attempt,
            system: sys,
            prompt: userPrompt,
            branchSteeringTail: buildGenerateSvgBranchTail(sys, userPrompt),
            // 真流式:partialSvg 每帧从全量 raw 重建(整帧替换),判废降级重跑只是草稿从头重画。
            liveTextDeltas: true,
            thinking: false,
            temperature: temperature ?? 0.4,
            abortSignal: linked.controller.signal,
            maxRetries: 0,
            maxTokens,
            maxBufferedTextBytes: GENERATE_SVG_RAW_MAX_BYTES,
            onActivity: armIdleTimer,
            onContentStart: (_elapsedMs, observedAt) => {
              armIdleTimer();
              void emitProgress(
                "streaming",
                { message: streamingMessage, partialSvg: null },
                true,
                observedAt,
              );
            },
            onContentReset: () => {
              rawBytes = 0;
            },
            onContentDelta: (delta, raw, observedAt) => {
              armIdleTimer();
              // reset 明确切开废弃分支与 fallback；这里只累加新 delta，避免随 raw 增长反复全量扫描。
              rawBytes += utf8ByteLength(delta);
              if (rawBytes > GENERATE_SVG_RAW_MAX_BYTES) {
                const error = new Error(`SVG 生成输出超过 ${GENERATE_SVG_RAW_MAX_BYTES} 字节上限`);
                linked.controller.abort(error);
                throw error;
              }
              // 流式草稿:只有当本次会真正推送(过了节流窗口)才花成本去构建草稿串,避免每 delta 都解析。
              const eventAt = observedAt ?? Date.now();
              const willEmit = eventAt - lastEmitAt >= SVG_PROGRESS_THROTTLE_MS;
              const partialSvg = willEmit ? buildPartialSvgDraft(extractSvg(raw), { width, height }) : undefined;
              void emitProgress("streaming", { message: streamingMessage, partialSvg }, false, eventAt);
            },
          });
          return { raw: result.raw };
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(hardTimeoutId);
          linked.cleanup();
        }
      };

      const buildCandidate = async (raw: string): Promise<{ svg: string; issues: SvgLintIssue[] } | null> => {
        const svg = sanitizeSvg(extractSvg(raw), { width, height });
        if (!hasVisibleSvgContent(svg)) return null;
        return { svg, issues: lintSvg(svg, { width, height }) };
      };

      const shouldRetry = (issues: SvgLintIssue[]): boolean =>
        issues.some((issue) => issue.rule === "text-overflow") || issues.length >= 3;

      const firstResult = await runDraftAttempt(`插图内容：${input.description}`);

      await emitProgress("sanitizing", { message: "正在消毒 SVG" }, true);
      const firstCandidate = await buildCandidate(firstResult.raw);
      if (!firstCandidate) {
        const error = "生成的 SVG 为空或消毒后没有可见内容，请换一个更具体的配图描述。";
        await emitProgress("failed", { message: error, error }, true);
        return fail(error);
      }

      let selected = firstCandidate;
      if (shouldRetry(firstCandidate.issues)) {
        await emitProgress("streaming", { message: "检测到版式问题,正在重新生成", partialSvg: null }, true);
        const retryPrompt = [
          `插图内容:${input.description}`,
          "",
          "上一版存在以下版式问题,逐条修复后重新输出完整 SVG(其余保持):",
          ...issueSummaries(firstCandidate.issues).map((issue) => `- ${issue}`),
          "",
          "上一版 SVG:",
          firstCandidate.svg.slice(0, 8192),
        ].join("\n");
        try {
          const retryResult = await runDraftAttempt(retryPrompt, "正在重新生成 SVG 结构");
          await emitProgress("sanitizing", { message: "正在消毒重试 SVG" }, true);
          const retryCandidate = await buildCandidate(retryResult.raw);
          if (retryCandidate && retryCandidate.issues.length < firstCandidate.issues.length) {
            selected = retryCandidate;
          }
        } catch {
          context?.abortSignal?.throwIfAborted();
          selected = firstCandidate;
        }
      }

      context?.abortSignal?.throwIfAborted();
      const { imageId, src } = await persistSvg(selected.svg);
      await emitProgress("done", {
        message: "SVG 已生成",
        src,
        width,
        height,
      }, true);
      return {
        ok: true,
        error: null,
        imageId,
        src,
        svg: selected.svg,
        width,
        height,
        alt,
        lintIssues: issueSummaries(selected.issues),
      };
    } catch (error) {
      const reason = friendlyGenerateSvgError(error, {
        timedOut,
        parentAborted: Boolean(context?.abortSignal?.aborted),
      });
      await emitProgress("failed", { message: reason, error: reason }, true);
      return fail(reason);
    } finally {
      clearInterval(keepAliveId);
      stopHeartbeat();
    }
  },
});

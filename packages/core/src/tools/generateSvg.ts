import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPartialSvgDraft, hasVisibleSvgContent, sanitizeSvg, SVG_MAX_BYTES, utf8ByteLength } from "../browser/svgSanitize.js";
import {
  resolveBaseUrl,
  resolveDeepseekAuth,
  resolveModelId,
  resolveModelParams,
  resolveProtocol,
} from "../llm/modelConfig.js";
import { callDeepseekDraft } from "./deepseekDraftClient.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";
import { uploadsBaseDir } from "../workspace/uploadsDir.js";

// 空闲看门狗:连续无任何输出超过该时长才判定卡死掐断——只要还在流式吐字就不断重置,
// 不会误杀"图很大、一直在画"的正常生成。另设宽松的总硬上限兜底极端情况。
export const SVG_IDLE_TIMEOUT_MS = 45_000;
export const SVG_HARD_TIMEOUT_MS = 180_000;
export const GENERATE_SVG_MAX_OUTPUT_TOKENS = 16_384;
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

export const generateSvgTool = createTool({
  id: "generateSvg",
  description: "【触发限制：仅当用户在本轮或对话中明确要求配图/插图/SVG/矢量图/示意图时才调用；" +
    "用户没要求配图就绝不主动配图，也不要因为‘文章可以更有画面感’之类理由自作主张生成】" +
    "生成一张安全、可消毒的 SVG 矢量插图。传入对插图内容的中文描述，可选 style/aspect。" +
    "适合：装饰性插画/图标/自由构图/氛围配图/数据示意卡。流程图、结构示意、关系图、时序图、组织架构、常规对比图一律改用文档的 diagram(mermaid)块表达,不要调本工具——mermaid 可编辑、可主题化且更省;只有 mermaid 表达不了的自由视觉构图才用本工具。不要用于照片级写实图。" +
    "【本工具只负责生成图片资产，不会把图插进文档】返回 imageId 与 src（形如 /api/v1/files/<id>/illustration.svg）。" +
    "要把图放进文档，请在本工具返回后【另调 editDraft 的 insertBlock】插入一个 image 块来放置，例如 " +
    'editDraft({ops:[{action:"insertBlock",position:"after",ref:"<目标块 blockId>",blocks:[{type:"image",src:"<本工具返回的 src>",alt:"<简短说明>",width:<本工具返回的 width>,height:<本工具返回的 height>}]}]})。' +
    "（position 可用 after/before + ref 指定相邻块，或 start/end 放文首文末；需要 ref 时先 readDraft 取目标块 blockId。）" +
    "务必先用 writeDraft 出完整文本文档，再配图；一轮最多 1-2 张，失败后不要反复重试。",
  inputSchema: z.object({
    description: z.string().describe("插图内容的详细描述"),
    style: z.string().nullable().optional().describe("风格，如 简约线条/扁平填色/手绘/等距3D；默认简约"),
    aspect: z.enum(["16:9", "4:3", "1:1", "3:2"]).nullable().optional().describe("宽高比，默认 16:9"),
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
    });
    const emitProgress = async (
      stage: GenerateSvgStage,
      patch: Partial<Omit<GenerateSvgProgress, "stage" | "elapsedMs" | "rawKb">> = {},
      force = false,
    ) => {
      if (!writer) return;
      const now = Date.now();
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
        await writer.write({
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

    const sys = `你是 SVG 插画师。仅输出一个完整、自包含的 <svg> 元素，不要任何解释或 markdown 代码块。
硬性要求：
- 根 <svg> 必须含 xmlns="http://www.w3.org/2000/svg" 和 viewBox="0 0 ${width} ${height}"，不要写 width/height 属性。
- 只允许：svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop title desc。
- 严禁：<script> <foreignObject> <image> <use> <a>、任何 on* 事件属性、任何 href/xlink:href、任何 url(http...) 外部引用、<style> 中的 @import。
- 背景与对比度（重要）：成品会嵌在【米黄色纸张 #efe7d6】上展示。请二选一处理底色：
  ① 画一个铺满画布的背景矩形(把 <rect x="0" y="0" width="${width}" height="${height}" fill="某个明确底色"/> 作为第一个元素),并保证其上所有文字/图形与该底色高对比;
  ② 或不画背景(透明),此时所有文字、线条、浅色元素必须用【深色】(如 #2b2b2b、#333)以便在米黄纸上清晰可读——严禁用白色/浅黄/浅米/接近 #efe7d6 的浅色做文字或细线(在米黄纸上会糊成一片看不清)。
- 颜色用十六进制；中文文字 font-family="sans-serif"。风格：${input.style ?? "简约线条扁平填色"}。`;

    const stopHeartbeat = startToolHeartbeat(context, { tool: "generateSvg" });
    const linked = createLinkedAbortController(context?.abortSignal);
    let timedOut = false;
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
      const auth = resolveDeepseekAuth(requestContext);
      const result = await callDeepseekDraft({
        system: sys,
        user: `插图内容：${input.description}`,
        thinking: false,
        temperature: temperature ?? 0.4,
        stream: true,
        baseUrl: resolveBaseUrl(requestContext),
        model: resolveModelId(requestContext, "flash"),
        apiKey: auth.apiKey || undefined,
        protocol: resolveProtocol(requestContext),
        abortSignal: linked.controller.signal,
        maxRetries: 0,
        maxTokens,
        onContentStart: () => {
          armIdleTimer();
          void emitProgress("streaming", { message: "正在生成 SVG 结构", partialSvg: null }, true);
        },
        onContentDelta: (delta, raw) => {
          armIdleTimer();
          rawBytes += utf8ByteLength(delta);
          if (rawBytes > GENERATE_SVG_RAW_MAX_BYTES) {
            const error = new Error(`SVG 生成输出超过 ${GENERATE_SVG_RAW_MAX_BYTES} 字节上限`);
            linked.controller.abort(error);
            throw error;
          }
          // 流式草稿:只有当本次会真正推送(过了节流窗口)才花成本去构建草稿串,避免每 delta 都解析。
          const willEmit = Date.now() - lastEmitAt >= SVG_PROGRESS_THROTTLE_MS;
          const partialSvg = willEmit ? buildPartialSvgDraft(extractSvg(raw), { width, height }) : undefined;
          void emitProgress("streaming", { message: "正在生成 SVG 结构", partialSvg });
        },
      });

      // 上游流已结束:清理流式看门狗(后续消毒/落盘是本地快操作,不再受超时约束)
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimeoutId);

      await emitProgress("sanitizing", { message: "正在消毒 SVG" }, true);
      const svg = sanitizeSvg(extractSvg(result.raw), { width, height });
      if (!hasVisibleSvgContent(svg)) {
        const error = "生成的 SVG 为空或消毒后没有可见内容，请换一个更具体的配图描述。";
        await emitProgress("failed", { message: error, error }, true);
        return fail(error);
      }

      const imageId = randomUUID();
      const filename = "illustration.svg";
      const dir = join(uploadsBaseDir(), imageId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, filename), svg, "utf8");
      const src = `/api/v1/files/${imageId}/${filename}`;
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
      };
    } catch (error) {
      const reason = friendlyGenerateSvgError(error, {
        timedOut,
        parentAborted: Boolean(context?.abortSignal?.aborted),
      });
      await emitProgress("failed", { message: reason, error: reason }, true);
      return fail(reason);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimeoutId);
      clearInterval(keepAliveId);
      linked.cleanup();
      stopHeartbeat();
    }
  },
});

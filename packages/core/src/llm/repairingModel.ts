import { ModelRouterLanguageModel, type OpenAICompatibleConfig } from "@mastra/core/llm";
import { editDraftInputSchema, writeDraftInputSchema } from "./draftToolSchemas.js";
import {
  annotationGroupsParseFailureInput,
  createAnnotationGroupsInputSchema,
} from "../tools/annotationGroups.js";
import { guardBeforeProviderCall } from "./prefixCacheGuard.js";
import { repairToolCallJson } from "./repairToolCallJson.js";
import { resolveDeepseekRouterModelId } from "./modelConfig.js";

type ModelCallOptions = Parameters<ModelRouterLanguageModel["doStream"]>[0];
type ModelStreamResult = Awaited<ReturnType<ModelRouterLanguageModel["doStream"]>>;

// 模型调用瞬时网络失败(ECONNRESET / 连接重置 / 超时)是可重试的——上游(DeepSeek/代理)抖一下
// 不该把整轮甩回给用户"模型服务连接失败,请重试"。仅在"建连/首字节前"失败时重试(此处 await 抛出
// 即此类),不重试已经流出 token 的中途错误。
export function isRetryableModelError(e: unknown): boolean {
  const retryableCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    // 仅 modelTransport 的代理内部 Client 使用短 headersTimeout；这里代表 CONNECT
    // 隧道未建立，真实模型请求仍保留 undici 默认 headersTimeout。
    "UND_ERR_HEADERS_TIMEOUT",
    "ENOTFOUND",
  ]);
  let current: unknown = e;
  const seen = new Set<unknown>();
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    const err = current as { isRetryable?: boolean; code?: string; cause?: unknown; message?: string };
    if (err.isRetryable === true || retryableCodes.has(err.code ?? "")) return true;
    if (
      /ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT|socket hang up|Cannot connect|fetch failed|network|terminated|aborted/i.test(
        String(err.message ?? ""),
      )
    ) return true;
    current = err.cause;
  }
  return false;
}

async function withModelRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i >= attempts || !isRetryableModelError(e)) throw e;
      // eslint-disable-next-line no-console
      console.warn(`[model] 瞬时连接失败,第 ${i}/${attempts - 1} 次重试: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** (i - 1))); // 400ms, 800ms
    }
  }
  throw lastErr;
}
type ModelStreamPart = ModelStreamResult["stream"] extends ReadableStream<infer Part>
  ? Part
  : never;

type ModelResultWithStream = { stream: ReadableStream<unknown> };
type ModelResultWithContent = { content: unknown[] };

export type RepairableLanguageModel = {
  readonly specificationVersion: "v2" | "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doGenerate(...args: any[]): PromiseLike<unknown>;
  doStream(...args: any[]): PromiseLike<unknown>;
};

export type RepairableLanguageModelV2 = {
  readonly specificationVersion: "v2";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: ModelRouterLanguageModel["supportedUrls"];
  doGenerate(options: ModelCallOptions): PromiseLike<ModelStreamResult>;
  doStream(options: ModelCallOptions): PromiseLike<ModelStreamResult>;
};

/** 默认(env 兜底)模型配置;访客/全局 key 覆盖见 createRepairingQingagentModel(auth)。 */
export const qingagentModelConfig = {
  id: resolveDeepseekRouterModelId(),
  url: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
} satisfies OpenAICompatibleConfig;

function parseJson(input: string): unknown {
  return JSON.parse(input);
}

function isValidDraftToolInput(toolName: string, value: unknown): boolean {
  if (toolName === "editDraft") return editDraftInputSchema.safeParse(value).success;
  if (toolName === "writeDraft") return writeDraftInputSchema.safeParse(value).success;
  return false;
}

function isValidRepairableToolInput(toolName: string, value: unknown): boolean {
  if (toolName === "create_annotation_groups") {
    return createAnnotationGroupsInputSchema.safeParse(value).success;
  }
  return isValidDraftToolInput(toolName, value);
}

function isRepairableToolName(toolName: string): boolean {
  return toolName === "editDraft" || toolName === "writeDraft" || toolName === "create_annotation_groups";
}

export function repairSupportedToolCallInput(
  toolName: string,
  input: string,
): string | null {
  if (!isRepairableToolName(toolName)) return null;

  let parseError: unknown;
  try {
    parseJson(input);
    return null;
  } catch (error) {
    parseError = error;
    // 只有解析失败才尝试高置信度修复。
  }

  const repaired = repairToolCallJson(input);
  if (repaired.ok) {
    let parsed: unknown;
    try {
      parsed = parseJson(repaired.json);
    } catch {
      parsed = null;
    }
    if (isValidRepairableToolInput(toolName, parsed)) return repaired.json;
  }

  // 草稿工具保持既有 fail-closed 行为。批注工具则返回无副作用诊断信封，避免 Mastra
  // 把缺失 arguments 写回消息后让下一步请求直接失败，模型可据“第几组/字段”拆批重试。
  return toolName === "create_annotation_groups"
    ? annotationGroupsParseFailureInput(input, parseError)
    : null;
}

export function repairDraftToolCallInput(
  toolName: string,
  input: string,
): string | null {
  if (toolName !== "editDraft" && toolName !== "writeDraft") return null;
  return repairSupportedToolCallInput(toolName, input);
}

export function repairToolCallStreamPart<T>(part: T): T {
  if (
    part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "tool-call" &&
    "toolName" in part &&
    typeof part.toolName === "string" &&
    "input" in part &&
    typeof part.input === "string"
  ) {
    const repairedInput = repairSupportedToolCallInput(part.toolName, part.input);
    if (repairedInput !== null) {
      return { ...part, input: repairedInput };
    }
  }
  return part;
}

export function repairToolCallStream<T>(
  stream: ReadableStream<T>,
): ReadableStream<T> {
  return stream.pipeThrough(new TransformStream<T, T>({
    transform(part, controller) {
      controller.enqueue(repairToolCallStreamPart(part));
    },
  }));
}

function isModelResultWithStream(result: unknown): result is ModelResultWithStream {
  return (
    result !== null &&
    typeof result === "object" &&
    "stream" in result &&
    result.stream instanceof ReadableStream
  );
}

function isModelResultWithContent(result: unknown): result is ModelResultWithContent {
  return result !== null && typeof result === "object" && "content" in result && Array.isArray(result.content);
}

function repairToolCallModelResult<T>(result: T): T {
  if (isModelResultWithStream(result)) {
    return { ...result, stream: repairToolCallStream(result.stream) } as T;
  }
  if (isModelResultWithContent(result)) {
    return { ...result, content: result.content.map((part) => repairToolCallStreamPart(part)) } as T;
  }
  return result;
}

export function wrapToolCallRepairingModel<T extends RepairableLanguageModel>(
  inner: T,
  options: { guardProviderCall?: boolean } = {},
): T {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "doGenerate") {
        return async (...args: any[]) => {
          if (options.guardProviderCall) guardBeforeProviderCall(args[0]);
          const result = await withModelRetry(() => Promise.resolve(target.doGenerate(...args)));
          return repairToolCallModelResult(result);
        };
      }
      if (prop === "doStream") {
        return async (...args: any[]) => {
          if (options.guardProviderCall) guardBeforeProviderCall(args[0]);
          const result = await withModelRetry(() => Promise.resolve(target.doStream(...args)));
          return repairToolCallModelResult(result);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

export class RepairingLanguageModelV2 implements RepairableLanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: ModelRouterLanguageModel["supportedUrls"];

  constructor(private readonly inner: RepairableLanguageModelV2) {
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
  }

  async doGenerate(options: ModelCallOptions): Promise<ModelStreamResult> {
    const result = await withModelRetry(() => Promise.resolve(this.inner.doGenerate(options)));
    return repairToolCallModelResult(result);
  }

  async doStream(options: ModelCallOptions): Promise<ModelStreamResult> {
    const result = await withModelRetry(() => Promise.resolve(this.inner.doStream(options)));
    return repairToolCallModelResult(result);
  }
}

export class RepairingModelRouterLanguageModel extends ModelRouterLanguageModel {
  constructor(config: OpenAICompatibleConfig = qingagentModelConfig) {
    super(config);
  }

  async doGenerate(options: ModelCallOptions): Promise<ModelStreamResult> {
    guardBeforeProviderCall(options);
    const result = await withModelRetry(() => super.doGenerate(options));
    return repairToolCallModelResult(result);
  }

  async doStream(options: ModelCallOptions): Promise<ModelStreamResult> {
    guardBeforeProviderCall(options);
    const result = await withModelRetry(() => super.doStream(options));
    return repairToolCallModelResult(result);
  }
}

export function createRepairingQingagentModel(
  config: OpenAICompatibleConfig = qingagentModelConfig,
): RepairingModelRouterLanguageModel {
  return new RepairingModelRouterLanguageModel(config);
}

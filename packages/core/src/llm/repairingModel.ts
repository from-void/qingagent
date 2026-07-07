import { ModelRouterLanguageModel, type OpenAICompatibleConfig } from "@mastra/core/llm";
import { editDraftInputSchema } from "../tools/draftMutationSchemas.js";
import { writeDraftInputSchema } from "../tools/writeDraft.js";
import { guardBeforeProviderCall } from "./prefixCacheGuard.js";
import { repairToolCallJson } from "./repairToolCallJson.js";

type ModelCallOptions = Parameters<ModelRouterLanguageModel["doStream"]>[0];
type ModelStreamResult = Awaited<ReturnType<ModelRouterLanguageModel["doStream"]>>;

// 模型调用瞬时网络失败(ECONNRESET / 连接重置 / 超时)是可重试的——上游(DeepSeek/代理)抖一下
// 不该把整轮甩回给用户"模型服务连接失败,请重试"。仅在"建连/首字节前"失败时重试(此处 await 抛出
// 即此类),不重试已经流出 token 的中途错误。
function isRetryableModelError(e: unknown): boolean {
  const err = e as { isRetryable?: boolean; code?: string; cause?: { code?: string }; message?: string };
  if (err?.isRetryable === true) return true;
  const code = err?.code ?? err?.cause?.code ?? "";
  const msg = String(err?.message ?? "");
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET", "ENOTFOUND"].includes(code) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|Cannot connect|fetch failed|network|terminated|aborted/i.test(
      msg,
    )
  );
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
  id: "deepseek/deepseek-v4-flash",
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

export function repairDraftToolCallInput(
  toolName: string,
  input: string,
): string | null {
  if (toolName !== "editDraft" && toolName !== "writeDraft") return null;

  try {
    parseJson(input);
    return null;
  } catch {
    // 只有解析失败才尝试高置信度修复。
  }

  const repaired = repairToolCallJson(input);
  if (!repaired.ok) return null;

  let parsed: unknown;
  try {
    parsed = parseJson(repaired.json);
  } catch {
    return null;
  }

  return isValidDraftToolInput(toolName, parsed) ? repaired.json : null;
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
    const repairedInput = repairDraftToolCallInput(part.toolName, part.input);
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

export function wrapToolCallRepairingModel<T extends RepairableLanguageModel>(inner: T): T {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "doGenerate") {
        return async (...args: any[]) => {
          const result = await withModelRetry(() => Promise.resolve(target.doGenerate(...args)));
          return repairToolCallModelResult(result);
        };
      }
      if (prop === "doStream") {
        return async (...args: any[]) => {
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

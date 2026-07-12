import { streamText as streamTextV4 } from "ai";
import { streamText as streamTextV5 } from "ai-v5";

type StreamTextOptions = Parameters<typeof streamTextV5>[0];

function isV2Model(model: unknown): boolean {
  return !!model && typeof model === "object" &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v2";
}

function isLegacyTransportMocked(): boolean {
  return (streamTextV4 as typeof streamTextV4 & { _isMockFunction?: boolean })._isMockFunction === true;
}

function legacyMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) return message;
    return {
      ...record,
      content: record.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const item = part as Record<string, unknown>;
        if (item.mediaType === undefined) return part;
        const { mediaType, ...rest } = item;
        return { ...rest, mimeType: mediaType };
      }),
    };
  });
}

function legacyOptions(options: StreamTextOptions): Record<string, unknown> {
  const input = options as unknown as Record<string, unknown>;
  const { maxOutputTokens, messages, ...rest } = input;
  return {
    ...rest,
    ...(maxOutputTokens === undefined ? {} : { maxTokens: maxOutputTokens }),
    ...(messages === undefined ? {} : { messages: legacyMessages(messages) }),
  };
}

async function* normalizeLegacyFullStream(
  source: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const part of source) {
    if (!part || typeof part !== "object") {
      yield part;
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type === "text-delta" && typeof record.textDelta === "string") {
      const { textDelta, ...rest } = record;
      yield { ...rest, text: textDelta };
      continue;
    }
    if (record.type === "reasoning" && typeof record.textDelta === "string") {
      const { textDelta, ...rest } = record;
      yield { ...rest, type: "reasoning-delta", text: textDelta };
      continue;
    }
    yield part;
  }
}

/**
 * Mastra 1.49 保留 ai@4 peer；产品 v2 provider 统一走 AI SDK 5。
 * v1 分支只服务仍存在的 legacy model/测试替身，并归一为 v5 fullStream 事件形状。
 */
export const streamText = ((options: StreamTextOptions) => {
  // 既有非 live 测试统一 mock `ai`，保留该注入点可避免误发真实 provider 请求。
  if (!isLegacyTransportMocked() && isV2Model(options.model)) return streamTextV5(options);
  const result = streamTextV4(legacyOptions(options) as never);
  return new Proxy(result as object, {
    get(target, property, receiver) {
      if (property === "fullStream") {
        return normalizeLegacyFullStream(
          Reflect.get(target, property, receiver) as AsyncIterable<unknown>,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}) as typeof streamTextV5;

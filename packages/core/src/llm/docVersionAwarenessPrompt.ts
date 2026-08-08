import type { CoreMessage } from "ai";
import { hasCanonicalDoc } from "../utils/pmDocFacts.js";

export const QINGAGENT_DOC_VERSION_AWARENESS_REQUEST_CONTEXT_KEY =
  "qingagentDocVersionAwarenessPrompt";
export const DOC_VERSION_AWARENESS_MARKER = "[正文已更新]";

type RequestContextLike = {
  get?: (key: string) => unknown;
};

type DocVersionAwarenessContentSource =
  | string
  | (() => string | null | undefined)
  | null
  | undefined;

type DocumentVersionState = {
  docVersion: number;
  modelKnownDocVersion: number | null;
  doc?: { content: readonly unknown[] } | null;
};

type PromptOptions = {
  prompt?: unknown;
};

export function buildDocVersionAwarenessContent(
  state: DocumentVersionState,
): string | null {
  const knownVersion = state.modelKnownDocVersion;
  if (knownVersion !== null) {
    if (state.docVersion <= knownVersion) return null;
    return (
      `${DOC_VERSION_AWARENESS_MARKER} 正文自你上次读取(v${knownVersion})后已更新到 v${state.docVersion}。` +
      "任何基于正文内容的判断(审阅/核查/改写/引用)之前,必须先重新 readDraft;" +
      "不得沿用上下文中的历史读取结果。"
    );
  }

  const hasDocumentBody = hasCanonicalDoc({ doc: state.doc ?? undefined });
  if (state.docVersion <= 0 || !hasDocumentBody) return null;
  return (
    `${DOC_VERSION_AWARENESS_MARKER} 本会话你尚未读取正文,涉及正文的任务先 readDraft;` +
    "不得沿用上下文中的历史读取结果。"
  );
}

export function docVersionAwarenessSourceFromRequestContext(
  requestContext: RequestContextLike | undefined,
): DocVersionAwarenessContentSource {
  const raw = requestContext?.get?.(
    QINGAGENT_DOC_VERSION_AWARENESS_REQUEST_CONTEXT_KEY,
  );
  if (typeof raw === "function" || typeof raw === "string") {
    return raw as DocVersionAwarenessContentSource;
  }
  return null;
}

export function resolveDocVersionAwarenessContent(
  source: DocVersionAwarenessContentSource,
): string | null {
  const raw = typeof source === "function" ? source() : source;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function appendDocVersionAwarenessToPromptOptions<T extends PromptOptions>(
  options: T,
  content: string | null | undefined,
): T {
  if (!content) return options;
  const prompt = options.prompt;
  const promptMessages = Array.isArray(prompt)
    ? prompt
    : prompt === undefined
      ? []
      : [prompt];
  return {
    ...options,
    prompt: [...promptMessages, docVersionAwarenessPromptMessage(content)],
  };
}

type PromptCallModel = {
  doGenerate(...args: any[]): PromiseLike<unknown>;
  doStream(...args: any[]): PromiseLike<unknown>;
};

export function wrapModelWithDocVersionAwareness<T extends PromptCallModel>(
  model: T,
  source: DocVersionAwarenessContentSource,
): T {
  if (!source) return model;
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") {
        return (...args: any[]) => {
          const content = resolveDocVersionAwarenessContent(source);
          if (!content) return Reflect.get(target, prop, target).apply(target, args);
          const callArgs = appendDocVersionAwarenessToFirstArg(args, content);
          return Reflect.get(target, prop, target).apply(target, callArgs);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function appendDocVersionAwarenessToFirstArg(
  args: any[],
  content: string,
): any[] {
  if (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) return args;
  const nextOptions = appendDocVersionAwarenessToPromptOptions(args[0], content);
  if (nextOptions === args[0]) return args;
  return [nextOptions, ...args.slice(1)];
}

function docVersionAwarenessPromptMessage(content: string): CoreMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
  };
}

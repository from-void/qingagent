import type { CoreMessage } from "ai";
import type { RequestContext } from "@mastra/core/request-context";
import { buildDiagramVizEditingInstructionFromContext } from "../skills/diagramViz.js";

type DiagramVizEditingContentSource =
  | string
  | (() => string | null | undefined)
  | null
  | undefined;

type PromptOptions = {
  prompt?: unknown;
};

export function diagramVizEditingSourceFromRequestContext(
  requestContext: RequestContext | undefined,
): DiagramVizEditingContentSource {
  if (!requestContext) return null;
  // readDraft 会在同一轮工具循环中更新 editingLanguages，因此每次 provider 调用前再读取。
  return () => buildDiagramVizEditingInstructionFromContext(requestContext);
}

export function resolveDiagramVizEditingContent(
  source: DiagramVizEditingContentSource,
): string | null {
  try {
    const raw = typeof source === "function" ? source() : source;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (error) {
    console.warn("[diagram-viz] 图表编辑注入警告", {
      kind: "resolver-failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function appendDiagramVizEditingToPromptOptions<T extends PromptOptions>(
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
    prompt: [...promptMessages, diagramVizEditingPromptMessage(content)],
  };
}

type PromptCallModel = {
  doGenerate(...args: any[]): PromiseLike<unknown>;
  doStream(...args: any[]): PromiseLike<unknown>;
};

export function wrapModelWithDiagramVizEditing<T extends PromptCallModel>(
  model: T,
  source: DiagramVizEditingContentSource,
): T {
  if (!source) return model;
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") {
        return (...args: any[]) => {
          const content = resolveDiagramVizEditingContent(source);
          if (!content) return Reflect.get(target, prop, target).apply(target, args);
          const callArgs = appendDiagramVizEditingToFirstArg(args, content);
          return Reflect.get(target, prop, target).apply(target, callArgs);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function appendDiagramVizEditingToFirstArg(
  args: any[],
  content: string,
): any[] {
  if (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) return args;
  const nextOptions = appendDiagramVizEditingToPromptOptions(args[0], content);
  if (nextOptions === args[0]) return args;
  return [nextOptions, ...args.slice(1)];
}

function diagramVizEditingPromptMessage(content: string): CoreMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
  };
}

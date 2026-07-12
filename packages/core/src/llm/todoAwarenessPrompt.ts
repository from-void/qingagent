import { TODO_AWARENESS_REQUEST_CONTEXT_KEY } from "../agent-run/todoAwareness.js";

type RequestContextLike = {
  get?: (key: string) => unknown;
};

type TodoAwarenessContentSource =
  | string
  | (() => string | null | undefined)
  | null
  | undefined;

type PromptOptions = {
  prompt?: unknown;
};

export function appendTodoAwarenessToPromptOptions<T extends PromptOptions>(
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
    prompt: [...promptMessages, todoAwarenessPromptMessage(content)],
  };
}

export function todoAwarenessContentFromRequestContext(
  requestContext: RequestContextLike | undefined,
): string | null {
  return resolveTodoAwarenessContent(todoAwarenessSourceFromRequestContext(requestContext));
}

export function todoAwarenessSourceFromRequestContext(
  requestContext: RequestContextLike | undefined,
): TodoAwarenessContentSource {
  const raw = requestContext?.get?.(TODO_AWARENESS_REQUEST_CONTEXT_KEY);
  if (typeof raw === "function" || typeof raw === "string") return raw as TodoAwarenessContentSource;
  return null;
}

export function resolveTodoAwarenessContent(
  source: TodoAwarenessContentSource,
): string | null {
  const raw = typeof source === "function" ? source() : source;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

type PromptCallModel = {
  doGenerate(...args: any[]): PromiseLike<unknown>;
  doStream(...args: any[]): PromiseLike<unknown>;
};

export function wrapModelWithTodoAwareness<T extends PromptCallModel>(
  model: T,
  source: TodoAwarenessContentSource,
): T {
  if (!source) return model;
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") {
        return (...args: any[]) => {
          const content = resolveTodoAwarenessContent(source);
          if (!content) return Reflect.get(target, prop, target).apply(target, args);
          const callArgs = appendTodoAwarenessToFirstArg(args, content);
          return Reflect.get(target, prop, target).apply(target, callArgs);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function appendTodoAwarenessToFirstArg(
  args: any[],
  content: string,
): any[] {
  if (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) return args;
  const nextOptions = appendTodoAwarenessToPromptOptions(args[0], content);
  if (nextOptions === args[0]) return args;
  return [nextOptions, ...args.slice(1)];
}

function todoAwarenessPromptMessage(content: string) {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
  };
}

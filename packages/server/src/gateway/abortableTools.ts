import type { ToolsInput } from "@mastra/core/agent";

type ToolContext = Record<string, unknown> & {
  abortSignal?: AbortSignal;
  outputWriter?: (...args: unknown[]) => Promise<unknown>;
  writer?: object;
};

type ExecutableTool = object & {
  execute?: (input: unknown, context?: ToolContext) => unknown;
};

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation aborted",
  );
  error.name = "AbortError";
  return error;
}

function abortableWriter<T extends object>(writer: T, signal: AbortSignal): T {
  return new Proxy(writer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property !== "write" && property !== "custom") || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (signal.aborted) return Promise.reject(abortError(signal));
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function abortableOutputWriter(
  writer: (...args: unknown[]) => Promise<unknown>,
  signal: AbortSignal,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return writer(...args);
  };
}

/**
 * 把一次恢复轮的控制器钉到工具执行外层。
 *
 * Mastra 会把 abortSignal 传给工具上下文，但不消费 signal 的长耗时工具 Promise
 * 仍会被工作流 await，且可继续向 writer 写进度。这里不改工具实现：外层在 abort
 * 时立即结束本次工具调用，同时封住取消后的进度写入；底层若消费 signal，也会收到
 * 同一个恢复轮 signal 并中止自身 I/O。
 */
function bindToolToAbortSignal<T extends ExecutableTool>(
  tool: T,
  signal: AbortSignal,
): T {
  const execute = tool.execute;
  if (typeof execute !== "function") return tool;

  const wrappedExecute = async (input: unknown, context?: ToolContext): Promise<unknown> => {
    if (signal.aborted) throw abortError(signal);

    const nextContext: ToolContext = {
      ...(context ?? {}),
      abortSignal: signal,
    };
    if (context?.writer && typeof context.writer === "object") {
      nextContext.writer = abortableWriter(context.writer, signal);
    }
    if (typeof context?.outputWriter === "function") {
      nextContext.outputWriter = abortableOutputWriter(context.outputWriter, signal);
    }

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (callback: (value: unknown) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => settle(reject, abortError(signal));

      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw abortError(signal);
          return execute.call(tool, input, nextContext);
        })
        .then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
      if (signal.aborted) onAbort();
    });
  };

  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property === "execute") return wrappedExecute;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function bindToolsToAbortSignal(
  tools: ToolsInput,
  signal: AbortSignal,
): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      tool && typeof tool === "object"
        ? bindToolToAbortSignal(tool as ExecutableTool, signal)
        : tool,
    ]),
  ) as ToolsInput;
}

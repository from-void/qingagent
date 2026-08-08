import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
const getDeepseekModelMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("ai-v5", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", async (importActual) => {
  const actual = await importActual<typeof import("../llm/modelConfig.js")>();
  return { ...actual, getDeepseekModel: getDeepseekModelMock };
});

const { testTextModelConnection } = await import("../llm/textConnectionTest.js");

function fullStream(parts: Array<{ type: string; error?: unknown }>): AsyncIterable<unknown> {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

function silentAfterAbort(signal: AbortSignal): AsyncIterable<unknown> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (false) yield undefined;
  })();
}

const INPUT = {
  apiKey: "k",
  baseUrl: "https://model.example/v1",
  model: "m",
  protocol: "openai" as const,
};

describe("testTextModelConnection", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    getDeepseekModelMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fullStream abort part 判为失败，不把中止闭流当成功", async () => {
    streamTextMock.mockReturnValue({ fullStream: fullStream([{ type: "abort" }]) });

    await expect(testTextModelConnection(INPUT)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("超时后 fullStream 静默闭流仍抛原 TimeoutError", async () => {
    vi.useFakeTimers();
    streamTextMock.mockImplementation((options: { abortSignal: AbortSignal }) => ({
      fullStream: silentAfterAbort(options.abortSignal),
    }));

    const pending = testTextModelConnection({ ...INPUT, timeoutMs: 100 });
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });
});

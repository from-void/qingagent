import { describe, expect, it, vi } from "vitest";
import {
  isBlockedAddressStreamErrorChunk,
  isTransientStreamErrorChunk,
  streamErrorDetails,
  withIdleTimeout,
} from "./streamErrors.js";

function errorChunk(message: string, statusCode?: number) {
  const error = Object.assign(new Error(message), { statusCode });
  return { type: "error", payload: { error } };
}

describe("withIdleTimeout 迭代器收尾", () => {
  it("消费方 break 后转发底层 return 并执行 async generator finally", async () => {
    const finalized = vi.fn();
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        finalized();
      }
    }

    for await (const value of withIdleTimeout(source(), 10_000, vi.fn())) {
      expect(value).toBe(1);
      break;
    }

    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
  });

  it("外部 signal 可提前结束挂起的 next 并尽力调用底层 return", async () => {
    const controller = new AbortController();
    const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(() => new Promise<IteratorResult<number>>(() => undefined)),
          return: returnSpy,
        };
      },
    };
    const wrapped = withIdleTimeout(source, 10_000, vi.fn(), {
      abortSignal: controller.signal,
    });
    const pending = wrapped.next();
    controller.abort(new DOMException("用户取消", "AbortError"));

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(returnSpy).toHaveBeenCalledTimes(1));
  });

  it("底层自然 done 时不额外调用 return", async () => {
    const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(async () => ({ done: true as const, value: undefined })),
          return: returnSpy,
        };
      },
    };

    await expect(withIdleTimeout(source, 10_000, vi.fn()).next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(returnSpy).not.toHaveBeenCalled();
  });
});

describe("stream error 分类", () => {
  it.each([404, 422])(
    "非白名单 HTTP %s 归为不可重试的请求错误",
    (statusCode) => {
      expect(streamErrorDetails(errorChunk("request rejected", statusCode))).toEqual({
        reason: "模型请求无法处理，请检查模型配置或调整输入。",
        retriable: false,
        statusCode,
        category: "request",
        userMessage: "模型请求无法处理，请检查模型配置或调整输入。",
        action: "none",
      });
    },
  );

  it("400 maximum context length 明确说明素材超出上下文并给出处理办法", () => {
    expect(streamErrorDetails(errorChunk("maximum context length exceeded", 400))).toEqual({
      reason: "素材或对话内容超出模型上下文长度。请删除部分素材、改用摘要，或拆分后分段处理。",
      retriable: false,
      statusCode: 400,
      category: "request",
      userMessage: "素材或对话内容超出模型上下文长度。请删除部分素材、改用摘要，或拆分后分段处理。",
      action: "none",
    });
  });

  it("413 明确说明请求中的素材体量过大且与 400 文案不同", () => {
    expect(streamErrorDetails(errorChunk("payload too large", 413))).toEqual({
      reason: "请求中的素材或内容体量过大，模型服务拒绝接收。请删除部分素材、改用摘要，或拆分后分段处理。",
      retriable: false,
      statusCode: 413,
      category: "request",
      userMessage: "请求中的素材或内容体量过大，模型服务拒绝接收。请删除部分素材、改用摘要，或拆分后分段处理。",
      action: "none",
    });
  });

  it("业务错误中的 terminated 不触发自动瞬态重试", () => {
    expect(
      isTransientStreamErrorChunk(
        errorChunk("workflow terminated because the request is invalid"),
      ),
    ).toBe(false);
  });

  it("明确的连接重置错误仍可触发自动瞬态重试", () => {
    expect(isTransientStreamErrorChunk(errorChunk("read ECONNRESET"))).toBe(true);
  });

  it("普通网络错误仍是笼统的可重试连接失败", () => {
    expect(streamErrorDetails(errorChunk("fetch failed"))).toEqual({
      reason: "模型服务连接失败，请重试。",
      retriable: true,
      category: "network",
      userMessage: "模型服务连接失败，请重试。",
      action: "retry",
    });
  });

  it.each([
    [
      "预检直抛原文",
      errorChunk(
        "Blocked private/non-global-unicast address for api.example.com: 10.20.30.40",
      ),
    ],
    [
      "AI SDK 包装成 Cannot connect to API",
      errorChunk(
        "Cannot connect to API: Blocked private/non-global-unicast address for api.example.com: 10.20.30.40",
      ),
    ],
    [
      "原始错误只挂在 cause 链上",
      {
        type: "error",
        payload: {
          error: new Error("fetch failed", {
            cause: new Error(
              "Blocked private/non-global-unicast address for api.example.com: 10.20.30.40",
            ),
          }),
        },
      },
    ],
  ])("内网地址被本地策略拦截时透出真实原因(%s)", (_case, chunk) => {
    expect(streamErrorDetails(chunk)).toEqual({
      reason:
        "模型地址解析为内网地址，被本地安全策略拦截。" +
        "若这是公司或自建的内网模型服务：桌面客户端请更新到最新版（已默认放行）；" +
        "自部署请设置 QINGAGENT_ALLOW_PRIVATE_MODEL_HOST=1。",
      retriable: false,
      category: "blocked_address",
      userMessage:
        "模型地址解析为内网地址，被本地安全策略拦截。" +
        "若这是公司或自建的内网模型服务：桌面客户端请更新到最新版（已默认放行）；" +
        "自部署请设置 QINGAGENT_ALLOW_PRIVATE_MODEL_HOST=1。",
      action: "check_model_settings",
    });
    expect(isBlockedAddressStreamErrorChunk(chunk)).toBe(true);
    expect(isTransientStreamErrorChunk(chunk)).toBe(false);
  });

  it("上游返回的 HTTP 状态码优先，不被地址拦截判别抢走", () => {
    expect(
      streamErrorDetails(errorChunk("Blocked loopback address for x: 127.0.0.1", 500)),
    ).toMatchObject({ category: "upstream", statusCode: 500 });
  });
});

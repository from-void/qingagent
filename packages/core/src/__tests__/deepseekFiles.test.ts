import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { OFFICIAL_DEEPSEEK_BASE_URL } from "../llm/modelBaseUrl.js";
import {
  DEEPSEEK_FILE_SENTINEL_URL_RE,
  resolveDeepseekFileTransport,
  type DeepseekFileTransportConfig,
} from "../llm/deepseekFiles.js";

const modelFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/modelTransport.js", () => ({ modelFetch: modelFetchMock }));

function config(
  overrides: Partial<DeepseekFileTransportConfig> = {},
): DeepseekFileTransportConfig {
  return {
    apiKey: "sk-files-test",
    baseUrl: OFFICIAL_DEEPSEEK_BASE_URL,
    protocol: "openai",
    provider: "deepseek",
    ...overrides,
  };
}

function image(value: string, mimeType = "image/png") {
  return { buffer: Buffer.from(value), mimeType };
}

function uploadResponse(
  id: string,
  expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
): Response {
  return Response.json({
    id,
    bytes: 3,
    created_at: Math.floor(Date.now() / 1000),
    filename: "image.png",
    purpose: "user_data",
    expires_at: expiresAt,
  });
}

describe("DeepSeek Files transport", () => {
  beforeEach(() => {
    modelFetchMock.mockReset();
    modelFetchMock.mockResolvedValue(uploadResponse("file-api-default"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("只对 DeepSeek 官方 OpenAI 端点启用", () => {
    expect(resolveDeepseekFileTransport(config())).not.toBeNull();
    expect(resolveDeepseekFileTransport(config({ baseUrl: "https://proxy.example.com/v1" }))).toBeNull();
    expect(resolveDeepseekFileTransport(config({ protocol: "anthropic" }))).toBeNull();
    expect(resolveDeepseekFileTransport(config({ provider: "custom" }))).toBeNull();
  });

  it("上传 multipart 带鉴权、用途、保留期与按 MIME 推导的文件名", async () => {
    modelFetchMock.mockResolvedValue(uploadResponse("file-api-multipart"));
    const transport = resolveDeepseekFileTransport(config())!;

    const result = await transport.ensureFileSentinelUrl(image("multipart", "image/jpeg"));

    expect(result).toEqual({
      sentinelUrl: "https://qingagent-file-id.invalid/file-api-multipart",
      fileId: "file-api-multipart",
    });
    expect(DEEPSEEK_FILE_SENTINEL_URL_RE.test(result.sentinelUrl)).toBe(true);
    expect(modelFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = modelFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OFFICIAL_DEEPSEEK_BASE_URL}/files`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-files-test");
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    const body = init.body as FormData;
    expect(body.get("purpose")).toBe("user_data");
    expect(body.get("expires_after[anchor]")).toBe("created_at");
    expect(body.get("expires_after[seconds]")).toBe("604800");
    expect((body.get("file") as File).name).toBe("image.jpg");
  });

  it("同 key 同图命中缓存，换 API key 不串 Files 归属", async () => {
    modelFetchMock
      .mockResolvedValueOnce(uploadResponse("file-api-key-a"))
      .mockResolvedValueOnce(uploadResponse("file-api-key-b"));
    const input = image("same-image");

    const first = await resolveDeepseekFileTransport(config({ apiKey: "sk-key-a" }))!
      .ensureFileSentinelUrl(input);
    const cached = await resolveDeepseekFileTransport(config({ apiKey: "sk-key-a" }))!
      .ensureFileSentinelUrl(input);
    const anotherKey = await resolveDeepseekFileTransport(config({ apiKey: "sk-key-b" }))!
      .ensureFileSentinelUrl(input);

    expect(cached).toEqual(first);
    expect(anotherKey.fileId).toBe("file-api-key-b");
    expect(modelFetchMock).toHaveBeenCalledTimes(2);
  });

  it("服务端 expires_at 是缓存权威，临期不足一小时重新上传", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    const firstExpiresAt = Math.floor(Date.now() / 1000) + 3_700;
    modelFetchMock
      .mockResolvedValueOnce(uploadResponse("file-api-expiry-old", firstExpiresAt))
      .mockResolvedValueOnce(uploadResponse("file-api-expiry-new", firstExpiresAt + 604_800));
    const transport = resolveDeepseekFileTransport(config({ apiKey: "sk-expiry" }))!;
    const input = image("expiry-image");

    expect((await transport.ensureFileSentinelUrl(input)).fileId).toBe("file-api-expiry-old");
    await vi.advanceTimersByTimeAsync(200_000);
    expect((await transport.ensureFileSentinelUrl(input)).fileId).toBe("file-api-expiry-new");
    expect(modelFetchMock).toHaveBeenCalledTimes(2);
  });

  it("同键并发共享一次上传，失败后清除 in-flight 允许重试", async () => {
    let finishUpload!: (response: Response) => void;
    modelFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      finishUpload = resolve;
    }));
    const transport = resolveDeepseekFileTransport(config({ apiKey: "sk-single-flight" }))!;
    const input = image("single-flight");
    const pending = Array.from({ length: 8 }, () => transport.ensureFileSentinelUrl(input));
    expect(modelFetchMock).toHaveBeenCalledTimes(1);
    finishUpload(uploadResponse("file-api-single-flight"));
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 8 }, () => ({
      sentinelUrl: "https://qingagent-file-id.invalid/file-api-single-flight",
      fileId: "file-api-single-flight",
    })));

    modelFetchMock.mockRejectedValueOnce(new Error("upload failed"));
    const retryTransport = resolveDeepseekFileTransport(config({ apiKey: "sk-single-flight-retry" }))!;
    const retryInput = image("single-flight-retry");
    await expect(retryTransport.ensureFileSentinelUrl(retryInput)).rejects.toThrow("upload failed");
    modelFetchMock.mockResolvedValueOnce(uploadResponse("file-api-after-failure"));
    await expect(retryTransport.ensureFileSentinelUrl(retryInput))
      .resolves.toMatchObject({ fileId: "file-api-after-failure" });
  });

  it.each([
    ["非 2xx", () => new Response("bad", { status: 500 })],
    ["脏 JSON", () => new Response("not-json", { status: 200 })],
    ["非法 id", () => uploadResponse("bad-id")],
    ["非法 expires_at", () => Response.json({ id: "file-api-bad-expiry", expires_at: 0 })],
  ])("%s 响应抛错且不进入缓存", async (_caseName, badResponse) => {
    const unique = `invalid-${_caseName}`;
    modelFetchMock
      .mockResolvedValueOnce(badResponse())
      .mockResolvedValueOnce(uploadResponse(`file-api-valid-${Buffer.from(unique).toString("hex")}`));
    const transport = resolveDeepseekFileTransport(config({ apiKey: `sk-${unique}` }))!;
    const input = image(unique);

    await expect(transport.ensureFileSentinelUrl(input)).rejects.toThrow();
    await expect(transport.ensureFileSentinelUrl(input)).resolves.toMatchObject({
      fileId: expect.stringMatching(/^file-api-valid-/),
    });
    expect(modelFetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidate 只删除仍指向失败 id 的缓存，并以 DELETE 尽力清理远端", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    const nearExpiry = Math.floor(Date.now() / 1000) + 3_599;
    modelFetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const postCount = modelFetchMock.mock.calls.filter((call) => call[1]?.method === "POST").length;
      return postCount === 1
        ? uploadResponse("file-api-invalid-old", nearExpiry)
        : uploadResponse("file-api-invalid-new");
    });
    const transport = resolveDeepseekFileTransport(config({ apiKey: "sk-invalidate" }))!;
    const input = image("invalidate-image");

    expect((await transport.ensureFileSentinelUrl(input)).fileId).toBe("file-api-invalid-old");
    expect((await transport.ensureFileSentinelUrl(input)).fileId).toBe("file-api-invalid-new");
    transport.invalidate(input, "file-api-invalid-old");
    expect((await transport.ensureFileSentinelUrl(input)).fileId).toBe("file-api-invalid-new");
    expect(modelFetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(0);

    transport.invalidate(input, "file-api-invalid-new");
    await vi.waitFor(() => {
      expect(modelFetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(1);
    });
    const deleteCall = modelFetchMock.mock.calls.find((call) => call[1]?.method === "DELETE")!;
    expect(deleteCall[0]).toBe(`${OFFICIAL_DEEPSEEK_BASE_URL}/files/file-api-invalid-new`);
    expect(new Headers(deleteCall[1]?.headers).get("authorization")).toBe("Bearer sk-invalidate");
  });

  it("外部 signal 已取消时立即抛原 AbortError 且不发上传", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户取消", "AbortError");
    controller.abort(reason);

    await expect(resolveDeepseekFileTransport(config({ apiKey: "sk-aborted" }))!
      .ensureFileSentinelUrl(image("aborted"), controller.signal)).rejects.toBe(reason);
    expect(modelFetchMock).not.toHaveBeenCalled();
  });

  it("上传进行中外部 signal abort 时 ensure 原样抛出取消原因", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户取消进行中的上传", "AbortError");
    modelFetchMock.mockImplementationOnce((_url: unknown, init?: RequestInit) => new Promise(
      (_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      },
    ));
    const pending = resolveDeepseekFileTransport(config({ apiKey: "sk-abort-in-flight" }))!
      .ensureFileSentinelUrl(image("abort-in-flight"), controller.signal);
    await vi.waitFor(() => expect(modelFetchMock).toHaveBeenCalledTimes(1));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("LRU 淘汰只清本地：已返回 id 可继续使用，后续同图才重新上传", async () => {
    let nextId = 0;
    modelFetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      nextId += 1;
      return uploadResponse(`file-api-lru-${nextId}`);
    });
    const transport = resolveDeepseekFileTransport(config({ apiKey: "sk-lru" }))!;
    const target = image("lru-target");
    const acquired = await transport.ensureFileSentinelUrl(target);
    for (let index = 0; index < 128; index += 1) {
      await transport.ensureFileSentinelUrl(image(`lru-filler-${index}`));
    }

    expect(acquired).toEqual({
      sentinelUrl: "https://qingagent-file-id.invalid/file-api-lru-1",
      fileId: "file-api-lru-1",
    });
    expect(modelFetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(0);
    expect((await transport.ensureFileSentinelUrl(target)).fileId).toBe("file-api-lru-130");
    expect(modelFetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(0);
  });
});

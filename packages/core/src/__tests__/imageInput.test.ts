import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("node:dns/promises", () => ({
  lookup: dnsMocks.lookup,
}));

const undiciMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  agentOptions: [] as Array<{
    connect?: {
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void;
    };
  }>,
  close: vi.fn(async () => undefined),
}));

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: (typeof undiciMocks.agentOptions)[number]) {
      undiciMocks.agentOptions.push(options);
    }
    close = undiciMocks.close;
  },
  fetch: undiciMocks.fetch,
}));

import {
  downloadRemoteImage,
  ImageInputError,
  MAX_IMAGE_BYTES,
  resolveImageInput,
} from "../tools/imageInput.js";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function expectImageInputKind(error: unknown, kind: ImageInputError["kind"]): void {
  expect(error).toBeInstanceOf(ImageInputError);
  expect((error as ImageInputError).kind).toBe(kind);
}

beforeEach(() => {
  dnsMocks.lookup.mockReset();
  dnsMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  undiciMocks.fetch.mockReset();
  undiciMocks.agentOptions.length = 0;
  undiciMocks.close.mockClear();
});

afterEach(() => vi.useRealTimers());

function responseWithCancel(
  body: Uint8Array | string,
  init: ResponseInit,
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel,
    }),
    init,
  );
  return { response, cancel };
}

describe("resolveImageInput dirty path", () => {
  it("拒绝非法 URL/地址形态", async () => {
    await expect(resolveImageInput("not-an-image-address")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "invalid_url");
      return true;
    });
  });

  it("拒绝本地上传路径穿越", async () => {
    await expect(resolveImageInput(`/api/v1/files/${VALID_UUID}/../secret.png`)).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "invalid_path");
      return true;
    });
  });

  it("裸 fileId 不存在时失败关闭", async () => {
    await expect(resolveImageInput(VALID_UUID)).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "not_found");
      return true;
    });
  });

  it("远程图片 Content-Length 超过上限时不读入 body", async () => {
    const oversized = responseWithCancel(PNG_1X1, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(MAX_IMAGE_BYTES + 1),
        },
      });
    undiciMocks.fetch.mockResolvedValue(oversized.response);

    await expect(resolveImageInput("https://example.com/too-large.png")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "too_large");
      return true;
    });
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it("拒绝非图片 MIME", async () => {
    const nonImage = responseWithCancel("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    undiciMocks.fetch.mockResolvedValue(nonImage.response);

    await expect(resolveImageInput("https://example.com/not-image.txt")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "unsupported_media");
      return true;
    });
    expect(nonImage.cancel).toHaveBeenCalledOnce();
  });

  it("拒绝 MIME 与魔数不符的伪图片", async () => {
    undiciMocks.fetch.mockResolvedValue(
      new Response("not a png", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(resolveImageInput("https://example.com/fake.png")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "unsupported_media");
      return true;
    });
  });

  it("每跳连接 lookup 固定为校验时公网 IP，后续 DNS 重绑定到环回不生效", async () => {
    dnsMocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    undiciMocks.fetch.mockResolvedValue(
      new Response(PNG_1X1, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(downloadRemoteImage("https://rebind.example/image.png")).resolves.toMatchObject({
      mimeType: "image/png",
    });

    const pinnedLookup = undiciMocks.agentOptions[0]?.connect?.lookup;
    expect(pinnedLookup).toBeTypeOf("function");
    const connected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup?.("rebind.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    expect(connected).toEqual({ address: "93.184.216.34", family: 4 });
    expect(dnsMocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("重定向链复用同一总 deadline signal，并取消上一跳 body", async () => {
    const redirect = responseWithCancel("redirect", {
      status: 302,
      headers: { location: "/final.png" },
    });
    undiciMocks.fetch
      .mockResolvedValueOnce(redirect.response)
      .mockResolvedValueOnce(
        new Response(PNG_1X1, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );

    await expect(downloadRemoteImage("https://example.com/start")).resolves.toMatchObject({
      mimeType: "image/png",
    });
    expect(redirect.cancel).toHaveBeenCalledOnce();
    expect(undiciMocks.fetch).toHaveBeenCalledTimes(2);
    const firstSignal = undiciMocks.fetch.mock.calls[0]?.[1]?.signal;
    const secondSignal = undiciMocks.fetch.mock.calls[1]?.[1]?.signal;
    expect(firstSignal).toBe(secondSignal);
  });

  it("非 2xx 响应在报错前取消 body", async () => {
    const failed = responseWithCancel("error", { status: 503 });
    undiciMocks.fetch.mockResolvedValue(failed.response);

    await expect(downloadRemoteImage("https://example.com/error.png")).rejects.toMatchObject({
      kind: "network",
    });
    expect(failed.cancel).toHaveBeenCalledOnce();
  });

  it("父 signal 会直接取消正在下载的图片请求", async () => {
    const parent = new AbortController();
    undiciMocks.fetch.mockImplementation(
      async (_url: unknown, init: { signal?: AbortSignal }) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const reason = new DOMException("用户取消", "AbortError");
    const pending = downloadRemoteImage("https://example.com/slow.png", parent.signal);
    await vi.waitFor(() => expect(undiciMocks.fetch).toHaveBeenCalledOnce());
    parent.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

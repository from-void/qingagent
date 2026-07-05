import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
  ImageInputError,
  MAX_IMAGE_BYTES,
  resolveImageInput,
} from "../tools/imageInput.js";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function expectImageInputKind(error: unknown, kind: ImageInputError["kind"]): void {
  expect(error).toBeInstanceOf(ImageInputError);
  expect((error as ImageInputError).kind).toBe(kind);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(MAX_IMAGE_BYTES + 1),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveImageInput("https://example.com/too-large.png")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "too_large");
      return true;
    });
  });

  it("拒绝非图片 MIME", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ));

    await expect(resolveImageInput("https://example.com/not-image.txt")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "unsupported_media");
      return true;
    });
  });

  it("拒绝 MIME 与魔数不符的伪图片", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("not a png", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    ));

    await expect(resolveImageInput("https://example.com/fake.png")).rejects.toSatisfy((error: unknown) => {
      expectImageInputKind(error, "unsupported_media");
      return true;
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  uploadAssetFile,
  uploadFailureMessage,
  uploadedAssetUrl,
} from "./uploadAsset";

describe("uploadAssetFile", () => {
  afterEach(() => {
    MockUploadRequest.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("uploads a file through the durable upload API and reports progress", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const progress = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], "figure.png", { type: "image/png" });

    const pending = uploadAssetFile(file, { onProgress: progress });
    const xhr = await waitForRequest();
    xhr.emitProgress(2, 4);
    xhr.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "figure.png",
      mimeType: "image/png",
      size: 3,
    });
    const uploaded = await pending;

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/v1/upload");
    expect(xhr.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(xhr.body)).toEqual({
      filename: "figure.png",
      mimeType: "image/png",
      content: "AQID",
    });
    expect(progress).toHaveBeenCalledWith(50);
    expect(uploadedAssetUrl(uploaded)).toBe("/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png");
  });

  it("throws on upload failure before callers receive a durable asset", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["x"], "bad.png", { type: "image/png" });

    const pending = uploadAssetFile(file);
    const xhr = await waitForRequest();
    xhr.reject(500, "nope");

    await expect(pending).rejects.toThrow("文件上传失败，请重试");
  });

  it("does not expose raw server JSON error text when upload fails", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["x"], "../bad.png", { type: "image/png" });

    const pending = uploadAssetFile(file);
    const xhr = await waitForRequest();
    xhr.reject(400, JSON.stringify({ error: "filename must not contain path separators or '..'" }));

    await expect(pending).rejects.toThrow("文件上传失败，请重试");
    await expect(pending).rejects.not.toThrow("path separators");
  });

  it("素材用途随请求发送，并把稳定预检码映射为可读失败", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["not-office"], "bad.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const pending = uploadAssetFile(file, { purpose: "material" });
    const xhr = await waitForRequest();
    expect(JSON.parse(xhr.body)).toMatchObject({
      filename: "bad.docx",
      purpose: "material",
    });
    xhr.reject(422, JSON.stringify({ error: "material_format_mismatch" }));

    await expect(pending).rejects.toMatchObject({
      code: "material_format_mismatch",
      message: "文件格式与内容不一致",
      retryable: false,
    });
  });

  it("preflights the default decoded-byte limit before reading or creating XHR", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(file, "size", { value: DEFAULT_UPLOAD_MAX_BYTES + 1 });

    await expect(uploadAssetFile(file)).rejects.toThrow("文件过大（上限 50 MB）");
    expect(MockUploadRequest.instances).toEqual([]);
  });

  it("maps 413 and the server maxBytes contract to a clear localized message", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["x"], "large.bin", { type: "application/octet-stream" });

    const pending = uploadAssetFile(file);
    const xhr = await waitForRequest();
    xhr.reject(413, JSON.stringify({ error: "file_too_large", maxBytes: 10 * 1024 * 1024 }));

    await expect(pending).rejects.toThrow("文件过大（上限 10 MB）");
  });

  it("only forwards file-too-large details through production toast helpers", () => {
    expect(uploadFailureMessage(new Error("文件过大（上限 10 MB）"), "上传失败")).toBe(
      "文件过大（上限 10 MB）",
    );
    expect(uploadFailureMessage(new Error("internal path leaked"), "上传失败")).toBe("上传失败");
  });
});

class MockUploadRequest {
  static instances: MockUploadRequest[] = [];

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body = "";
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockUploadRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: string) {
    this.body = body;
  }

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }

  resolve(body: unknown) {
    this.status = 200;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }

  reject(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

async function waitForRequest(): Promise<MockUploadRequest> {
  for (let i = 0; i < 20; i += 1) {
    const request = MockUploadRequest.instances[0];
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("XMLHttpRequest was not created");
}

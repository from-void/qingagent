import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAssetFile, uploadedAssetUrl } from "./uploadAsset";

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

    await expect(pending).rejects.toThrow("Upload failed for bad.png: 500");
  });

  it("uses server JSON error text when upload fails", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const file = new File(["x"], "../bad.png", { type: "image/png" });

    const pending = uploadAssetFile(file);
    const xhr = await waitForRequest();
    xhr.reject(400, JSON.stringify({ error: "filename must not contain path separators or '..'" }));

    await expect(pending).rejects.toThrow(
      "filename must not contain path separators or '..'",
    );
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

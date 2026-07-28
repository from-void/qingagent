// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertFileAsset, insertImageAsset, UPLOAD_PLACEHOLDER_IMAGE_SRC } from "./insertUploadedAsset";

describe("insertUploadedAsset", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    MockUploadRequest.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("图片上传 pending 时立即插入合法占位节点,完成后替换为 durable files URL", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertImageAsset(editor, imageFile());
    let attrs = firstImageAttrs(editor);
    expect(attrs.src).toBe(UPLOAD_PLACEHOLDER_IMAGE_SRC);
    expect(attrs.alt).toBe("figure.png");
    expect(attrs.uploading).toBe(true);
    expect(attrs.blockId).toMatch(/^upload-image-/);

    const xhr = await waitForRequest();
    xhr.emitProgress(1, 4);
    attrs = firstImageAttrs(editor);
    expect(attrs.progress).toBe(25);

    xhr.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "figure.png",
      mimeType: "image/png",
      size: 3,
    });
    const src = await pending;

    expect(src).toBe("/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png");
    attrs = firstImageAttrs(editor);
    expect(attrs).toMatchObject({
      src,
      alt: "figure.png",
      uploading: false,
      progress: 100,
      error: false,
    });
    const normalizedImage = normalizePmDoc(editor.getJSON()).content.find((node) => node.type === "image");
    expect(normalizedImage?.attrs ?? {}).not.toHaveProperty("uploading");
  });

  it("图片上传失败时保留可见错误占位并抛出错误供 toast 使用", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertImageAsset(editor, imageFile());
    const xhr = await waitForRequest();
    xhr.reject(500, "nope");

    await expect(pending).rejects.toThrow("Upload failed");
    const attrs = firstImageAttrs(editor);
    expect(attrs.src).toBe(UPLOAD_PLACEHOLDER_IMAGE_SRC);
    expect(attrs.uploading).toBe(false);
    expect(attrs.error).toBe(true);
    expect(
      normalizePmDoc(editor.getJSON()).content.some((node) => node.type === "image"),
    ).toBe(false);
  });

  it("文件上传时立即在发起位置插入稳定占位,移动光标后仍按 blockId 回写", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertFileAsset(editor, new File(["data"], "report.pdf", { type: "application/pdf" }));
    const placeholder = firstAttachmentAttrs(editor);
    expect(placeholder).toMatchObject({
      blockId: expect.stringMatching(/^upload-file-/),
      fileId: expect.stringMatching(/^upload-file-/),
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
      uploading: true,
    });
    expect(normalizePmDoc(editor.getJSON()).content.some((node) => node.type === "fileAttachment")).toBe(false);

    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      attrs: { blockId: "p-after-upload" },
      content: [{ type: "text", text: "继续编辑" }],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const xhr = await waitForRequest();
    xhr.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
    });
    await pending;

    const attachment = normalizePmDoc(editor.getJSON()).content.find((node) => node.type === "fileAttachment");
    expect(attachment).toMatchObject({
      type: "fileAttachment",
      attrs: {
        blockId: placeholder.blockId,
        fileId: "550e8400-e29b-41d4-a716-446655440000",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 4,
      },
    });
  });
});

function createEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "paragraph", attrs: { blockId: "p" } }],
    },
  });
}

function firstImage(editor: Editor) {
  return (editor.getJSON().content ?? []).find((node) => node.type === "image");
}

function firstImageAttrs(editor: Editor): Record<string, unknown> {
  const attrs = firstImage(editor)?.attrs;
  expect(attrs).toBeDefined();
  return attrs as Record<string, unknown>;
}

function firstAttachmentAttrs(editor: Editor): Record<string, unknown> {
  const attrs = (editor.getJSON().content ?? []).find(
    (node) => node.type === "fileAttachment",
  )?.attrs;
  expect(attrs).toBeDefined();
  return attrs as Record<string, unknown>;
}

function imageFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "figure.png", { type: "image/png" });
}

class MockUploadRequest {
  static instances: MockUploadRequest[] = [];

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockUploadRequest.instances.push(this);
  }

  open() {}
  setRequestHeader() {}
  send() {}

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("XMLHttpRequest was not created");
}

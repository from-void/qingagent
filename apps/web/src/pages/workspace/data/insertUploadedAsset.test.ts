// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insertFileAsset,
  insertImageAsset,
  insertImageAssets,
  replayPendingUploadPlaceholders,
  UPLOAD_PLACEHOLDER_FILE_ID_PREFIX,
  UPLOAD_PLACEHOLDER_IMAGE_SRC,
} from "./insertUploadedAsset";

Element.prototype.getClientRects = function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList;
};
Element.prototype.getBoundingClientRect = function () {
  return new DOMRect();
};
Range.prototype.getClientRects = function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList;
};
Range.prototype.getBoundingClientRect = function () {
  return new DOMRect();
};

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

    await expect(pending).rejects.toThrow("文件上传失败，请重试");
    const attrs = firstImageAttrs(editor);
    expect(attrs.src).toBe(UPLOAD_PLACEHOLDER_IMAGE_SRC);
    expect(attrs.uploading).toBe(false);
    expect(attrs.error).toBe(true);
    expect(
      normalizePmDoc(editor.getJSON()).content.some((node) => node.type === "image"),
    ).toBe(false);
  });

  it("多图先按顺序同步插入整批占位,再并发上传并分别回写", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();
    const files = [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
    ];

    const uploads = insertImageAssets(editor, files);
    const placeholders = allImageAttrs(editor);
    expect(placeholders.map((attrs) => attrs.alt)).toEqual(["first.png", "second.png"]);
    expect(placeholders.every((attrs) => attrs.uploading === true)).toBe(true);
    await waitForRequestCount(2);
    expect(MockUploadRequest.instances).toHaveLength(2);

    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      attrs: { blockId: "p-after-images" },
      content: [{ type: "text", text: "上传期间继续编辑" }],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    MockUploadRequest.instances[1]!.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440002",
      filename: "second.png",
      mimeType: "image/png",
      size: 6,
    });
    MockUploadRequest.instances[0]!.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440001",
      filename: "first.png",
      mimeType: "image/png",
      size: 5,
    });
    await Promise.all(uploads);

    expect(allImageAttrs(editor).map((attrs) => attrs.src)).toEqual([
      "/api/v1/files/550e8400-e29b-41d4-a716-446655440001/first.png",
      "/api/v1/files/550e8400-e29b-41d4-a716-446655440002/second.png",
    ]);
  });

  it("图片上传完成时若占位已被外部正文替换，必须抛错而非静默成功", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertImageAsset(editor, imageFile());
    const xhr = await waitForRequest();
    editor.commands.setContent({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "external" },
        content: [{ type: "text", text: "外部版本" }],
      }],
    });
    xhr.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "figure.png",
      mimeType: "image/png",
      size: 3,
    });

    await expect(pending).rejects.toThrow("placeholder");
    expect(editor.getText()).toBe("外部版本");
  });

  it("外部正文同步时按原块位置重放在途图片占位，完成后仍能原位写回", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertImageAsset(editor, imageFile());
    const xhr = await waitForRequest();
    const liveContent = editor.getJSON().content ?? [];
    const originalIndex = liveContent.findIndex((node) => node.type === "image");
    const incoming = normalizePmDoc(editor.getJSON());
    expect(incoming.content.some((node) => node.type === "image")).toBe(false);

    const replayed = replayPendingUploadPlaceholders(editor, incoming);
    expect(replayed.content.findIndex((node) => node.type === "image")).toBe(
      originalIndex,
    );
    editor.commands.setContent(replayed);
    xhr.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "figure.png",
      mimeType: "image/png",
      size: 3,
    });

    const src = await pending;
    expect(firstImageAttrs(editor)).toMatchObject({
      src,
      uploading: false,
      progress: 100,
      error: false,
    });
  });

  it("外部同步会在原表格单元格内按序重放多个在途图片，不降级到文档根部", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createTableEditor();
    editor.commands.setTextSelection(findBlockTextPosition(editor, "cell-anchor"));

    const firstPending = insertImageAsset(
      editor,
      new File(["a"], "first.png", { type: "image/png" }),
    );
    const secondPending = insertImageAsset(
      editor,
      new File(["b"], "second.png", { type: "image/png" }),
    );
    const firstRequest = await waitForRequest(0);
    const secondRequest = await waitForRequest(1);
    const liveCell = firstTableCell(editor.getJSON());
    const liveImageIds = (liveCell.content ?? [])
      .filter((node) => node.type === "image")
      .map((node) => node.attrs?.blockId);
    expect(liveImageIds).toHaveLength(2);

    const incoming = normalizePmDoc(editor.getJSON());
    expect((firstTableCell(incoming).content ?? []).some(
      (node) => node.type === "image",
    )).toBe(false);

    const missingAncestor = replayPendingUploadPlaceholders(
      editor,
      normalizePmDoc({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "paragraph", attrs: { blockId: "external" } }],
      }),
    );
    expect(missingAncestor.content.some((node) => node.type === "image")).toBe(false);

    const replayed = replayPendingUploadPlaceholders(editor, incoming);
    expect(replayed.content.some((node) => node.type === "image")).toBe(false);
    expect((firstTableCell(replayed).content ?? [])
      .filter((node) => node.type === "image")
      .map((node) => node.attrs?.blockId)).toEqual(liveImageIds);
    editor.commands.setContent(replayed as never);

    firstRequest.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440001",
      filename: "first.png",
      mimeType: "image/png",
      size: 1,
    });
    secondRequest.resolve({
      fileId: "550e8400-e29b-41d4-a716-446655440002",
      filename: "second.png",
      mimeType: "image/png",
      size: 1,
    });
    await Promise.all([firstPending, secondPending]);

    expect((firstTableCell(editor.getJSON()).content ?? [])
      .filter((node) => node.type === "image")
      .map((node) => node.attrs?.src)).toEqual([
      "/api/v1/files/550e8400-e29b-41d4-a716-446655440001/first.png",
      "/api/v1/files/550e8400-e29b-41d4-a716-446655440002/second.png",
    ]);
  });

  it("文件上传时立即在发起位置插入稳定占位,移动光标后仍按 blockId 回写", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    editor = createEditor();

    const pending = insertFileAsset(editor, new File(["data"], "report.pdf", { type: "application/pdf" }));
    const placeholder = firstAttachmentAttrs(editor);
    expect(placeholder).toMatchObject({
      blockId: expect.stringMatching(/^upload-file-/),
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
      uploading: true,
    });
    expect(placeholder.blockId).toMatch(/^upload-file-/);
    expect(placeholder.fileId).toBe(
      `${UPLOAD_PLACEHOLDER_FILE_ID_PREFIX}${placeholder.blockId}`,
    );
    expect(() => normalizePmDoc(editor!.getJSON())).not.toThrow();
    expect(
      normalizePmDoc(editor.getJSON()).content.some(
        (node) => node.type === "fileAttachment",
      ),
    ).toBe(false);

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

function createTableEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "table" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: {
              colspan: 1,
              rowspan: 1,
              colwidth: null,
              backgroundColor: null,
            },
            content: [{
              type: "paragraph",
              attrs: { blockId: "cell-anchor" },
              content: [{ type: "text", text: "单元格" }],
            }],
          }],
        }],
      }],
    },
  });
}

function createEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "paragraph", attrs: { blockId: "p" } }],
    },
  });
  vi.spyOn(
    editor.view as unknown as { scrollToSelection: () => void },
    "scrollToSelection",
  ).mockImplementation(() => undefined);
  return editor;
}

function findBlockTextPosition(editor: Editor, blockId: string): number {
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.blockId !== blockId) return true;
    position = pos + 1;
    return false;
  });
  expect(position).not.toBeNull();
  return position!;
}

interface TestJsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TestJsonNode[];
}

function firstTableCell(doc: unknown): TestJsonNode {
  const root = doc as TestJsonNode;
  const table = (root.content ?? []).find((node) => node.type === "table");
  const cell = table?.content?.[0]?.content?.[0];
  expect(cell?.type).toBe("tableCell");
  return cell!;
}

function firstImage(editor: Editor) {
  return (editor.getJSON().content ?? []).find((node) => node.type === "image");
}

function firstImageAttrs(editor: Editor): Record<string, unknown> {
  const attrs = firstImage(editor)?.attrs;
  expect(attrs).toBeDefined();
  return attrs as Record<string, unknown>;
}

function allImageAttrs(editor: Editor): Record<string, unknown>[] {
  return (editor.getJSON().content ?? [])
    .filter((node) => node.type === "image")
    .map((node) => node.attrs as Record<string, unknown>);
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

async function waitForRequest(index = 0): Promise<MockUploadRequest> {
  await waitForRequestCount(index + 1);
  return MockUploadRequest.instances[index]!;
}

async function waitForRequestCount(count: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (MockUploadRequest.instances.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${count} XMLHttpRequests to be created`);
}

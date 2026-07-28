import type { Editor } from "@tiptap/react";
import { uploadAssetFile, uploadedAssetUrl, type UploadedAsset } from "./uploadAsset";

type AssetEditor = Pick<Editor, "chain" | "state" | "view">;

export const UPLOAD_PLACEHOLDER_IMAGE_SRC = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" rx="24" fill="#f3efe7"/><path d="M252 186h136M320 118v136" stroke="#b8aa92" stroke-width="18" stroke-linecap="round"/></svg>',
)}`;

export async function insertImageAsset(editor: AssetEditor, file: File): Promise<string> {
  const [upload] = insertImageAssets(editor, [file]);
  if (!upload) throw new Error("Insert image placeholder failed");
  return upload;
}

export function insertImageAssets(
  editor: AssetEditor,
  files: readonly File[],
): Promise<string>[] {
  if (files.length === 0) return [];
  const targets = files.map((file) => ({
    blockId: createUploadImageBlockId(),
    file,
  }));
  const inserted = editor.chain().focus().insertContent(
    targets.map(({ blockId, file }) => ({
      type: "image",
      attrs: {
        blockId,
        src: UPLOAD_PLACEHOLDER_IMAGE_SRC,
        alt: file.name,
        uploading: true,
        progress: null,
        error: false,
      },
    })),
  ).run();
  if (!inserted) throw new Error("Insert image placeholder failed");

  return targets.map(({ blockId, file }) => uploadImageIntoPlaceholder(editor, blockId, file));
}

async function uploadImageIntoPlaceholder(
  editor: AssetEditor,
  blockId: string,
  file: File,
): Promise<string> {
  const uploaded = await uploadAssetFile(file, {
    onProgress: (progress) => {
      updateImageAttrsByBlockId(editor, blockId, {
        uploading: true,
        progress,
        error: false,
      });
    },
  }).catch((error) => {
    updateImageAttrsByBlockId(editor, blockId, {
      uploading: false,
      progress: null,
      error: true,
    });
    throw error;
  });
  const src = uploadedAssetUrl(uploaded);
  updateImageAttrsByBlockId(editor, blockId, {
    src,
    alt: file.name,
    uploading: false,
    progress: 100,
    error: false,
  });
  return src;
}

export async function insertFileAsset(editor: AssetEditor, file: File): Promise<UploadedAsset> {
  const blockId = createUploadBlockId("file");
  const inserted = editor.chain().focus().insertContent({
    type: "fileAttachment",
    attrs: {
      blockId,
      fileId: blockId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      uploading: true,
    },
  }).run();
  if (!inserted) throw new Error("Insert file placeholder failed");

  const uploaded = await uploadAssetFile(file).catch((error) => {
    deleteNodeByBlockId(editor, "fileAttachment", blockId);
    throw error;
  });
  updateNodeAttrsByBlockId(editor, "fileAttachment", blockId, {
    fileId: uploaded.fileId,
    filename: uploaded.filename,
    mimeType: uploaded.mimeType,
    size: uploaded.size,
    uploading: false,
  });
  return uploaded;
}

function createUploadImageBlockId(): string {
  return createUploadBlockId("image");
}

function createUploadBlockId(kind: "image" | "file"): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `upload-${kind}-${random}`;
}

function updateImageAttrsByBlockId(
  editor: AssetEditor,
  blockId: string,
  attrs: Record<string, unknown>,
): boolean {
  return updateNodeAttrsByBlockId(editor, "image", blockId, attrs);
}

function updateNodeAttrsByBlockId(
  editor: AssetEditor,
  nodeType: "image" | "fileAttachment",
  blockId: string,
  attrs: Record<string, unknown>,
): boolean {
  let found = false;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== nodeType || node.attrs.blockId !== blockId) return true;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    found = true;
    return false;
  });
  if (!found || !tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

function deleteNodeByBlockId(
  editor: AssetEditor,
  nodeType: "image" | "fileAttachment",
  blockId: string,
): boolean {
  let found = false;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== nodeType || node.attrs.blockId !== blockId) return true;
    tr.delete(pos, pos + node.nodeSize);
    found = true;
    return false;
  });
  if (!found || !tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

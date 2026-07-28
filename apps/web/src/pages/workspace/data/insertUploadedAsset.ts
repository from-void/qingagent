import type { Editor } from "@tiptap/react";
import type { PmDoc } from "@qingagent/pm-schema";
import { uploadAssetFile, uploadedAssetUrl, type UploadedAsset } from "./uploadAsset";

type AssetEditor = Pick<Editor, "chain" | "state" | "view">;

interface PendingUploadBookmark {
  blockId: string;
  node: PmJsonNode;
  parentBlockId: string | null;
  parentIsDoc: boolean;
  previousBlockId: string | null;
  nextBlockId: string | null;
  index: number;
}

interface PmJsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmJsonNode[];
  [key: string]: unknown;
}

const pendingUploadBlockIds = new WeakMap<AssetEditor, Set<string>>();

export const UPLOAD_PLACEHOLDER_IMAGE_SRC = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" rx="24" fill="#f3efe7"/><path d="M252 186h136M320 118v136" stroke="#b8aa92" stroke-width="18" stroke-linecap="round"/></svg>',
)}`;
export const UPLOAD_PLACEHOLDER_FILE_ID_PREFIX = "upload-pending:";

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
  for (const { blockId } of targets) registerPendingUpload(editor, blockId);

  return targets.map(({ blockId, file }) => uploadImageIntoPlaceholder(editor, blockId, file));
}

async function uploadImageIntoPlaceholder(
  editor: AssetEditor,
  blockId: string,
  file: File,
): Promise<string> {
  try {
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
    const updated = updateImageAttrsByBlockId(editor, blockId, {
      src,
      alt: file.name,
      uploading: false,
      progress: 100,
      error: false,
    });
    if (!updated) throw new Error("Image upload placeholder missing");
    return src;
  } finally {
    unregisterPendingUpload(editor, blockId);
  }
}

export async function insertFileAsset(editor: AssetEditor, file: File): Promise<UploadedAsset> {
  const blockId = createUploadBlockId("file");
  const inserted = editor.chain().focus().insertContent({
      type: "fileAttachment",
      attrs: {
        blockId,
        fileId: `${UPLOAD_PLACEHOLDER_FILE_ID_PREFIX}${blockId}`,
        filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      uploading: true,
    },
  }).run();
  if (!inserted) throw new Error("Insert file placeholder failed");
  registerPendingUpload(editor, blockId);

  try {
    const uploaded = await uploadAssetFile(file).catch((error) => {
      deleteNodeByBlockId(editor, "fileAttachment", blockId);
      throw error;
    });
    const updated = updateNodeAttrsByBlockId(
      editor,
      "fileAttachment",
      blockId,
      {
        fileId: uploaded.fileId,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        size: uploaded.size,
        uploading: false,
      },
    );
    if (!updated) throw new Error("File upload placeholder missing");
    return uploaded;
  } finally {
    unregisterPendingUpload(editor, blockId);
  }
}

export function replayPendingUploadPlaceholders(
  editor: AssetEditor,
  incoming: PmDoc,
): PmDoc {
  const blockIds = pendingUploadBlockIds.get(editor);
  if (!blockIds || blockIds.size === 0) return incoming;

  const bookmarks = collectPendingUploadBookmarks(editor, blockIds);
  let replayed = incoming as unknown as PmJsonNode;
  for (const bookmark of bookmarks) {
    if (containsBlockId(replayed, bookmark.blockId)) continue;
    const inserted = insertPendingUploadBookmark(replayed, bookmark);
    replayed = inserted.inserted
      ? inserted.node
      : insertAtRootFallback(replayed, bookmark);
  }
  return replayed as unknown as PmDoc;
}

export function hasPendingUploadPlaceholders(editor: AssetEditor): boolean {
  return (pendingUploadBlockIds.get(editor)?.size ?? 0) > 0;
}

function registerPendingUpload(editor: AssetEditor, blockId: string): void {
  const current = pendingUploadBlockIds.get(editor);
  if (current) {
    current.add(blockId);
    return;
  }
  pendingUploadBlockIds.set(editor, new Set([blockId]));
}

function unregisterPendingUpload(editor: AssetEditor, blockId: string): void {
  const current = pendingUploadBlockIds.get(editor);
  if (!current) return;
  current.delete(blockId);
  if (current.size === 0) pendingUploadBlockIds.delete(editor);
}

function collectPendingUploadBookmarks(
  editor: AssetEditor,
  blockIds: ReadonlySet<string>,
): PendingUploadBookmark[] {
  const bookmarks: PendingUploadBookmark[] = [];
  editor.state.doc.descendants((node, _pos, parent, index) => {
    const blockId = readBlockId(node.attrs.blockId);
    if (!blockId || !blockIds.has(blockId) || !parent) return true;
    bookmarks.push({
      blockId,
      node: node.toJSON() as PmJsonNode,
      parentBlockId: readBlockId(parent.attrs.blockId),
      parentIsDoc: parent.type.name === "doc",
      previousBlockId: index > 0
        ? readBlockId(parent.child(index - 1).attrs.blockId)
        : null,
      nextBlockId: index + 1 < parent.childCount
        ? readBlockId(parent.child(index + 1).attrs.blockId)
        : null,
      index,
    });
    return false;
  });
  return bookmarks;
}

function insertPendingUploadBookmark(
  node: PmJsonNode,
  bookmark: PendingUploadBookmark,
  root = true,
): { node: PmJsonNode; inserted: boolean } {
  const isTargetParent = bookmark.parentIsDoc
    ? root
    : bookmark.parentBlockId !== null
      && readBlockId(node.attrs?.blockId) === bookmark.parentBlockId;
  if (isTargetParent) {
    return {
      node: {
        ...node,
        content: insertBookmarkIntoContent(node.content ?? [], bookmark),
      },
      inserted: true,
    };
  }

  const content = node.content;
  if (!content) return { node, inserted: false };
  for (let index = 0; index < content.length; index += 1) {
    const child = insertPendingUploadBookmark(content[index]!, bookmark, false);
    if (!child.inserted) continue;
    const nextContent = content.slice();
    nextContent[index] = child.node;
    return {
      node: { ...node, content: nextContent },
      inserted: true,
    };
  }
  return { node, inserted: false };
}

function insertAtRootFallback(
  root: PmJsonNode,
  bookmark: PendingUploadBookmark,
): PmJsonNode {
  return {
    ...root,
    content: insertBookmarkIntoContent(root.content ?? [], bookmark),
  };
}

function insertBookmarkIntoContent(
  content: PmJsonNode[],
  bookmark: PendingUploadBookmark,
): PmJsonNode[] {
  const next = content.slice();
  const previousIndex = bookmark.previousBlockId
    ? next.findIndex(
        (node) => readBlockId(node.attrs?.blockId) === bookmark.previousBlockId,
      )
    : -1;
  const nextIndex = bookmark.nextBlockId
    ? next.findIndex(
        (node) => readBlockId(node.attrs?.blockId) === bookmark.nextBlockId,
      )
    : -1;
  const index = previousIndex >= 0
    ? previousIndex + 1
    : nextIndex >= 0
      ? nextIndex
      : Math.min(Math.max(0, bookmark.index), next.length);
  next.splice(index, 0, bookmark.node);
  return next;
}

function containsBlockId(node: PmJsonNode, blockId: string): boolean {
  if (readBlockId(node.attrs?.blockId) === blockId) return true;
  return node.content?.some((child) => containsBlockId(child, blockId)) ?? false;
}

function readBlockId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

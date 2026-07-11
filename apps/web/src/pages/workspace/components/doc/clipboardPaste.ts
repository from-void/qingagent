import { DOMParser as ProseMirrorDOMParser, Slice } from "@tiptap/pm/model";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { markdownToPm, pmToClipboardHtml, pmToPlainText, type PmDoc } from "@qingagent/pm-schema";

/** F3:把当前选区序列化为语义 HTML + 纯文本写入剪贴板。
 *  返回 true 表示已接管(preventDefault);失败/空选区返回 false 走 PM 默认。 */
export function writeSelectionToClipboard(
  view: EditorView,
  event: ClipboardEvent,
  isCut: boolean,
): boolean {
  try {
    const { selection, doc: stateDoc } = view.state;
    if (selection instanceof CellSelection) return false;
    if (selection.empty || !event.clipboardData) return false;
    if (isCut && !view.editable) return false;
    // doc.cut 保持块结构完整(跨节点选区自动补全包裹层)。
    const sub = stateDoc.cut(selection.from, selection.to);
    // 剪贴板出口负责清洗和降级;不要先跑严格 validator,否则脏 href/src
    // 会回退到 ProseMirror 默认 HTML,反而绕过白名单序列化。
    const pmDoc = sub.toJSON() as PmDoc;
    const html = pmToClipboardHtml(pmDoc);
    const plain = pmToPlainText(pmDoc);
    if (!html && !plain) return false;
    event.clipboardData.setData("text/html", html);
    event.clipboardData.setData("text/plain", plain);
    event.preventDefault();
    if (isCut) {
      view.dispatch(view.state.tr.deleteSelection());
    }
    return true;
  } catch (err) {
    console.warn("[doc] 富格式复制失败,回退默认复制行为", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

const DATA_URL_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']data:image\/(?:png|jpe?g|gif|webp);base64,/i;
const BLOCK_MARKDOWN_RE = /(^|\n)\s*(?:#{1,6}\s+\S|[-*]\s+\S|\d+\.\s+\S|>\s?\S|```|\$\$|\|.+\|)/;

export function parsePlainTextClipboard(text: string, view: EditorView): Slice | null {
  if (!text) return null;
  const schema = view.state.schema;
  if (looksLikeBlockMarkdown(text)) {
    const parsed = schema.nodeFromJSON(markdownToPm(text));
    return new Slice(parsed.content, 0, 0);
  }
  const dom = document.createElement("div");
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n+/)) {
    const p = document.createElement("p");
    if (block) p.appendChild(document.createTextNode(block));
    dom.appendChild(p);
  }
  return ProseMirrorDOMParser.fromSchema(schema).parseSlice(dom, {
    preserveWhitespace: true,
    context: view.state.selection.$from,
  });
}

/** 从剪贴板取图片文件(截图/复制图片);无文件项时兜底从 HTML 内联 data:image 提取第一张。 */
function collectPasteImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const stamp = Date.now();
  const files = data.files ? Array.from(data.files) : [];
  let idx = 0;
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      out.push(new File([f], `粘贴图片-${stamp}-${++idx}.${ext}`, { type: f.type || "image/png" }));
    }
  }
  if (out.length === 0) {
    const html = data.getData("text/html") || "";
    const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["'](data:image\/[a-zA-Z+]+;base64,[^"']+)["']/i);
    if (m?.[1]) {
      const file = dataUrlToImageFile(m[1], stamp);
      if (file) out.push(file);
    }
  }
  return out;
}

function dataUrlToImageFile(dataUrl: string, stamp: number): File | null {
  try {
    const [head, body] = dataUrl.split(",");
    if (!head || !body) return null;
    const mime = head.match(/data:([^;]+)/)?.[1] || "image/png";
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    return new File([bytes], `粘贴图片-${stamp}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

export function handleQingagentPaste(
  view: EditorView,
  event: ClipboardEvent,
  onToast?: (message: string) => void,
  onImageFiles?: (files: File[]) => void,
): boolean {
  if (view.state.selection instanceof CellSelection) return false;
  // 图片:有上传处理器就走上传链路插 image 节点;没有(老调用/测试)则保持旧提示行为。
  const imageFiles = collectPasteImageFiles(event.clipboardData);
  if (imageFiles.length > 0) {
    if (onImageFiles) {
      event.preventDefault();
      onImageFiles(imageFiles);
      return true;
    }
    onToast?.("暂不支持粘贴内嵌图片，请用工具栏上传");
    return false;
  }

  const html = event.clipboardData?.getData("text/html") ?? "";
  if (html && DATA_URL_IMAGE_RE.test(html)) {
    onToast?.("暂不支持粘贴内嵌图片，请用工具栏上传");
    return false;
  }

  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text || html) return false;
  const slice = parsePlainTextClipboard(text, view);
  if (!slice) return false;
  event.preventDefault();
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
  return true;
}

function looksLikeBlockMarkdown(text: string): boolean {
  if (BLOCK_MARKDOWN_RE.test(text)) return true;
  return isPipeMarkdownTable(text);
}

function isPipeMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.some((line, index) => {
    const next = lines[index + 1] ?? "";
    return line.includes("|") && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(next);
  });
}

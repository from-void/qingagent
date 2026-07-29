import type { PmDoc, PmNode } from "./types";

export interface PmToPlainTextOptions {
  /** 跳过「媒体/非散文」节点(图片 image、图表 diagram、文件附件 fileAttachment),
   *  使其不产出任何文本。字数口径用它实现「只算文章文字、不算图片」;
   *  搜索命中 / AI 定位 / 导出等其它用途不传该选项,仍把图注 caption/alt、
   *  图表源码、附件名作为可检索文本取出。 */
  skipMedia?: boolean;
  /** 跳过 taskItem 的 [ ]/[x] 展示装饰，仅保留任务正文与子块。 */
  skipTaskMarkers?: boolean;
  /** 跳过脚注 note；正文字符数使用，搜索/AI 定位默认保留 note。 */
  skipFootnotes?: boolean;
}

export function pmToPlainText(doc: PmDoc, opts?: PmToPlainTextOptions): string {
  return doc.content.map((node) => nodeToText(node, opts)).filter(Boolean).join("\n");
}

function nodeToText(node: PmNode, opts?: PmToPlainTextOptions): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
    case "penNote":
    case "codeBlock":
      return (node.content ?? [])
        .map((child) => {
          if (child.type === "text") return child.text;
          if (child.type === "inlineMath") return child.attrs.latex;
          if (child.type === "footnoteReference") {
            return opts?.skipFootnotes ? "" : child.attrs.note;
          }
          return "\n";
        })
        .join("");
    case "blockquote":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "bulletList":
    case "orderedList":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "listItem":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "horizontalRule":
      return "";
    case "taskList":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "taskItem": {
      const content = node.content.map((child) => nodeToText(child, opts)).join("\n");
      return opts?.skipTaskMarkers ? content : `${node.attrs.checked ? "[x]" : "[ ]"} ${content}`;
    }
    case "callout":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "columnList":
    case "column":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "blockMath":
      return node.attrs.latex;
    case "inlineMath":
      return node.attrs.latex;
    case "footnoteReference":
      return opts?.skipFootnotes ? "" : node.attrs.note;
    case "image":
      // 媒体节点:图片不是散文正文。字数口径(skipMedia)下不计入;
      // 其它用途(搜索命中 / AI 定位 / 导出)仍取 caption/alt 作为可检索文本。
      return opts?.skipMedia ? "" : (node.attrs.caption ?? node.attrs.alt ?? "");
    case "diagram":
      // 纯文本/搜索口径:用图表源码(可被搜索命中);字数口径不计入。
      return opts?.skipMedia ? "" : node.attrs.source;
    case "fileAttachment":
      return opts?.skipMedia ? "" : node.attrs.filename;
    case "table":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
    case "tableRow":
      return node.content.map((child) => nodeToText(child, opts)).join("\t");
    case "tableCell":
    case "tableHeader":
      return node.content.map((child) => nodeToText(child, opts)).join("\n");
  }
}

import { useMemo } from "react";
import { markdownToPm, type PmBlockNode } from "@qingagent/pm-schema";
import { MermaidPreview } from "./MermaidPreview";
import { PmBlockView } from "./doc/PmStaticView";

export const ASK_USER_PREVIEW_MAX_CODE_POINTS = 800;

type PreviewBlockNode = Extract<
  PmBlockNode,
  { type: "heading" | "paragraph" | "blockquote" | "bulletList" | "orderedList" | "diagram" }
>;

/**
 * 选项 preview 来自模型，前端再次按 Unicode code point 截断，避免老快照绕过 core 新闸。
 */
export function truncateAskUserPreview(markdown: string): string {
  const codePoints = Array.from(markdown);
  if (codePoints.length <= ASK_USER_PREVIEW_MAX_CODE_POINTS) return markdown;
  return `${codePoints.slice(0, ASK_USER_PREVIEW_MAX_CODE_POINTS).join("")}…`;
}

/** 只保留样张需要的正文节点；图片、表格、数学、附件等一律丢弃。 */
export function filterAskUserPreviewNodes(nodes: readonly PmBlockNode[]): PreviewBlockNode[] {
  const out: PreviewBlockNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
      case "paragraph":
      case "diagram":
        out.push(node);
        break;
      case "blockquote":
        out.push({
          ...node,
          content: filterAskUserPreviewNodes(node.content),
        });
        break;
      case "bulletList":
      case "orderedList":
        out.push({
          ...node,
          content: node.content.map((item) => ({
            ...item,
            content: filterAskUserPreviewNodes(item.content),
          })),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function AskUserPreview({ markdown }: { markdown: string }) {
  const nodes = useMemo(() => {
    const safeMarkdown = truncateAskUserPreview(markdown);
    return filterAskUserPreviewNodes(markdownToPm(safeMarkdown).content);
  }, [markdown]);

  return (
    <div className="auq-preview-doc wf-doc" data-wf="AskUserPreview">
      {nodes.map((node, index) =>
        node.type === "diagram" ? (
          <div className="pm-diagram" data-pm-node="diagram" key={node.attrs.blockId ?? index}>
            <MermaidPreview
              source={node.attrs.source}
              lang="mermaid"
              readOnly
            />
          </div>
        ) : (
          <PmBlockView key={node.attrs.blockId ?? index} node={node} />
        ),
      )}
    </div>
  );
}

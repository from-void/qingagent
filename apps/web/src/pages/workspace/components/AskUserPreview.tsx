import { useMemo, useRef, useState } from "react";
import { markdownToPm, type PmBlockNode } from "@qingagent/pm-schema";
import { MermaidPreview } from "./MermaidPreview";
import { MediaZoomFullscreen } from "./MediaZoomFullscreen";
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
  const [fullscreen, setFullscreen] = useState(false);
  const lightboxTriggerRef = useRef<HTMLElement | null>(null);
  const parsed = useMemo(() => {
    const safeMarkdown = truncateAskUserPreview(markdown);
    try {
      return {
        nodes: filterAskUserPreviewNodes(markdownToPm(safeMarkdown).content),
        fallback: null,
      };
    } catch {
      // parser 自带 PM 校验，非法图片 URL 等会在白名单过滤前抛错；降级源码并交给 React 转义。
      return { nodes: [], fallback: safeMarkdown };
    }
  }, [markdown]);

  const renderContent = (fullscreenView = false) => parsed.fallback !== null ? (
    <pre className="auq-preview-fallback">{parsed.fallback}</pre>
  ) : parsed.nodes.map((node, index) => node.type === "diagram" ? (
    <button
      type="button"
      className="pm-diagram auq-preview-diagram"
      data-pm-node="diagram"
      aria-label="放大查看流程图"
      key={node.attrs.blockId ?? index}
      onClick={fullscreenView ? undefined : (event) => {
        lightboxTriggerRef.current = event.currentTarget;
        setFullscreen(true);
      }}
    >
      <MermaidPreview source={node.attrs.source} lang="mermaid" readOnly />
    </button>
  ) : <PmBlockView key={node.attrs.blockId ?? index} node={node} />);

  return (
    <div className="auq-preview-doc wf-doc" data-wf="AskUserPreview">
      <button type="button" className="auq-preview-fullscreen" aria-label="全屏查看预览面板" title="全屏查看" onClick={(event) => {
        lightboxTriggerRef.current = event.currentTarget;
        setFullscreen(true);
      }}><span aria-hidden="true">⛶</span><span>全屏</span></button>
      {renderContent()}
      <MediaZoomFullscreen open={fullscreen} onClose={() => setFullscreen(false)} ariaLabel="问卷预览全屏查看" contentClassName="media-zoom-content--ask-preview" restoreFocusRef={lightboxTriggerRef}>
        <div className="auq-preview-doc auq-preview-doc--fullscreen wf-doc" data-wf="AskUserPreviewLightbox">
          {renderContent(true)}
        </div>
      </MediaZoomFullscreen>
    </div>
  );
}

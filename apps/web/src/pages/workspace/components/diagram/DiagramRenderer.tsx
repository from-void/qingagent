import { Suspense, lazy } from "react";
import type { DiagramOverlay } from "@qingagent/diagram-engine";
import { detectType } from "@qingagent/diagram-engine";
import { MermaidPreview } from "../MermaidPreview";

const GraphDiagramView = lazy(() => import("./GraphDiagramView").then((mod) => ({ default: mod.GraphDiagramView })));

type RendererOverlay = {
  positions?: Record<string, { x: number; y: number }> | null;
  styles?: Record<string, {
    fill?: string | null;
    stroke?: string | null;
    textColor?: string | null;
    strokeWidth?: number | null;
    fontSize?: number | null;
  }> | null;
  edgeStyles?: Record<string, {
    stroke?: string | null;
    textColor?: string | null;
    strokeWidth?: number | null;
  }> | null;
  edgeHandles?: Record<string, {
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }> | null;
  /** 元素层级(越大越靠上);与位置/样式同属视觉 overlay。 */
  zOrders?: Record<string, number> | null;
};

export interface DiagramRendererProps {
  source: string;
  lang?: string;
  cachedSvg?: string | null;
  overlay?: RendererOverlay | null;
  readOnly?: boolean;
  align?: "left" | "center" | "right";
  onAlignChange?: (align: "left" | "center" | "right") => void;
  onFullscreen?: () => void;
  openVisualSignal?: number;
  onOverlayChange?: (overlay: DiagramOverlay | null) => void;
  onSourceChange?: (source: string) => void;
  onVisualChange?: (change: DiagramVisualChange) => void;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface DiagramVisualChange {
  source?: string;
  overlay?: DiagramOverlay | null;
}

export function DiagramRenderer({
  source,
  lang = "mermaid",
  cachedSvg,
  overlay,
  readOnly = true,
  align = "center",
  onAlignChange,
  onFullscreen,
  openVisualSignal,
  onOverlayChange,
  onSourceChange,
  onVisualChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: DiagramRendererProps) {
  const type = lang === "mermaid" ? detectType(source) : null;
  const normalizedOverlay = normalizeOverlay(overlay);
  if (type === "flowchart" || type === "state" || type === "er" || type === "class" || type === "mindmap") {
    return (
      <Suspense fallback={<div className="pm-diagram-empty">渲染中…</div>}>
        <GraphDiagramView
          source={source}
          overlay={normalizedOverlay}
          readOnly={readOnly}
          align={align}
          onAlignChange={onAlignChange}
          openVisualSignal={openVisualSignal}
          onOverlayChange={onOverlayChange}
          onSourceChange={onSourceChange}
          onVisualChange={onVisualChange}
          onUndo={onUndo}
          onRedo={onRedo}
          canUndo={canUndo}
          canRedo={canRedo}
        />
      </Suspense>
    );
  }
  return (
    <MermaidPreview
      source={source}
      cachedSvg={cachedSvg}
      lang={lang}
      readOnly={readOnly}
      align={align}
      onAlignChange={onAlignChange}
      onFullscreen={onFullscreen}
    />
  );
}

function normalizeOverlay(overlay: RendererOverlay | null | undefined): DiagramOverlay | null {
  if (!overlay) return null;
  const out: DiagramOverlay = {
    ...(overlay.positions ? { positions: overlay.positions } : {}),
    ...(overlay.styles ? { styles: mapStyleRecord(overlay.styles) } : {}),
    ...(overlay.zOrders ? { zOrders: mapNumberRecord(overlay.zOrders) } : {}),
    ...(overlay.edgeStyles ? { edgeStyles: mapStyleRecord(overlay.edgeStyles) } : {}),
    ...(overlay.edgeHandles ? { edgeHandles: mapHandleRecord(overlay.edgeHandles) } : {}),
  };
  return out.positions || out.styles || out.zOrders || out.edgeStyles || out.edgeHandles ? out : null;
}

function mapNumberRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
  }
  return out;
}

function mapStyleRecord<T extends Record<string, string | number | null | undefined>>(
  record: Record<string, T>,
): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [id, style] of Object.entries(record)) {
    const next: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(style)) {
      if (typeof value === "string" || typeof value === "number") next[key] = value;
    }
    if (Object.keys(next).length > 0) out[id] = next;
  }
  return out;
}

function mapHandleRecord<T extends Record<string, string | null | undefined>>(
  record: Record<string, T>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [id, handles] of Object.entries(record)) {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(handles)) {
      if (typeof value === "string" && value.trim()) next[key] = value;
    }
    if (Object.keys(next).length > 0) out[id] = next;
  }
  return out;
}

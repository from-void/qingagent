import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SyntheticEvent,
} from "react";
import type {
  Connection,
  Edge,
  EdgeChange,
  EdgeProps,
  EdgeTypes,
  Node,
  NodeChange,
  NodeHandle,
  NodeProps,
  ResizeParams,
  NodeTypes,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  OnReconnect,
  ReactFlowInstance,
  Viewport,
} from "@xyflow/react";
import {
  Background,
  BaseEdge as ReactFlowBaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useNodes,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  applyEdit,
  carryOverDiagramOverlay,
  dissolveSubgraph,
  getFlowShapeGeometry,
  getCapabilities,
  getStableElementIds,
  graphToSvg,
  layoutDiagramGraph,
  normalizeFlowShapeName,
  moveNodeToSubgraph,
  parseDiagram,
  renameSubgraph,
  setSubgraphStyle,
  wrapNodesInSubgraph,
  type BaseEdge as DiagramBaseEdge,
  type BaseNode,
  type Capability,
  type DiagramModel,
  type DiagramOverlay,
  type EdgeDirection,
  type EdgeLineStyle,
  type EdgeMarkerKind,
  type EdgeStyleOverride,
  type EditOp,
  type FlowNodeShape,
  type FlowGraph,
  type MindNode,
  type NodeStyleOverride,
  type RewriteResult,
} from "@qingagent/diagram-engine";
import { useToast } from "../../../../system";
import { MediaBlockToolbar } from "../MediaBlockToolbar";
import type { DiagramVisualChange } from "./DiagramRenderer";
import "./graphDiagram.css";
import "../diagramEditorChrome.css";

interface GraphDiagramViewProps {
  source: string;
  overlay?: DiagramOverlay | null;
  readOnly?: boolean;
  align?: "left" | "center" | "right";
  onAlignChange?: (align: "left" | "center" | "right") => void;
  openVisualSignal?: number;
  onOverlayChange?: (overlay: DiagramOverlay | null) => void;
  onSourceChange?: (source: string) => void;
  onVisualChange?: (change: DiagramVisualChange) => void;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  canUndo?: boolean;
  canRedo?: boolean;
}

type CanvasSize = { width: number; height: number };
type CanvasFrame = CanvasSize & { left: number; top: number };
type FloatingPlacement = "above" | "below";
type ToolbarMenu =
  | "node-shape"
  | "node-fill"
  | "node-border"
  | "node-text"
  | "node-more"
  | "subgraph-fill"
  | "subgraph-border"
  | "edge-line"
  | "edge-arrow"
  | "edge-label"
  | "edge-more";
type IconName =
  | "shape"
  | "fill"
  | "border"
  | "text"
  | "more"
  | "line"
  | "line-dotted"
  | "line-thick"
  | "arrow-right"
  | "arrow-left"
  | "arrow-both"
  | "trash"
  | "plus"
  | "reset"
  | "move";
type GraphDirection = "TB" | "BT" | "LR" | "RL";
type GraphHandleId = "t" | "r" | "b" | "l";
type CanvasToolIconName =
  | "subgraph"
  | "undo"
  | "redo"
  | "hand"
  | "align-left"
  | "align-center"
  | "align-right"
  | "zoom-out"
  | "zoom-in"
  | "fit"
  | "fullscreen"
  | "dissolve"
  | "plus";
type GraphNodeShape = FlowNodeShape;
type GraphNodeData = {
  label: string;
  editLabel: string;
  shape: GraphNodeShape;
  rawShape: string | null;
  isRenaming: boolean;
  canRename: boolean;
  canQuickAdd: boolean;
  canResize: boolean;
  width: number;
  height: number;
  onRenameStart: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  onQuickAdd: (handleId: GraphHandleId) => void;
  onResizePreview: (size: ResizeParams) => void;
  onResizeCommit: (size: ResizeParams) => void;
} & Record<string, unknown>;
type GraphRegularNode = Node<GraphNodeData, "graphNode">;
type GraphClusterData = {
  label: string;
  editLabel: string;
  direction: string;
  depth: number;
  scopePath: string[];
  empty: boolean;
  isRenaming: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
} & Record<string, unknown>;
type GraphClusterNode = Node<GraphClusterData, "graphCluster">;
type GraphFlowNode = GraphRegularNode | GraphClusterNode;
type GraphEdgeData = {
  floating: boolean;
  label: string;
  textColor: string;
  canEditLabel: boolean;
  isEditingLabel: boolean;
  onSelect: () => void;
  onLabelEditStart: () => void;
  onLabelCommit: (label: string) => void;
  onLabelCancel: () => void;
  sourceMarker: EdgeMarkerKind;
  targetMarker: EdgeMarkerKind;
  markerColor: string;
  curve?: string;
} & Record<string, unknown>;
type GraphFlowEdge = Edge<GraphEdgeData, "graphEdge">;
type GraphNodeDragSnapshot = {
  id: string;
  position: { x: number; y: number };
  label: string;
  shape: FlowNodeShape | null;
  style?: NodeStyleOverride;
};
type AltDuplicateDragState = {
  source: GraphNodeDragSnapshot;
  dropPosition: { x: number; y: number };
};
type ShiftDragState = {
  active: boolean;
  axis: "x" | "y" | null;
  startPositions: Record<string, { x: number; y: number }>;
};
type GraphRect = { x: number; y: number; width: number; height: number };
type ClusterDragState = {
  clusterId: string;
  startPosition: { x: number; y: number };
  movingPositions: Record<string, { x: number; y: number }>;
};
type GraphDiagramTestAction =
  | { kind: "altDuplicate"; nodeId: string; dropPosition: { x: number; y: number } }
  | { kind: "shiftDrag"; nodeId: string; dropPosition: { x: number; y: number } }
  | { kind: "boxSelect"; nodeIds: string[]; edgeIds?: string[] }
  | { kind: "moveParent"; nodeId: string; newParentId: string }
  | { kind: "drawSubgraph"; rect: GraphRect }
  | { kind: "dropNode"; nodeId: string; position: { x: number; y: number } }
  | { kind: "resizeNodePreview"; nodeId: string; rect: GraphRect }
  | { kind: "resizeNode"; nodeId: string; rect: GraphRect }
  | { kind: "moveSubgraph"; subgraphId: string; delta: { x: number; y: number } };

const NODE_WIDTH = 160;
const NODE_HEIGHT = 72;
const NODE_MIN_WIDTH = 96;
const NODE_MIN_HEIGHT = 48;
const NODE_MAX_WIDTH = 640;
const NODE_MAX_HEIGHT = 480;
const NODE_FILL_COLORS = ["#efe3cc", "#f3ecdd", "#e5dfc9", "#f8e7a1", "#ddd0b5", "#cfc5b2"];
const NODE_STROKE_COLORS = ["#b08a3e", "#8f6d30", "#8d7447", "#6a6256", "#4f514f", "#2f2a22"];
const NODE_TEXT_COLORS = ["#2f2a22", "#4f514f", "#5c5346", "#6a6256", "#8d7447", "#11110f"];
const EDGE_COLORS = ["#8d7447", "#8f6d30", "#b08a3e", "#6a6256", "#4f514f"];
const EDGE_DIRECTION_OPTIONS: Array<{ direction: EdgeDirection; label: string; icon: IconName }> = [
  { direction: "forward", label: "正向箭头", icon: "arrow-right" },
  { direction: "backward", label: "反向箭头", icon: "arrow-left" },
  { direction: "both", label: "双向箭头", icon: "arrow-both" },
  { direction: "none", label: "无箭头", icon: "line" },
];
const EDGE_LINE_STYLE_OPTIONS: Array<{ lineStyle: EdgeLineStyle; label: string; icon: IconName }> = [
  { lineStyle: "solid", label: "实线", icon: "line" },
  { lineStyle: "dotted", label: "点线", icon: "line-dotted" },
  { lineStyle: "thick", label: "粗线", icon: "line-thick" },
];
const NODE_STROKE_WIDTH_RANGE = { min: 1, max: 8, step: 0.5 };
const EDGE_STROKE_WIDTH_RANGE = { min: 1, max: 8, step: 0.5 };
const NODE_FONT_SIZE_RANGE = { min: 10, max: 48, step: 1 };
const DEFAULT_NODE_FONT_SIZE = 13;
const DEFAULT_NODE_FILL = "#efe3cc";
const DEFAULT_NODE_STROKE = "#b08a3e";
const DEFAULT_CLUSTER_FILL = "#f3ecdd";
const DEFAULT_CLUSTER_STROKE = "#cdbfa3";
const DEFAULT_NODE_TEXT = "#2f2a22";
const DEFAULT_EDGE_STROKE = "#8d7447";
const DEFAULT_EDGE_TEXT = "#5c5346";
const NODE_SHAPE_LABELS: Partial<Record<GraphNodeShape, string>> = {
  rect: "矩形",
  round: "圆角矩形",
  stadium: "体育场/胶囊",
  subroutine: "子流程",
  cylinder: "圆柱",
  circle: "圆形",
  doublecircle: "双圆形",
  asymmetric: "非对称形",
  diamond: "菱形(判断)",
  hexagon: "六边形",
  parallelogram: "平行四边形",
  "parallelogram-alt": "反向平行四边形",
  trapezoid: "梯形",
  "trapezoid-alt": "反向梯形",
};
const NODE_SHAPE_OPTIONS: Array<{ shape: FlowNodeShape; label: string }> = [
  { shape: "rect", label: NODE_SHAPE_LABELS.rect! },
  { shape: "round", label: NODE_SHAPE_LABELS.round! },
  { shape: "stadium", label: NODE_SHAPE_LABELS.stadium! },
  { shape: "subroutine", label: NODE_SHAPE_LABELS.subroutine! },
  { shape: "cylinder", label: NODE_SHAPE_LABELS.cylinder! },
  { shape: "diamond", label: NODE_SHAPE_LABELS.diamond! },
  { shape: "circle", label: NODE_SHAPE_LABELS.circle! },
  { shape: "doublecircle", label: NODE_SHAPE_LABELS.doublecircle! },
  { shape: "asymmetric", label: NODE_SHAPE_LABELS.asymmetric! },
  { shape: "hexagon", label: NODE_SHAPE_LABELS.hexagon! },
  { shape: "parallelogram", label: NODE_SHAPE_LABELS.parallelogram! },
  { shape: "parallelogram-alt", label: NODE_SHAPE_LABELS["parallelogram-alt"]! },
  { shape: "trapezoid", label: NODE_SHAPE_LABELS.trapezoid! },
  { shape: "trapezoid-alt", label: NODE_SHAPE_LABELS["trapezoid-alt"]! },
];
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_CANVAS_FRAME: CanvasFrame = { width: 0, height: 0, left: 0, top: 0 };
const GRAPH_HANDLES: Array<{ id: GraphHandleId; position: Position }> = [
  { id: "t", position: Position.Top },
  { id: "r", position: Position.Right },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
];
function graphNodeHandleBounds(width: number, height: number): NodeHandle[] {
  return [
    { id: "t", type: "source", position: Position.Top, x: width / 2 - 8, y: -8, width: 16, height: 16 },
    { id: "t", type: "target", position: Position.Top, x: width / 2 - 8, y: -8, width: 16, height: 16 },
    { id: "r", type: "source", position: Position.Right, x: width - 8, y: height / 2 - 8, width: 16, height: 16 },
    { id: "r", type: "target", position: Position.Right, x: width - 8, y: height / 2 - 8, width: 16, height: 16 },
    { id: "b", type: "source", position: Position.Bottom, x: width / 2 - 8, y: height - 8, width: 16, height: 16 },
    { id: "b", type: "target", position: Position.Bottom, x: width / 2 - 8, y: height - 8, width: 16, height: 16 },
    { id: "l", type: "source", position: Position.Left, x: -8, y: height / 2 - 8, width: 16, height: 16 },
    { id: "l", type: "target", position: Position.Left, x: -8, y: height / 2 - 8, width: 16, height: 16 },
  ];
}
const DIRECTION_HANDLES: Record<GraphDirection, {
  sourceHandle: GraphHandleId;
  targetHandle: GraphHandleId;
  sourcePosition: Position;
  targetPosition: Position;
  elkDirection: "DOWN" | "UP" | "RIGHT" | "LEFT";
}> = {
  TB: { sourceHandle: "b", targetHandle: "t", sourcePosition: Position.Bottom, targetPosition: Position.Top, elkDirection: "DOWN" },
  BT: { sourceHandle: "t", targetHandle: "b", sourcePosition: Position.Top, targetPosition: Position.Bottom, elkDirection: "UP" },
  LR: { sourceHandle: "r", targetHandle: "l", sourcePosition: Position.Right, targetPosition: Position.Left, elkDirection: "RIGHT" },
  RL: { sourceHandle: "l", targetHandle: "r", sourcePosition: Position.Left, targetPosition: Position.Right, elkDirection: "LEFT" },
};

const NODE_SHAPE_VIEWBOX = `0 0 ${NODE_WIDTH} ${NODE_HEIGHT}`;

const graphNodeTypes = { graphNode: GraphNode, graphCluster: GraphCluster } satisfies NodeTypes;
const graphEdgeTypes = { graphEdge: GraphEdge } satisfies EdgeTypes;
const GRAPH_EDITOR_OWNER_EVENT = "qingagent:graph-diagram-editor-owner-change";

let nextGraphEditorOwnerSeq = 0;
let activeGraphEditorOwnerId: string | null = null;

function createGraphEditorOwnerId(): string {
  nextGraphEditorOwnerSeq += 1;
  return `graph-diagram-editor-${nextGraphEditorOwnerSeq}`;
}

function setActiveGraphEditorOwner(ownerId: string | null): void {
  activeGraphEditorOwnerId = ownerId;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GRAPH_EDITOR_OWNER_EVENT, { detail: { ownerId } }));
  }
}

function GraphNode({ data, isConnectable, selected }: NodeProps<GraphRegularNode>) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const wasRenamingRef = useRef(false);
  const isComposingRef = useRef(false);
  const commitAfterCompositionRef = useRef(false);
  const blurArmedRef = useRef(false);
  const handlePointerRef = useRef<{ id: GraphHandleId; x: number; y: number; moved: boolean } | null>(null);
  const handlePreviewTimerRef = useRef<number | null>(null);
  const [handleHover, setHandleHover] = useState<{ id: GraphHandleId; phase: "plus" | "preview" } | null>(null);

  useEffect(() => () => {
    if (handlePreviewTimerRef.current !== null) window.clearTimeout(handlePreviewTimerRef.current);
  }, []);

  const beginHandleHover = (handleId: GraphHandleId) => {
    if (handlePreviewTimerRef.current !== null) window.clearTimeout(handlePreviewTimerRef.current);
    setHandleHover({ id: handleId, phase: "plus" });
    handlePreviewTimerRef.current = window.setTimeout(() => {
      setHandleHover((current) => (current?.id === handleId ? { id: handleId, phase: "preview" } : current));
      handlePreviewTimerRef.current = null;
    }, 220);
  };
  const endHandleHover = (handleId: GraphHandleId) => {
    if (handlePreviewTimerRef.current !== null) {
      window.clearTimeout(handlePreviewTimerRef.current);
      handlePreviewTimerRef.current = null;
    }
    setHandleHover((current) => (current?.id === handleId ? null : current));
  };

  useEffect(() => {
    if (!data.isRenaming) {
      wasRenamingRef.current = false;
      isComposingRef.current = false;
      commitAfterCompositionRef.current = false;
      blurArmedRef.current = false;
      return;
    }
    if (wasRenamingRef.current) return;
    wasRenamingRef.current = true;
    const el = labelRef.current;
    if (!el) return;
    el.textContent = data.editLabel;
    const focusText = () => {
      el.focus({ preventScroll: true });
      selectEditableContents(el);
    };
    focusText();
    let armFrame = 0;
    const focusFrame = window.requestAnimationFrame(() => {
      // React Flow 会在双击事件收尾时把焦点拉回 node wrapper；下一帧重新夺回后再允许 blur 提交，
      // 否则刚进入编辑就会被一次框架内部焦点切换立即提交并退出。
      focusText();
      armFrame = window.requestAnimationFrame(() => {
        blurArmedRef.current = true;
      });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (armFrame) window.cancelAnimationFrame(armFrame);
    };
  }, [data.editLabel, data.isRenaming]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el || !data.canRename || data.isRenaming) return;
    const nodeEl = el.closest<HTMLElement>(".react-flow__node");
    const openRename = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      data.onRenameStart();
    };
    const handleClick = (event: MouseEvent) => {
      if (event.detail >= 2) openRename(event);
    };
    nodeEl?.addEventListener("dblclick", openRename, { capture: true });
    el.addEventListener("click", handleClick, { capture: true });
    el.addEventListener("dblclick", openRename, { capture: true });
    return () => {
      nodeEl?.removeEventListener("dblclick", openRename, { capture: true });
      el.removeEventListener("click", handleClick, { capture: true });
      el.removeEventListener("dblclick", openRename, { capture: true });
    };
  }, [data]);

  const stopRenameEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };
  const requestRename = (event: SyntheticEvent) => {
    if (!data.canRename || data.isRenaming) return;
    event.stopPropagation();
    data.onRenameStart();
  };
  const readRenameValue = () => labelRef.current?.textContent ?? "";

  return (
    <div
      ref={shellRef}
      className={classNames("graph-diagram-node-shell", `graph-diagram-node--${data.shape}`, data.canRename && "can-rename", data.isRenaming && "is-renaming")}
      data-node-shape={data.shape}
      data-mermaid-shape={data.rawShape ?? undefined}
      data-node-width={data.width}
      data-node-height={data.height}
      style={{ width: data.width, height: data.height }}
      onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.detail >= 2) requestRename(event);
      }}
      onDoubleClickCapture={requestRename}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.detail >= 2) requestRename(event);
      }}
      onDoubleClick={requestRename}
    >
      <NodeResizer
        isVisible={selected && data.canResize && !data.isRenaming}
        minWidth={NODE_MIN_WIDTH}
        minHeight={NODE_MIN_HEIGHT}
        maxWidth={NODE_MAX_WIDTH}
        maxHeight={NODE_MAX_HEIGHT}
        keepAspectRatio={data.shape === "circle" || data.shape === "doublecircle"}
        lineClassName="graph-diagram-resize-line"
        handleClassName="graph-diagram-resize-handle nodrag nopan"
        onResize={(_event, size) => data.onResizePreview(size)}
        onResizeEnd={(_event, size) => data.onResizeCommit(size)}
      />
      <svg className="graph-diagram-node-shape-svg" viewBox={NODE_SHAPE_VIEWBOX} preserveAspectRatio="none" aria-hidden="true">
        {renderShapeSvg(data.shape)}
      </svg>
      <div
        ref={labelRef}
        className={classNames("graph-diagram-node-label", data.isRenaming && "is-editing", data.isRenaming && "nodrag nowheel")}
        aria-label={data.isRenaming ? "节点标签" : undefined}
        contentEditable={data.isRenaming}
        suppressContentEditableWarning
        spellCheck={false}
        role={data.isRenaming ? "textbox" : undefined}
        aria-multiline={data.isRenaming ? true : undefined}
        tabIndex={data.isRenaming ? 0 : undefined}
        onClick={data.isRenaming ? stopRenameEvent : undefined}
        onDoubleClick={data.isRenaming ? stopRenameEvent : undefined}
        onMouseDown={data.isRenaming ? stopRenameEvent : undefined}
        onPointerDown={data.isRenaming ? stopRenameEvent : undefined}
        onCompositionStart={(event) => {
          if (!data.isRenaming) return;
          event.stopPropagation();
          isComposingRef.current = true;
          commitAfterCompositionRef.current = false;
        }}
        onCompositionEnd={(event) => {
          if (!data.isRenaming) return;
          event.stopPropagation();
          isComposingRef.current = false;
          if (commitAfterCompositionRef.current) {
            commitAfterCompositionRef.current = false;
            data.onRenameCommit(readRenameValue());
          }
        }}
        onBlur={() => {
          if (!data.isRenaming || !blurArmedRef.current) return;
          if (isComposingRef.current) {
            commitAfterCompositionRef.current = true;
            return;
          }
          data.onRenameCommit(readRenameValue());
        }}
        onKeyDown={(event) => {
          if (!data.isRenaming) return;
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            if (isComposingRef.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            data.onRenameCommit(readRenameValue());
          }
          if (event.key === "Escape") {
            event.preventDefault();
            data.onRenameCancel();
          }
        }}
      >
        {data.isRenaming ? null : data.label}
      </div>
      {GRAPH_HANDLES.map((handle) => (
        <div
          key={handle.id}
          className={`graph-diagram-handle-slot graph-diagram-handle-slot--${handle.id}`}
          data-handle-state={handleHover?.id === handle.id ? handleHover.phase : "dot"}
        >
          <span
            className={`graph-diagram-handle-dot graph-diagram-handle-dot--${handle.id}`}
            data-direction={handle.id}
            aria-hidden="true"
          />
          <Handle
            id={handle.id}
            type="target"
            position={handle.position}
            isConnectable={isConnectable}
            isConnectableStart={false}
            className={`graph-diagram-handle graph-diagram-handle--${handle.id}`}
            aria-label={`${handleLabel(handle.id)}连线目标`}
            title="拖拽到目标节点连线"
            onMouseEnter={() => beginHandleHover(handle.id)}
            onMouseLeave={() => endHandleHover(handle.id)}
          />
          <Handle
            id={handle.id}
            type="source"
            position={handle.position}
            isConnectable={isConnectable}
            className={`graph-diagram-handle graph-diagram-handle--${handle.id}`}
            aria-label={`${handleLabel(handle.id)}连线起点`}
            title="拖拽到目标节点连线"
            onMouseEnter={() => beginHandleHover(handle.id)}
            onMouseLeave={() => endHandleHover(handle.id)}
            onPointerDown={(event) => {
              handlePointerRef.current = { id: handle.id, x: event.clientX, y: event.clientY, moved: false };
            }}
            onPointerMove={(event) => {
              const pointer = handlePointerRef.current;
              if (pointer?.id === handle.id && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) {
                pointer.moved = true;
              }
            }}
            onClick={(event) => {
              const pointer = handlePointerRef.current;
              handlePointerRef.current = null;
              if (!data.canQuickAdd || pointer?.moved) return;
              event.preventDefault();
              event.stopPropagation();
              data.onQuickAdd(handle.id);
            }}
          />
          {data.canQuickAdd && handleHover?.id === handle.id ? (
            <button
              type="button"
              className={`graph-diagram-handle-add graph-diagram-handle-add--${handle.id} is-${handleHover.phase} nodrag nopan`}
              aria-label={`从${handleLabel(handle.id)}新增连接节点`}
              title={handleHover.phase === "preview" ? "点击新建相邻节点" : "继续悬停预览"}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                data.onQuickAdd(handle.id);
              }}
            >
              {handleHover.phase === "preview"
                ? <HandleDirectionIcon direction={handle.id} />
                : <CanvasToolIcon name="plus" />}
            </button>
          ) : null}
          {data.canQuickAdd && handleHover?.id === handle.id && handleHover.phase === "preview" ? (
            <div
              className={`graph-diagram-handle-ghost graph-diagram-handle-ghost--${handle.id}`}
              data-direction={handle.id}
              aria-hidden="true"
            >
              <span className="graph-diagram-handle-ghost__line" />
              <span className="graph-diagram-handle-ghost__node">
                <svg viewBox={NODE_SHAPE_VIEWBOX} preserveAspectRatio="none">
                  {renderShapeSvg(data.shape)}
                </svg>
              </span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function HandleDirectionIcon({ direction }: { direction: GraphHandleId }) {
  return (
    <svg
      className={`graph-diagram-handle-direction-icon graph-diagram-handle-direction-icon--${direction}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GraphCluster({ data, selected }: NodeProps<GraphClusterNode>) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!data.isRenaming) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [data.isRenaming]);

  useEffect(() => {
    const title = titleRef.current;
    if (!title || !data.canEdit || data.isRenaming) return;
    const openRename = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      data.onRenameStart();
    };
    const handleClick = (event: MouseEvent) => {
      if (event.detail >= 2) openRename(event);
    };
    title.addEventListener("click", handleClick, { capture: true });
    title.addEventListener("dblclick", openRename, { capture: true });
    return () => {
      title.removeEventListener("click", handleClick, { capture: true });
      title.removeEventListener("dblclick", openRename, { capture: true });
    };
  }, [data]);

  return (
    <div
      className={classNames(
        "graph-diagram-cluster",
        data.empty && "is-empty",
        selected && "is-selected",
        data.isRenaming && "is-renaming",
      )}
      data-cluster-label={data.label}
      data-cluster-direction={data.direction}
      data-cluster-depth={data.depth}
      data-cluster-empty={data.empty}
    >
      <div
        ref={titleRef}
        className={classNames("graph-diagram-cluster__title", data.isRenaming && "nodrag nowheel")}
        title={data.canEdit && !data.isRenaming ? "拖动分区；双击改名" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (data.canEdit) data.onRenameStart();
        }}
      >
        {data.isRenaming ? (
          <input
            ref={inputRef}
            className="graph-diagram-cluster__title-input nodrag nowheel"
            aria-label="分区名称"
            defaultValue={data.editLabel}
            spellCheck={false}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              const nextTitle = event.currentTarget.value.trim();
              data.onRenameCommit(nextTitle || data.editLabel);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                data.onRenameCommit(event.currentTarget.value);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                data.onRenameCancel();
              }
            }}
          />
        ) : data.label}
      </div>
      {data.empty ? (
        <div className="graph-diagram-cluster__empty-hint" aria-hidden="true">
          拖入节点
        </div>
      ) : null}
    </div>
  );
}

function GraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  data,
}: EdgeProps<GraphFlowEdge>) {
  const labelRef = useRef<HTMLDivElement | null>(null);
  const wasEditingRef = useRef(false);
  const isComposingRef = useRef(false);
  const commitAfterCompositionRef = useRef(false);
  const blurArmedRef = useRef(false);
  const pathArgs = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [edgePath, labelX, labelY] = data?.curve === "linear"
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : data?.curve?.startsWith("step")
      ? getSmoothStepPath(pathArgs)
      : getBezierPath(pathArgs);
  const isEditing = data?.isEditingLabel === true;
  const canEdit = data?.canEditLabel === true;
  const label = data?.label ?? "";

  useEffect(() => {
    if (!isEditing) {
      wasEditingRef.current = false;
      isComposingRef.current = false;
      commitAfterCompositionRef.current = false;
      blurArmedRef.current = false;
      return;
    }
    if (wasEditingRef.current) return;
    wasEditingRef.current = true;
    const el = labelRef.current;
    if (!el) return;
    el.textContent = label;
    el.focus();
    selectEditableContents(el);
    window.setTimeout(() => {
      blurArmedRef.current = true;
    }, 0);
  }, [isEditing, label]);

  const readLabelValue = () => labelRef.current?.textContent ?? "";
  const startEdit = (event: SyntheticEvent) => {
    if (!canEdit || isEditing) return;
    event.preventDefault();
    event.stopPropagation();
    data?.onLabelEditStart();
  };

  return (
    <>
      <GraphEdgeMarkerDefs
        edgeId={id}
        sourceMarker={data?.sourceMarker ?? "none"}
        targetMarker={data?.targetMarker ?? "none"}
        color={data?.markerColor ?? DEFAULT_EDGE_STROKE}
      />
      <ReactFlowBaseEdge
        id={id}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={24}
        onDoubleClick={startEdit}
      />
      {(label || canEdit) ? (
        <EdgeLabelRenderer>
          <div
            ref={labelRef}
            className={classNames("graph-diagram-edge-label", isEditing && "is-editing", isEditing && "nodrag nowheel", !label && !isEditing && "is-empty")}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: data?.textColor ?? DEFAULT_EDGE_TEXT,
            }}
            aria-label={isEditing ? "边标签" : undefined}
            role={isEditing ? "textbox" : undefined}
            contentEditable={isEditing}
            suppressContentEditableWarning
            spellCheck={false}
            tabIndex={isEditing ? 0 : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (!isEditing) data?.onSelect();
            }}
            onDoubleClick={startEdit}
            onCompositionStart={(event) => {
              if (!isEditing) return;
              event.stopPropagation();
              isComposingRef.current = true;
              commitAfterCompositionRef.current = false;
            }}
            onCompositionEnd={(event) => {
              if (!isEditing) return;
              event.stopPropagation();
              isComposingRef.current = false;
              if (commitAfterCompositionRef.current) {
                commitAfterCompositionRef.current = false;
                data?.onLabelCommit(readLabelValue());
              }
            }}
            onBlur={() => {
              if (!isEditing || !blurArmedRef.current) return;
              if (isComposingRef.current) {
                commitAfterCompositionRef.current = true;
                return;
              }
              data?.onLabelCommit(readLabelValue());
            }}
            onKeyDown={(event) => {
              if (!isEditing) return;
              event.stopPropagation();
              if (event.key === "Enter") {
                if (isComposingRef.current || event.nativeEvent.isComposing) return;
                event.preventDefault();
                data?.onLabelCommit(readLabelValue());
              }
              if (event.key === "Escape") {
                event.preventDefault();
                data?.onLabelCancel();
              }
            }}
          >
            {isEditing ? null : label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function GraphEdgeMarkerDefs({
  edgeId,
  sourceMarker,
  targetMarker,
  color,
}: {
  edgeId: string;
  sourceMarker: EdgeMarkerKind;
  targetMarker: EdgeMarkerKind;
  color: string;
}) {
  const markers = new Set([sourceMarker, targetMarker]);
  const safeId = graphMarkerSafeId(edgeId);
  return (
    <defs>
      {markers.has("circle") ? (
        <marker id={`graph-circle-${safeId}`} markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth">
          <circle cx="5" cy="5" r="3.2" fill="var(--graph-cluster-fill, #fbf7ee)" stroke={color} strokeWidth="1.5" />
        </marker>
      ) : null}
      {markers.has("cross") ? (
        <marker id={`graph-cross-${safeId}`} markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth">
          <path d="M2 2 L8 8 M8 2 L2 8" fill="none" stroke={color} strokeWidth="1.8" />
        </marker>
      ) : null}
    </defs>
  );
}

function graphMarkerSafeId(edgeId: string): string {
  return edgeId.replace(/[^A-Za-z0-9_-]/g, "_");
}

// 图表块外部工具栏复用图片块结构，并通过预览 React Flow 实例执行真实缩放。
function GraphPreviewToolbar({
  readOnly,
  align,
  onAlignChange,
  onZoomIn,
  onZoomOut,
  onFullscreen,
}: {
  readOnly: boolean;
  align: "left" | "center" | "right";
  onAlignChange?: (align: "left" | "center" | "right") => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFullscreen: () => void;
}) {
  return (
    <MediaBlockToolbar
      align={align}
      onAlignChange={readOnly ? undefined : onAlignChange}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onFullscreen={onFullscreen}
      ariaLabel="图表画布工具栏"
      fullscreenAriaLabel="全屏查看"
      className="graph-diagram-viewbar pm-diagram-viewbar pm-diagram-chrome"
    />
  );
}

function CanvasToolButton({
  label,
  icon,
  active = false,
  pressed,
  disabled = false,
  showLabel = false,
  onMouseDown,
  onClick,
}: {
  label: string;
  icon: CanvasToolIconName;
  active?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={classNames("pm-diagram-tool", "pm-diagram-tool--icon", active && "is-active")}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <CanvasToolIcon name={icon} />
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}

function CanvasToolIcon({ name }: { name: CanvasToolIconName }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <svg className="graph-diagram-canvas-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {name === "subgraph" && (
        <>
          <rect x="2.5" y="3" width="11" height="10" strokeDasharray="2.2 1.8" {...common} />
          <path d="M8 5.4v5.2M5.4 8h5.2" {...common} />
        </>
      )}
      {name === "undo" && <path d="M6.2 4.2 2.8 7.1l3.4 2.8M3.2 7.1h5.1c2.7 0 4.2 1.4 4.2 4.1" {...common} />}
      {name === "redo" && <path d="m9.8 4.2 3.4 2.9-3.4 2.8m3-2.8H7.7c-2.7 0-4.2 1.4-4.2 4.1" {...common} />}
      {name === "hand" && (
        <path d="M5.1 7.6V4.2a1 1 0 0 1 2 0v2.3-3a1 1 0 0 1 2 0v3-2a1 1 0 0 1 2 0v2.4-1a1 1 0 0 1 2 0v2.8c0 3-1.9 4.8-4.7 4.8H7.2c-1.5 0-2.5-.7-3.3-1.9L2.7 9.7a1.1 1.1 0 0 1 1.8-1.2l.6.8" {...common} />
      )}
      {name === "align-left" && <path d="M3 3v10M5.5 5h7M5.5 8h4.5M5.5 11h6" {...common} />}
      {name === "align-center" && <path d="M8 3v10M4 5h8M5.5 8h5M4.8 11h6.4" {...common} />}
      {name === "align-right" && <path d="M13 3v10M3.5 5h7M6 8h4.5M4.5 11h6" {...common} />}
      {name === "zoom-out" && <path d="M3.2 8h9.6" {...common} />}
      {name === "zoom-in" && <path d="M3.2 8h9.6M8 3.2v9.6" {...common} />}
      {name === "fit" && (
        <>
          <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" {...common} />
          <rect x="5.4" y="5.4" width="5.2" height="5.2" {...common} />
        </>
      )}
      {name === "fullscreen" && (
        <path d="M6 2.5H2.5V6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" {...common} />
      )}
      {name === "dissolve" && (
        <>
          <path d="M5 3H2.5v2.5M11 3h2.5v2.5M13.5 10.5V13H11M5 13H2.5v-2.5" strokeDasharray="1.7 1.5" {...common} />
          <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" {...common} />
        </>
      )}
      {name === "plus" && <path d="M3.2 8h9.6M8 3.2v9.6" {...common} />}
    </svg>
  );
}

function GraphViewportControls({
  showHistory,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  panMode,
  onPanModeChange,
}: {
  showHistory: boolean;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  panMode?: boolean;
  onPanModeChange?: (active: boolean) => void;
}) {
  const rf = useReactFlow<GraphFlowNode, GraphFlowEdge>();
  const zoom = useStore((state) => state.transform[2]);
  const stop = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const fit = () => void rf.fitView({ padding: 0.15, maxZoom: 1, duration: 160 });

  return (
    <div className="graph-diagram-viewport-controls" aria-label="画布视图控件">
      {showHistory ? (
        <div className="graph-diagram-viewport-controls__group" role="group" aria-label="历史操作">
          <button
            type="button"
            aria-label="撤销"
            title="撤销"
            disabled={!onUndo || canUndo === false}
            onMouseDown={stop}
            onClick={() => onUndo?.()}
          >
            <CanvasToolIcon name="undo" />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做"
            disabled={!onRedo || canRedo === false}
            onMouseDown={stop}
            onClick={() => onRedo?.()}
          >
            <CanvasToolIcon name="redo" />
          </button>
        </div>
      ) : null}
      <div className="graph-diagram-viewport-controls__group" role="group" aria-label="缩放与平移">
        {onPanModeChange ? (
          <button
            type="button"
            className={classNames(panMode && "is-active")}
            aria-label="拖拽画布(空格)"
            aria-pressed={panMode}
            title="拖拽画布(空格)"
            onMouseDown={stop}
            onClick={() => onPanModeChange(!panMode)}
          >
            <CanvasToolIcon name="hand" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="缩小画布"
          title="缩小"
          onMouseDown={stop}
          onClick={() => void rf.zoomOut({ duration: 120 })}
        >
          <CanvasToolIcon name="zoom-out" />
        </button>
        <button
          type="button"
          className="graph-diagram-viewport-controls__zoom"
          aria-label="适配视图"
          title="适配视图"
          onMouseDown={stop}
          onClick={fit}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大画布"
          title="放大"
          onMouseDown={stop}
          onClick={() => void rf.zoomIn({ duration: 120 })}
        >
          <CanvasToolIcon name="zoom-in" />
        </button>
      </div>
    </div>
  );
}

// 节点尺寸测量完成后再 fitView,避免 React Flow 在节点未测量(尺寸=0)时就 fit 导致
// 缩到 maxZoom(2x) 把宽图顶出窄容器(gallery 窄列复现)。必须作为 ReactFlow 子组件以拿到上下文。
// 编辑态只需要这条通用的测量就绪路径；预览态的 ELK 异步布局另由 FitPreviewOnLayoutApplied 对齐
// 外部 nodes 与 React Flow 内部 store 后再 fit。
function FitOnNodesInitialized({ maxZoom = 1 }: { maxZoom?: number }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  // 容器尺寸(React Flow store 维护,内部 ResizeObserver):审阅态 decoration widget 初始以 0 尺寸
  // 挂载,布局落地后才变 >0。以 width/height 为依赖在尺寸就绪后重新 fitView——否则 0 尺寸时 fit
  // 一次就定死,图表被顶出视口渲染成空白(审阅态复现)。
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (!initialized || width === 0 || height === 0) return;
    const id = requestAnimationFrame(() => fitView({ padding: 0.15, maxZoom }));
    return () => cancelAnimationFrame(id);
  }, [initialized, fitView, maxZoom, width, height]);
  return null;
}

type GraphNodePosition = Pick<Node, "id" | "position">;

export function graphNodePositionKey(nodes: readonly GraphNodePosition[]): string {
  return nodes
    .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
    .sort()
    .join("|");
}

function normalizeGraphRect(rect: GraphRect): GraphRect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

function graphNodeRect(node: Node): GraphRect {
  const width = (node.measured?.width ?? node.width ?? node.initialWidth ?? Number(node.style?.width)) || NODE_WIDTH;
  const height = (node.measured?.height ?? node.height ?? node.initialHeight ?? Number(node.style?.height)) || NODE_HEIGHT;
  return { x: node.position.x, y: node.position.y, width, height };
}

function graphNodeCenter(node: Node): { x: number; y: number } {
  const rect = graphNodeRect(node);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function graphRectContainsPoint(rect: GraphRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function graphRectContainsRect(outer: GraphRect, inner: GraphRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function graphRectsIntersect(left: GraphRect, right: GraphRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function resolveSubgraphFramePlacement(
  rect: GraphRect,
  clusters: GraphClusterNode[],
): { ok: true; parentSubgraph: string | null } | { ok: false } {
  const containing: GraphClusterNode[] = [];
  for (const cluster of clusters) {
    const clusterRect = graphNodeRect(cluster);
    if (!graphRectsIntersect(rect, clusterRect)) continue;
    if (!graphRectContainsRect(clusterRect, rect)) return { ok: false };
    containing.push(cluster);
  }
  containing.sort((left, right) => right.data.depth - left.data.depth);
  return { ok: true, parentSubgraph: containing[0]?.id ?? null };
}

function deepestSubgraphAtPoint(
  point: { x: number; y: number },
  clusters: GraphClusterNode[],
): string | null {
  return clusters
    .filter((cluster) => graphRectContainsPoint(graphNodeRect(cluster), point))
    .sort((left, right) => right.data.depth - left.data.depth)[0]?.id ?? null;
}

function sameStringPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

const MIN_PREVIEW_ZOOM = 0.1;

/**
 * 把一组节点包围盒居中铺进给定画布,返回 setViewport 用的 {x,y,zoom}。
 * zoom 钳制在 0.1~1(超大图保持可读并可平移浏览,小图不放大);padding 为容器两侧留白比例。
 * 纯几何,不依赖 React Flow 的 node.measured,故可绕开 fitView 的测量竞态。
 */
export function computePreviewFitViewport(
  bounds: { x: number; y: number; width: number; height: number },
  containerWidth: number,
  containerHeight: number,
  padding: number,
): { x: number; y: number; zoom: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || containerWidth <= 0 || containerHeight <= 0) return null;
  const usableW = containerWidth * (1 - padding * 2);
  const usableH = containerHeight * (1 - padding * 2);
  const computedZoom = Math.min(1, usableW / bounds.width, usableH / bounds.height);
  const zoom = Math.max(computedZoom, MIN_PREVIEW_ZOOM);
  const x = containerWidth / 2 - (bounds.x + bounds.width / 2) * zoom;
  const y = containerHeight / 2 - (bounds.y + bounds.height / 2) * zoom;
  return { x, y, zoom };
}

// React Flow 12 的 fitView 会排队，等内部 store 下一次 setNodes 时才取节点边界。
// ELK 落地先更新本组件的受控 nodes，随后才由 React Flow 采纳；只监听外部 nodes 会在两者
// 不一致时把重叠的首帧坐标拿去 fit。这里以内部 nodes 的同一坐标键作确认，确保 fit 的结算
// 看到的正是 ELK 坐标；rAF 仅把调用放到浏览器完成本帧布局之后，不是时间兜底。
const FIT_PREVIEW_PADDING = 0.15;

function FitPreviewOnLayoutApplied({ expectedLayoutKey }: { expectedLayoutKey: string }) {
  const appliedNodes = useNodes<GraphFlowNode>();
  const appliedLayoutKey = useMemo(() => graphNodePositionKey(appliedNodes), [appliedNodes]);
  // React Flow 内部测得的画布尺寸;两个 primitive 分开取,避免返回新对象引发无谓重渲染。
  const containerWidth = useStore((state) => state.width);
  const containerHeight = useStore((state) => state.height);
  const rf = useReactFlow();
  const { viewportInitialized } = rf;

  useEffect(() => {
    // 只需「布局已被 React Flow 内部 store 采纳(内外坐标键一致)」+「容器已量到尺寸」。
    // 不能用 useNodesInitialized:ELK 更新坐标后 React Flow 会短暂把 node.measured 清空,
    // 「坐标已铺开」与「已测量」两态从不同时为真,而 fitView 依赖 measured → 一直空转(实测 zoom 卡在 1)。
    // 改用不依赖 measured 的 getNodesBounds(退到 node.width/height)+ 手算 setViewport,并把 zoom 封顶到 1
    // (宽图缩小铺满、窄图不被放大),即可稳定把整张图居中铺进预览。
    if (
      expectedLayoutKey.length === 0 ||
      expectedLayoutKey !== appliedLayoutKey ||
      !viewportInitialized ||
      containerWidth <= 0 ||
      containerHeight <= 0
    ) {
      return;
    }
    const id = requestAnimationFrame(() => {
      const bounds = rf.getNodesBounds(rf.getNodes());
      const viewport = computePreviewFitViewport(bounds, containerWidth, containerHeight, FIT_PREVIEW_PADDING);
      if (viewport) void rf.setViewport(viewport);
    });
    return () => cancelAnimationFrame(id);
  }, [appliedLayoutKey, expectedLayoutKey, rf, viewportInitialized, containerWidth, containerHeight]);

  return null;
}

export function GraphDiagramView({
  source,
  overlay,
  readOnly = true,
  align = "center",
  onAlignChange,
  openVisualSignal = 0,
  onOverlayChange,
  onSourceChange,
  onVisualChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: GraphDiagramViewProps) {
  const toast = useToast();
  const [liveSource, setLiveSource] = useState(source);
  const liveSourceRef = useRef(source);
  const overlayRef = useRef<DiagramOverlay | null | undefined>(overlay);
  const lastOpenVisualSignalRef = useRef(0);
  const editorOwnerIdRef = useRef<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const altDuplicateDragRef = useRef<AltDuplicateDragState | null>(null);
  const shiftDragRef = useRef<ShiftDragState | null>(null);
  const clusterDragRef = useRef<ClusterDragState | null>(null);
  const subgraphDrawStartRef = useRef<{ pointerId: number; point: { x: number; y: number } } | null>(null);
  const nodesRef = useRef<GraphFlowNode[]>([]);
  if (!editorOwnerIdRef.current) editorOwnerIdRef.current = createGraphEditorOwnerId();
  useEffect(() => {
    liveSourceRef.current = source;
    setLiveSource(source);
  }, [source]);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  const parsed = useMemo(() => parseDiagram(liveSource), [liveSource]);
  const themeStyle = useMemo(() => {
    if (!parsed.ok || !parsed.model.themePalette) return undefined;
    const palette = parsed.model.themePalette;
    return {
      ...(palette.nodeFill ? { "--graph-node-fill": palette.nodeFill } : {}),
      ...(palette.nodeStroke ? { "--graph-node-stroke": palette.nodeStroke } : {}),
      ...(palette.lineColor ? { "--graph-line-color": palette.lineColor } : {}),
      ...(palette.textColor ? { "--graph-node-text": palette.textColor, "--graph-edge-text": palette.textColor } : {}),
      ...(palette.clusterFill ? { "--graph-cluster-fill": palette.clusterFill } : {}),
      ...(palette.clusterStroke ? { "--graph-cluster-stroke": palette.clusterStroke } : {}),
    } as CSSProperties & Record<string, string>;
  }, [parsed]);
  const ids = useMemo(() => (parsed.ok ? getStableElementIds(parsed.model) : { nodes: new Set<string>(), edges: new Set<string>() }), [parsed]);
  const graphNodes = useMemo(() => (parsed.ok ? modelNodes(parsed.model) : []), [parsed]);
  const graphEdges = useMemo(() => (parsed.ok ? modelEdges(parsed.model) : []), [parsed]);
  const graphDirection = useMemo(() => (parsed.ok ? getGraphDirection(parsed.model) : "TB"), [parsed]);
  const graphHandleDirection = DIRECTION_HANDLES[graphDirection];
  const diagramLayout = useMemo(
    () => parsed.ok ? layoutDiagramGraph(parsed.model, overlay) : { nodes: {}, clusters: [] },
    [overlay, parsed],
  );
  const autoLayout = diagramLayout.nodes;
  const [nodes, setNodes] = useState<GraphFlowNode[]>([]);
  const [edges, setEdges] = useState<GraphFlowEdge[]>([]);
  const [editing, setEditing] = useState(false);
  const [viewingFullscreen, setViewingFullscreen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedSubgraphId, setSelectedSubgraphId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renamingSubgraphId, setRenamingSubgraphId] = useState<string | null>(null);
  const [editingEdgeLabelId, setEditingEdgeLabelId] = useState<string | null>(null);
  const [parentPickerNodeId, setParentPickerNodeId] = useState<string | null>(null);
  const [openToolbarMenu, setOpenToolbarMenu] = useState<ToolbarMenu | null>(null);
  const [editViewport, setEditViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [editCanvasFrame, setEditCanvasFrame] = useState<CanvasFrame>(DEFAULT_CANVAS_FRAME);
  const [error, setError] = useState<string | null>(null);
  const [subgraphDrawMode, setSubgraphDrawMode] = useState(false);
  const [subgraphPreview, setSubgraphPreview] = useState<GraphRect | null>(null);
  const [newSubgraphId, setNewSubgraphId] = useState<string | null>(null);
  const [panMode, setPanMode] = useState(true);
  const [spacePanning, setSpacePanning] = useState(false);
  const renameCommittedRef = useRef(false);
  const subgraphRenameCommittedRef = useRef(false);
  const edgeLabelCommittedRef = useRef(false);
  const inEdit = !readOnly && editing;
  const baseCaps = useMemo(() => getCapabilities(parsed), [parsed]);
  const canConnectEdge = capEnabled(baseCaps, "connectEdge");
  const canAddNodeEmpty = capEnabled(baseCaps, "addNode");

  const selectedNode = selectedNodeId ? graphNodes.find((node) => node.id === selectedNodeId) : undefined;
  const selectedEdge = selectedEdgeId ? graphEdges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const selectedSubgraph = parsed.ok && parsed.model.type === "flowchart" && selectedSubgraphId
    ? parsed.model.subgraphs.find((subgraph) => subgraph.id === selectedSubgraphId)
    : undefined;
  const selectedNodeCaps = useMemo(
    () => (selectedNodeId ? getCapabilities(parsed, { nodeId: selectedNodeId }) : baseCaps),
    [baseCaps, parsed, selectedNodeId],
  );
  const selectedEdgeCaps = useMemo(
    () => (selectedEdgeId ? getCapabilities(parsed, { edgeId: selectedEdgeId }) : baseCaps),
    [baseCaps, parsed, selectedEdgeId],
  );
  const isMindmap = parsed.ok && parsed.model.type === "mindmap";
  const movingNode = parentPickerNodeId ? graphNodes.find((node) => node.id === parentPickerNodeId) : selectedNode;
  const moveParentOptions = useMemo(
    () =>
      isMindmap && movingNode
        ? graphNodes.filter((node) => node.hasStableId && node.id !== movingNode.id && !isDescendantNode(node, movingNode))
        : [],
    [graphNodes, isMindmap, movingNode],
  );
  const moveParentTargetIds = useMemo(() => new Set(moveParentOptions.map((node) => node.id)), [moveParentOptions]);
  const previewFit = useFitOnResize(true);
  const editorFit = useFitOnResize(inEdit, setEditCanvasFrame);
  const fullscreenFit = useFitOnResize(viewingFullscreen);

  // 预览 fit 的触发键同时描述每个节点坐标。ELK 落地后它会先变化；子组件会等 React Flow
  // 内部 store 采纳完全相同的坐标后再调 fitView，不能仅靠节点数或包围盒相同来猜已同步。
  const previewFitKey = useMemo(() => graphNodePositionKey(nodes), [nodes]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const resetEditorState = useCallback(() => {
    setConnecting(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedSubgraphId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setRenamingNodeId(null);
    setRenamingSubgraphId(null);
    setEditingEdgeLabelId(null);
    setParentPickerNodeId(null);
    setOpenToolbarMenu(null);
    setSubgraphDrawMode(false);
    setSubgraphPreview(null);
    setNewSubgraphId(null);
    setSpacePanning(false);
    subgraphDrawStartRef.current = null;
    clusterDragRef.current = null;
  }, []);

  const openEditor = useCallback(() => {
    if (readOnly) return;
    setActiveGraphEditorOwner(editorOwnerIdRef.current);
    setEditing(true);
    setError(null);
  }, [readOnly]);

  useEffect(() => {
    if (!openVisualSignal || openVisualSignal === lastOpenVisualSignalRef.current) return;
    lastOpenVisualSignalRef.current = openVisualSignal;
    openEditor();
  }, [openEditor, openVisualSignal]);

  const closeEditor = useCallback(() => {
    if (activeGraphEditorOwnerId === editorOwnerIdRef.current) {
      setActiveGraphEditorOwner(null);
    }
    setEditing(false);
    resetEditorState();
  }, [resetEditorState]);

  const openFullscreen = useCallback(() => {
    if (readOnly) {
      setViewingFullscreen(true);
      return;
    }
    openEditor();
  }, [openEditor, readOnly]);

  const closeFullscreen = useCallback(() => {
    setViewingFullscreen(false);
  }, []);

  useEffect(() => {
    const ownerId = editorOwnerIdRef.current;
    const handleOwnerChange = (event: Event) => {
      const nextOwnerId = event instanceof CustomEvent ? (event.detail as { ownerId?: string | null } | null)?.ownerId ?? null : activeGraphEditorOwnerId;
      if (nextOwnerId === ownerId) return;
      setEditing(false);
      resetEditorState();
    };
    window.addEventListener(GRAPH_EDITOR_OWNER_EVENT, handleOwnerChange);
    return () => {
      window.removeEventListener(GRAPH_EDITOR_OWNER_EVENT, handleOwnerChange);
      if (activeGraphEditorOwnerId === ownerId) {
        setActiveGraphEditorOwner(null);
      }
    };
  }, [resetEditorState]);

  useEffect(() => {
    if (!readOnly) return;
    closeEditor();
  }, [closeEditor, readOnly]);

  useEffect(() => {
    if (!viewingFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFullscreen();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeFullscreen, viewingFullscreen]);

  useEffect(() => {
    const subgraphIds = parsed.ok && parsed.model.type === "flowchart"
      ? new Set(parsed.model.subgraphs.map((subgraph) => subgraph.id))
      : new Set<string>();
    setSelectedNodeId((current) => (current && graphNodes.some((node) => node.id === current) ? current : null));
    setSelectedEdgeId((current) => (current && graphEdges.some((edge) => edge.id === current) ? current : null));
    setSelectedSubgraphId((current) => (current && subgraphIds.has(current) ? current : null));
    setSelectedNodeIds((current) => current.filter((id) => graphNodes.some((node) => node.id === id)));
    setSelectedEdgeIds((current) => current.filter((id) => graphEdges.some((edge) => edge.id === id)));
    setRenamingNodeId((current) => (current && graphNodes.some((node) => node.id === current) ? current : null));
    setRenamingSubgraphId((current) => (current && subgraphIds.has(current) ? current : null));
    setEditingEdgeLabelId((current) => (current && graphEdges.some((edge) => edge.id === current) ? current : null));
    setParentPickerNodeId((current) => (current && graphNodes.some((node) => node.id === current) ? current : null));
  }, [graphEdges, graphNodes, parsed]);

  useEffect(() => {
    if (!inEdit) return;
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const key = event.key.toLowerCase();
      if (
        event.code === "Space" &&
        !event.repeat &&
        !target?.closest("input, textarea, [contenteditable='true']")
      ) {
        event.preventDefault();
        setSpacePanning(true);
        return;
      }
      const hasMod = event.ctrlKey || event.metaKey;
      const isUndo = hasMod && !event.shiftKey && key === "z";
      const isRedo = hasMod && (
        (event.shiftKey && key === "z") ||
        (!event.shiftKey && key === "y")
      );
      if (
        ((isUndo && onUndo) || (isRedo && onRedo)) &&
        !target?.closest("input, textarea, [contenteditable='true']")
      ) {
        event.preventDefault();
        if (isUndo) onUndo?.();
        else onRedo?.();
        return;
      }
      if (event.key !== "Escape") return;
      if (subgraphDrawMode) {
        event.preventDefault();
        setSubgraphDrawMode(false);
        setSubgraphPreview(null);
        subgraphDrawStartRef.current = null;
        return;
      }
      closeEditor();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePanning(false);
    };
    const handleWindowBlur = () => setSpacePanning(false);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [closeEditor, inEdit, onRedo, onUndo, subgraphDrawMode]);

  const emitOverlay = useCallback(
    (next: DiagramOverlay, extraIds?: { nodes?: string[]; edges?: string[] }) => {
      const nodeIds = new Set(ids.nodes);
      const edgeIds = new Set(ids.edges);
      for (const id of extraIds?.nodes ?? []) nodeIds.add(id);
      for (const id of extraIds?.edges ?? []) edgeIds.add(id);
      const cleaned = cleanOverlay(next, nodeIds, edgeIds);
      const payload = isOverlayEmpty(cleaned) ? null : cleaned;
      overlayRef.current = payload;
      if (onVisualChange) onVisualChange({ overlay: payload });
      else onOverlayChange?.(payload);
    },
    [ids.edges, ids.nodes, onOverlayChange, onVisualChange],
  );

  const onNodesChange: OnNodesChange<GraphFlowNode> = useCallback((changes: NodeChange<GraphFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange: OnEdgesChange<GraphFlowEdge> = useCallback((changes: EdgeChange<GraphFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const commitNodePositions = useCallback(
    (changedNodes: Node[]) => {
      if (!inEdit) return;
      const positions = { ...(overlayRef.current?.positions ?? {}) };
      let changed = false;
      for (const node of changedNodes) {
        if (!ids.nodes.has(node.id)) continue;
        positions[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
        changed = true;
      }
      if (!changed) return;
      emitOverlay({
        ...(overlayRef.current ?? {}),
        positions,
      });
    },
    [emitOverlay, ids.nodes, inEdit],
  );

  const commitNodeResize = useCallback(
    (nodeId: string, size: ResizeParams) => {
      if (!inEdit || !ids.nodes.has(nodeId)) return;
      const width = clamp(Math.round(size.width), NODE_MIN_WIDTH, NODE_MAX_WIDTH);
      const height = clamp(Math.round(size.height), NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
      emitOverlay({
        ...(overlayRef.current ?? {}),
        positions: {
          ...(overlayRef.current?.positions ?? {}),
          [nodeId]: { x: Math.round(size.x), y: Math.round(size.y) },
        },
        styles: {
          ...(overlayRef.current?.styles ?? {}),
          [nodeId]: {
            ...(overlayRef.current?.styles?.[nodeId] ?? {}),
            width,
            height,
          },
        },
      });
    },
    [emitOverlay, ids.nodes, inEdit],
  );

  const previewNodeResize = useCallback(
    (nodeId: string, size: ResizeParams) => {
      if (!inEdit || !ids.nodes.has(nodeId)) return;
      const width = clamp(size.width, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
      const height = clamp(size.height, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
      setNodes((current) => current.map((node) => {
        if (node.id !== nodeId || node.type !== "graphNode") return node;
        return {
          ...node,
          position: { x: size.x, y: size.y },
          initialWidth: width,
          initialHeight: height,
          measured: { ...(node.measured ?? {}), width, height },
          handles: graphNodeHandleBounds(width, height),
          data: { ...node.data, width, height },
          style: { ...(node.style ?? {}), width, height },
        };
      }));
    },
    [ids.nodes, inEdit],
  );

  const runRewrite = useCallback(
    (rewrite: (source: string) => RewriteResult): RewriteResult | null => {
      if (readOnly || (!onSourceChange && !onVisualChange)) return null;
      const baseSource = liveSourceRef.current;
      const result = rewrite(baseSource);
      if (!result.ok) {
        setError(result.error ?? "图表语义编辑失败");
        return null;
      }
      setError(null);
      liveSourceRef.current = result.source;
      setLiveSource(result.source);
      if (result.idMap) {
        setSelectedNodeId((current) => remapSelectedId(current, result.idMap?.nodes));
        setSelectedNodeIds((current) => current.map((id) => result.idMap?.nodes?.[id] ?? id));
        setSelectedEdgeId((current) => remapSelectedId(current, result.idMap?.edges));
        setSelectedEdgeIds((current) => current.map((id) => result.idMap?.edges?.[id] ?? id));
        setRenamingNodeId((current) => remapSelectedId(current, result.idMap?.nodes));
        setEditingEdgeLabelId((current) => remapSelectedId(current, result.idMap?.edges));
        setParentPickerNodeId((current) => remapSelectedId(current, result.idMap?.nodes));
      }
      const currentOverlay = overlayRef.current;
      let carriedOverlay: DiagramOverlay | null | undefined;
      if (currentOverlay) {
        const carried = carryOverDiagramOverlay(baseSource, currentOverlay, result.source, result.idMap) ?? null;
        overlayRef.current = carried;
        carriedOverlay = carried;
      }
      if (onVisualChange) {
        onVisualChange({
          source: result.source,
          ...(currentOverlay ? { overlay: carriedOverlay ?? null } : {}),
        });
      } else {
        onSourceChange?.(result.source);
        if (currentOverlay) onOverlayChange?.(carriedOverlay ?? null);
      }
      return result;
    },
    [onOverlayChange, onSourceChange, onVisualChange, readOnly],
  );

  const runEdit = useCallback(
    (op: EditOp): RewriteResult | null => runRewrite((baseSource) => applyEdit(baseSource, op)),
    [runRewrite],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !inEdit) return;
      const baseSource = liveSourceRef.current;
      const result = runEdit({ kind: "connectEdge", source: connection.source, target: connection.target });
      const sourceHandle = normalizeGraphHandleId(connection.sourceHandle);
      const targetHandle = normalizeGraphHandleId(connection.targetHandle);
      if (!result?.ok || (!sourceHandle && !targetHandle)) return;
      const edgeId = findAddedEdgeId(baseSource, result.source, connection.source, connection.target);
      if (!edgeId) return;
      emitOverlay(
        {
          ...(overlayRef.current ?? {}),
          edgeHandles: {
            ...(overlayRef.current?.edgeHandles ?? {}),
            [edgeId]: {
              ...(sourceHandle ? { sourceHandle } : {}),
              ...(targetHandle ? { targetHandle } : {}),
            },
          },
        },
        { edges: [edgeId] },
      );
    },
    [emitOverlay, inEdit, runEdit],
  );

  const onReconnect: OnReconnect<GraphFlowEdge> = useCallback(
    (oldEdge, connection) => {
      if (!connection.source || !connection.target || !inEdit) return;
      const baseSource = liveSourceRef.current;
      const result = runEdit({
        kind: "reconnectEdge",
        edgeId: oldEdge.id,
        newSource: connection.source,
        newTarget: connection.target,
      });
      if (!result?.ok) return;
      const nextEdgeId = findReconnectedEdgeId(baseSource, result.source, oldEdge.id, connection.source, connection.target);
      const nextHandles = { ...(overlayRef.current?.edgeHandles ?? {}) };
      delete nextHandles[oldEdge.id];
      const sourceHandle = normalizeGraphHandleId(connection.sourceHandle);
      const targetHandle = normalizeGraphHandleId(connection.targetHandle);
      if (nextEdgeId && (sourceHandle || targetHandle)) {
        nextHandles[nextEdgeId] = {
          ...(sourceHandle ? { sourceHandle } : {}),
          ...(targetHandle ? { targetHandle } : {}),
        };
      }
      emitOverlay(
        {
          ...(overlayRef.current ?? {}),
          edgeHandles: Object.keys(nextHandles).length ? nextHandles : undefined,
        },
        nextEdgeId ? { edges: [nextEdgeId] } : undefined,
      );
    },
    [emitOverlay, inEdit, runEdit],
  );

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedNodeIds([nodeId]);
    setSelectedEdgeId(null);
    setSelectedSubgraphId(null);
    setSelectedEdgeIds([]);
    setRenamingNodeId((current) => (current === nodeId ? current : null));
    setRenamingSubgraphId(null);
    setEditingEdgeLabelId(null);
    setParentPickerNodeId(null);
    setOpenToolbarMenu(null);
  }, []);

  const selectEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedEdgeIds([edgeId]);
    setSelectedNodeId(null);
    setSelectedSubgraphId(null);
    setSelectedNodeIds([]);
    setRenamingNodeId(null);
    setRenamingSubgraphId(null);
    setEditingEdgeLabelId(null);
    setParentPickerNodeId(null);
    setOpenToolbarMenu(null);
  }, []);

  const clearSelection = useCallback(() => {
    // React Flow 自己也维护 selected 标记；只清业务 state 会被下一次
    // onSelectionChange 用旧标记重新选回，因此空白点击必须两层一起清。
    setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
    setEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedSubgraphId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setRenamingNodeId(null);
    setRenamingSubgraphId(null);
    setEditingEdgeLabelId(null);
    setParentPickerNodeId(null);
    setOpenToolbarMenu(null);
  }, []);

  const selectSubgraph = useCallback((subgraphId: string) => {
    setSelectedSubgraphId(subgraphId);
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setSelectedEdgeIds([]);
    setRenamingNodeId(null);
    setEditingEdgeLabelId(null);
    setParentPickerNodeId(null);
    setOpenToolbarMenu(null);
  }, []);

  const syncSelection = useCallback((selection: { nodes: Node[]; edges: Edge[] }) => {
    const nextSubgraphIds = selection.nodes.filter((node) => node.type === "graphCluster").map((node) => node.id);
    const nextNodeIds = selection.nodes.filter((node) => node.type !== "graphCluster").map((node) => node.id);
    const nextEdgeIds = selection.edges.map((edge) => edge.id);
    setSelectedNodeIds(nextNodeIds);
    setSelectedEdgeIds(nextEdgeIds);
    setSelectedNodeId(nextNodeIds.length === 1 && nextEdgeIds.length === 0 && nextSubgraphIds.length === 0 ? nextNodeIds[0]! : null);
    setSelectedEdgeId(nextEdgeIds.length === 1 && nextNodeIds.length === 0 && nextSubgraphIds.length === 0 ? nextEdgeIds[0]! : null);
    setSelectedSubgraphId(
      nextSubgraphIds.length === 1 && nextNodeIds.length === 0 && nextEdgeIds.length === 0
        ? nextSubgraphIds[0]!
        : null,
    );
    if (nextNodeIds.length !== 1 || nextEdgeIds.length > 0 || nextSubgraphIds.length > 0) setRenamingNodeId(null);
    if (nextSubgraphIds.length !== 1 || nextNodeIds.length > 0 || nextEdgeIds.length > 0) setRenamingSubgraphId(null);
    if (nextEdgeIds.length !== 1 || nextNodeIds.length > 0 || nextSubgraphIds.length > 0) setEditingEdgeLabelId(null);
    if (nextNodeIds.length !== 1 || nextEdgeIds.length > 0 || nextSubgraphIds.length > 0) setParentPickerNodeId(null);
    if (nextNodeIds.length !== 1 && nextEdgeIds.length !== 1 && nextSubgraphIds.length !== 1) setOpenToolbarMenu(null);
  }, []);

  const addNode = useCallback(() => {
    if (!canAddNodeEmpty && !capEnabled(selectedNodeCaps, "addNode")) return;
    const parentId = isMindmap ? selectedNodeId ?? undefined : undefined;
    const newNodeId = runEdit({ kind: "addNode", label: "新节点", parentId })?.newNodeId ?? null;
    if (newNodeId) {
      setSelectedNodeId(newNodeId);
      setSelectedNodeIds([newNodeId]);
      setSelectedEdgeId(null);
      setSelectedEdgeIds([]);
      setRenamingNodeId(null);
      setEditingEdgeLabelId(null);
      setParentPickerNodeId(null);
    }
  }, [canAddNodeEmpty, isMindmap, runEdit, selectedNodeCaps, selectedNodeId]);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId || !capEnabled(selectedNodeCaps, "deleteNode")) return;
    runEdit({ kind: "deleteNode", nodeId: selectedNodeId });
    clearSelection();
  }, [clearSelection, runEdit, selectedNodeCaps, selectedNodeId]);

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId || !capEnabled(selectedEdgeCaps, "deleteEdge")) return;
    runEdit({ kind: "deleteEdge", edgeId: selectedEdgeId });
    clearSelection();
  }, [clearSelection, runEdit, selectedEdgeCaps, selectedEdgeId]);

  const deleteSelection = useCallback(() => {
    if (!inEdit) return;
    if (selectedSubgraphId) {
      const result = runRewrite((baseSource) => dissolveSubgraph(baseSource, selectedSubgraphId));
      if (result?.ok) clearSelection();
      return;
    }
    const nodeTargets = selectedNodeIds.length > 0 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
    const edgeTargets = selectedEdgeIds.length > 0 ? selectedEdgeIds : selectedEdgeId ? [selectedEdgeId] : [];
    if (nodeTargets.length > 0) {
      for (const nodeId of nodeTargets) {
        const currentParsed = parseDiagram(liveSourceRef.current);
        if (!capEnabled(getCapabilities(currentParsed, { nodeId }), "deleteNode")) continue;
        runEdit({ kind: "deleteNode", nodeId });
      }
      clearSelection();
      return;
    }
    if (edgeTargets.length > 0) {
      for (const edgeId of edgeTargets) {
        const currentParsed = parseDiagram(liveSourceRef.current);
        if (!capEnabled(getCapabilities(currentParsed, { edgeId }), "deleteEdge")) continue;
        runEdit({ kind: "deleteEdge", edgeId });
      }
      clearSelection();
    }
  }, [
    clearSelection,
    inEdit,
    runEdit,
    runRewrite,
    selectedEdgeId,
    selectedEdgeIds,
    selectedNodeId,
    selectedNodeIds,
    selectedSubgraphId,
  ]);

  const updateNodeStyle = useCallback(
    (patch: NodeStyleOverride) => {
      const targetNodeId = selectedNodeId;
      if (!targetNodeId || !inEdit || !ids.nodes.has(targetNodeId)) return;
      emitOverlay({
        ...(overlay ?? {}),
        styles: {
          ...(overlay?.styles ?? {}),
          [targetNodeId]: { ...(overlay?.styles?.[targetNodeId] ?? {}), ...patch },
        },
      });
    },
    [emitOverlay, ids.nodes, inEdit, overlay, selectedNodeId],
  );

  const resetNodeStyle = useCallback(() => {
    const targetNodeId = selectedNodeId;
    if (!targetNodeId || !inEdit) return;
    const nextStyles = { ...(overlay?.styles ?? {}) };
    delete nextStyles[targetNodeId];
    emitOverlay({
      ...(overlay ?? {}),
      styles: Object.keys(nextStyles).length ? nextStyles : undefined,
    });
  }, [emitOverlay, inEdit, overlay, selectedNodeId]);

  const updateEdgeStyle = useCallback(
    (patch: EdgeStyleOverride) => {
      const targetEdgeId = selectedEdgeId;
      if (!targetEdgeId || !inEdit || !ids.edges.has(targetEdgeId)) return;
      emitOverlay({
        ...(overlay ?? {}),
        edgeStyles: {
          ...(overlay?.edgeStyles ?? {}),
          [targetEdgeId]: { ...(overlay?.edgeStyles?.[targetEdgeId] ?? {}), ...patch },
        },
      });
    },
    [emitOverlay, ids.edges, inEdit, overlay, selectedEdgeId],
  );

  const resetEdgeStyle = useCallback(() => {
    const targetEdgeId = selectedEdgeId;
    if (!targetEdgeId || !inEdit) return;
    const nextStyles = { ...(overlay?.edgeStyles ?? {}) };
    delete nextStyles[targetEdgeId];
    emitOverlay({
      ...(overlay ?? {}),
      edgeStyles: Object.keys(nextStyles).length ? nextStyles : undefined,
    });
  }, [emitOverlay, inEdit, overlay, selectedEdgeId]);

  const updateSelectedSubgraphStyle = useCallback(
    (patch: Pick<NodeStyleOverride, "fill" | "stroke">) => {
      if (!selectedSubgraphId || !inEdit) return;
      runRewrite((baseSource) => setSubgraphStyle(baseSource, selectedSubgraphId, patch));
    },
    [inEdit, runRewrite, selectedSubgraphId],
  );

  const setSelectedEdgeArrow = useCallback(
    (patch: { direction?: EdgeDirection; lineStyle?: EdgeLineStyle }) => {
      if (!selectedEdge || !capEnabled(selectedEdgeCaps, "setEdgeArrow")) return;
      runEdit({
        kind: "setEdgeArrow",
        edgeId: selectedEdge.id,
        direction: patch.direction ?? getEdgeDirection(selectedEdge),
        lineStyle: patch.lineStyle ?? getEdgeLineStyle(selectedEdge),
      });
    },
    [runEdit, selectedEdge, selectedEdgeCaps],
  );

  const setSelectedNodeShape = useCallback(
    (shape: FlowNodeShape) => {
      if (!selectedNodeId || !capEnabled(selectedNodeCaps, "setNodeShape")) return;
      runEdit({ kind: "setNodeShape", nodeId: selectedNodeId, shape });
    },
    [runEdit, selectedNodeCaps, selectedNodeId],
  );

  const startRename = useCallback(
    (nodeId: string) => {
      const node = graphNodes.find((item) => item.id === nodeId);
      if (!node) return;
      setSelectedNodeId(nodeId);
      setSelectedNodeIds([nodeId]);
      setSelectedEdgeId(null);
      setSelectedEdgeIds([]);
      setSelectedSubgraphId(null);
      setEditingEdgeLabelId(null);
      setParentPickerNodeId(null);
      setOpenToolbarMenu(null);
      renameCommittedRef.current = false;
      setRenamingNodeId(nodeId);
    },
    [graphNodes],
  );

  const commitRename = useCallback((value: string) => {
    if (renameCommittedRef.current) return;
    if (!renamingNodeId || !capEnabled(getCapabilities(parsed, { nodeId: renamingNodeId }), "relabelNode")) {
      setRenamingNodeId(null);
      return;
    }
    renameCommittedRef.current = true;
    const nextLabel = value.trim();
    const currentLabel = graphNodes.find((node) => node.id === renamingNodeId)?.label ?? "";
    setRenamingNodeId(null);
    if (!nextLabel || nextLabel === currentLabel) return;
    runEdit({ kind: "relabelNode", nodeId: renamingNodeId, label: nextLabel });
  }, [graphNodes, parsed, renamingNodeId, runEdit]);

  const cancelRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenamingNodeId(null);
  }, []);

  const startSubgraphRename = useCallback((subgraphId: string) => {
    if (!parsed.ok || parsed.model.type !== "flowchart" || !parsed.model.subgraphs.some((item) => item.id === subgraphId)) return;
    selectSubgraph(subgraphId);
    subgraphRenameCommittedRef.current = false;
    setRenamingSubgraphId(subgraphId);
  }, [parsed, selectSubgraph]);

  const commitSubgraphRename = useCallback((value: string) => {
    if (subgraphRenameCommittedRef.current || !renamingSubgraphId) return;
    subgraphRenameCommittedRef.current = true;
    const nextTitle = value.trim();
    const currentTitle = parsed.ok && parsed.model.type === "flowchart"
      ? parsed.model.subgraphs.find((item) => item.id === renamingSubgraphId)?.label ?? ""
      : "";
    setRenamingSubgraphId(null);
    setNewSubgraphId((current) => (current === renamingSubgraphId ? null : current));
    if (!nextTitle || nextTitle === currentTitle) return;
    runRewrite((baseSource) => renameSubgraph(baseSource, renamingSubgraphId, nextTitle));
  }, [parsed, renamingSubgraphId, runRewrite]);

  const cancelSubgraphRename = useCallback(() => {
    subgraphRenameCommittedRef.current = true;
    const createdId = newSubgraphId && newSubgraphId === renamingSubgraphId ? newSubgraphId : null;
    setRenamingSubgraphId(null);
    setNewSubgraphId(null);
    if (!createdId) return;
    const result = runRewrite((baseSource) => dissolveSubgraph(baseSource, createdId));
    if (result?.ok) clearSelection();
  }, [clearSelection, newSubgraphId, renamingSubgraphId, runRewrite]);

  const dissolveSelectedSubgraph = useCallback(() => {
    if (!selectedSubgraphId) return;
    const result = runRewrite((baseSource) => dissolveSubgraph(baseSource, selectedSubgraphId));
    if (result?.ok) clearSelection();
  }, [clearSelection, runRewrite, selectedSubgraphId]);

  const beginSubgraphDrawing = useCallback(() => {
    if (!parsed.ok || parsed.model.type !== "flowchart" || readOnly) return;
    openEditor();
    clearSelection();
    setError(null);
    setSubgraphPreview(null);
    subgraphDrawStartRef.current = null;
    setSubgraphDrawMode(true);
  }, [clearSelection, openEditor, parsed, readOnly]);

  const createSubgraphFromRect = useCallback((rawRect: GraphRect): boolean => {
    if (!parsed.ok || parsed.model.type !== "flowchart") return false;
    const rect = normalizeGraphRect(rawRect);
    if (rect.width < 8 || rect.height < 8) {
      setSubgraphPreview(null);
      return false;
    }
    const clusterNodes = nodesRef.current.filter((node): node is GraphClusterNode => node.type === "graphCluster");
    const placement = resolveSubgraphFramePlacement(rect, clusterNodes);
    if (!placement.ok) {
      setSubgraphPreview(null);
      toast.show({ message: "分区不能跨越已有分区边界", tone: "warn" });
      return false;
    }
    const parent = placement.parentSubgraph
      ? parsed.model.subgraphs.find((subgraph) => subgraph.id === placement.parentSubgraph)
      : undefined;
    const expectedScopePath = parent ? [...parent.scopePath, parent.id] : [];
    const modelNodeById = new Map(parsed.model.nodes.map((node) => [node.id, node]));
    const nodeIds = nodesRef.current
      .filter((node): node is GraphRegularNode => node.type === "graphNode")
      .filter((node) => graphRectContainsPoint(rect, graphNodeCenter(node)))
      .filter((node) => sameStringPath(modelNodeById.get(node.id)?.scopePath ?? [], expectedScopePath))
      .map((node) => node.id);
    const result = runRewrite((baseSource) =>
      wrapNodesInSubgraph(baseSource, nodeIds, "新分区", placement.parentSubgraph),
    );
    const createdId = result?.newSubgraphId;
    if (!result?.ok || !createdId) {
      setSubgraphPreview(null);
      return false;
    }
    emitOverlay(
      {
        ...(overlayRef.current ?? {}),
        positions: {
          ...(overlayRef.current?.positions ?? {}),
          [createdId]: { x: Math.round(rect.x), y: Math.round(rect.y) },
        },
      },
      { nodes: [createdId] },
    );
    setSubgraphPreview(null);
    setSubgraphDrawMode(false);
    setSelectedSubgraphId(createdId);
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setSelectedEdgeIds([]);
    subgraphRenameCommittedRef.current = false;
    setNewSubgraphId(createdId);
    setRenamingSubgraphId(createdId);
    return true;
  }, [emitOverlay, parsed, runRewrite, toast]);

  const handleSubgraphPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!subgraphDrawMode || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("react-flow__pane")) return;
    const point = editorFit.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    subgraphDrawStartRef.current = { pointerId: event.pointerId, point };
    setSubgraphPreview({ x: point.x, y: point.y, width: 0, height: 0 });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom/旧浏览器无指针捕获时仍可依赖冒泡事件 */
    }
  }, [editorFit, subgraphDrawMode]);

  const handleSubgraphPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = subgraphDrawStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const point = editorFit.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSubgraphPreview(normalizeGraphRect({
      x: start.point.x,
      y: start.point.y,
      width: point.x - start.point.x,
      height: point.y - start.point.y,
    }));
  }, [editorFit]);

  const handleSubgraphPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = subgraphDrawStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const point = editorFit.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    subgraphDrawStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针可能已由浏览器释放 */
    }
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    createSubgraphFromRect({
      x: start.point.x,
      y: start.point.y,
      width: point.x - start.point.x,
      height: point.y - start.point.y,
    });
  }, [createSubgraphFromRect, editorFit]);

  const startEdgeLabelEdit = useCallback(
    (edgeId: string) => {
      const edge = graphEdges.find((item) => item.id === edgeId);
      if (!edge || !capEnabled(getCapabilities(parsed, { edgeId }), "setEdgeLabel")) return;
      setSelectedEdgeId(edgeId);
      setSelectedEdgeIds([edgeId]);
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setRenamingNodeId(null);
      setParentPickerNodeId(null);
      setOpenToolbarMenu(null);
      edgeLabelCommittedRef.current = false;
      setEditingEdgeLabelId(edgeId);
    },
    [graphEdges, parsed],
  );

  const commitEdgeLabelEdit = useCallback((edgeId: string, value: string) => {
    if (edgeLabelCommittedRef.current) return;
    if (!edgeId || !capEnabled(getCapabilities(parsed, { edgeId }), "setEdgeLabel")) {
      setEditingEdgeLabelId(null);
      return;
    }
    edgeLabelCommittedRef.current = true;
    const nextLabel = value.trim();
    const currentLabel = graphEdges.find((edge) => edge.id === edgeId)?.label ?? "";
    setEditingEdgeLabelId(null);
    if (nextLabel === currentLabel) return;
    runEdit({ kind: "setEdgeLabel", edgeId, label: nextLabel });
  }, [graphEdges, parsed, runEdit]);

  const cancelEdgeLabelEdit = useCallback(() => {
    edgeLabelCommittedRef.current = false;
    setEditingEdgeLabelId(null);
  }, []);

  const addConnectedNodeFromHandle = useCallback(
    (sourceNodeId: string, handleId: GraphHandleId) => {
      if (!inEdit || !canConnectEdge || !capEnabled(getCapabilities(parsed, { nodeId: sourceNodeId }), "addNode")) return;
      const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
      if (!sourceNode) return;
      const addResult = runEdit({ kind: "addNode", label: "新节点" });
      const newNodeId = addResult?.newNodeId;
      if (!addResult?.ok || !newNodeId) return;

      const newPosition = quickAddNodePosition(sourceNode, handleId);
      const connectBaseSource = liveSourceRef.current;
      const connectResult = runEdit({ kind: "connectEdge", source: sourceNodeId, target: newNodeId });
      const edgeId = connectResult?.ok ? findAddedEdgeId(connectBaseSource, connectResult.source, sourceNodeId, newNodeId) : null;
      emitOverlay(
        {
          ...(overlayRef.current ?? {}),
          positions: {
            ...(overlayRef.current?.positions ?? {}),
            [newNodeId]: newPosition,
          },
          ...(edgeId
            ? {
                edgeHandles: {
                  ...(overlayRef.current?.edgeHandles ?? {}),
                  [edgeId]: {
                    sourceHandle: handleId,
                    targetHandle: oppositeHandle(handleId),
                  },
                },
              }
            : {}),
        },
        { nodes: [newNodeId], edges: edgeId ? [edgeId] : [] },
      );
      setSelectedNodeId(newNodeId);
      setSelectedNodeIds([newNodeId]);
      setSelectedEdgeId(null);
      setSelectedEdgeIds([]);
      setRenamingNodeId(null);
      setEditingEdgeLabelId(null);
      setParentPickerNodeId(null);
      setOpenToolbarMenu(null);
    },
    [canConnectEdge, emitOverlay, inEdit, parsed, runEdit],
  );

  useEffect(() => {
    const clusterNodes = [...diagramLayout.clusters]
      .sort((left, right) => left.depth - right.depth)
      .map((cluster): GraphClusterNode => ({
        id: cluster.id,
        type: "graphCluster",
        position: { x: cluster.x, y: cluster.y },
        initialWidth: cluster.width,
        initialHeight: cluster.height,
        sourcePosition: graphHandleDirection.sourcePosition,
        targetPosition: graphHandleDirection.targetPosition,
        data: {
          label: cluster.label,
          editLabel: cluster.label,
          direction: cluster.direction,
          depth: cluster.depth,
          scopePath: cluster.scopePath,
          empty: cluster.empty,
          isRenaming: inEdit && renamingSubgraphId === cluster.id,
          canEdit: inEdit,
          onSelect: () => selectSubgraph(cluster.id),
          onRenameStart: () => startSubgraphRename(cluster.id),
          onRenameCommit: commitSubgraphRename,
          onRenameCancel: cancelSubgraphRename,
        },
        draggable: inEdit && renamingSubgraphId !== cluster.id,
        selectable: inEdit,
        focusable: inEdit,
        selected: inEdit && selectedSubgraphId === cluster.id,
        zIndex: -100 + cluster.depth,
        className: classNames("graph-diagram-cluster-node", selectedSubgraphId === cluster.id && "is-selected"),
        style: {
          width: cluster.width,
          height: cluster.height,
          border: "none",
          background: "transparent",
          padding: 0,
          ...(parsed.model.type === "flowchart" && parsed.model.perSubgraphStyles?.[cluster.id]?.fill
            ? { "--graph-cluster-fill": parsed.model.perSubgraphStyles[cluster.id]!.fill! }
            : {}),
          ...(parsed.model.type === "flowchart" && parsed.model.perSubgraphStyles?.[cluster.id]?.stroke
            ? { "--graph-cluster-stroke": parsed.model.perSubgraphStyles[cluster.id]!.stroke! }
            : {}),
        },
      }));
    const regularNodes = graphNodes.map((node) => {
      const sourceStyle = parsed.model.perNodeStyles?.[node.id];
      const overlayStyle = overlay?.styles?.[node.id];
      const over = overlay?.positions?.[node.id];
      const auto = autoLayout[node.id] ?? { x: 40, y: 40 };
      const isSelected = inEdit && node.id === selectedNodeId;
      const isMoveTarget = inEdit && !!parentPickerNodeId && moveParentTargetIds.has(node.id);
      const isRenaming = inEdit && renamingNodeId === node.id;
      const canRename = inEdit && capEnabled(getCapabilities(parsed, { nodeId: node.id }), "relabelNode");
      const canQuickAdd = inEdit && canConnectEdge && capEnabled(getCapabilities(parsed, { nodeId: node.id }), "addNode");
      const strokeWidth = overlayStyle?.strokeWidth ?? sourceStyle?.strokeWidth ?? 1.5;
      const nodeFill = overlayStyle?.fill ?? sourceStyle?.fill;
      const nodeStroke = overlayStyle?.stroke ?? sourceStyle?.stroke;
      const nodeText = overlayStyle?.textColor ?? sourceStyle?.textColor;
      const nodeFontSize = overlayStyle?.fontSize ?? sourceStyle?.fontSize ?? 13;
      const nodeDashArray = overlayStyle?.dashArray ?? sourceStyle?.dashArray;
      const nodeWidth = clamp(overlayStyle?.width ?? sourceStyle?.width ?? NODE_WIDTH, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
      const nodeHeight = clamp(overlayStyle?.height ?? sourceStyle?.height ?? NODE_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
      return {
        id: node.id,
        type: "graphNode",
        position: over ?? auto,
        initialWidth: nodeWidth,
        initialHeight: nodeHeight,
        sourcePosition: graphHandleDirection.sourcePosition,
        targetPosition: graphHandleDirection.targetPosition,
        handles: graphNodeHandleBounds(nodeWidth, nodeHeight),
        data: {
          label: renderNodeLabel(node, parsed.model),
          editLabel: node.label,
          shape: getNodeShape(node),
          rawShape: getRawNodeShape(node),
          isRenaming,
          canRename,
          canQuickAdd,
          canResize: inEdit,
          width: nodeWidth,
          height: nodeHeight,
          onRenameStart: () => startRename(node.id),
          onRenameCommit: commitRename,
          onRenameCancel: cancelRename,
          onQuickAdd: (handleId: GraphHandleId) => addConnectedNodeFromHandle(node.id, handleId),
          onResizePreview: (size: ResizeParams) => previewNodeResize(node.id, size),
          onResizeCommit: (size: ResizeParams) => commitNodeResize(node.id, size),
        },
        draggable: inEdit && !isRenaming,
        selectable: inEdit,
        selected: isSelected,
        className: classNames(isSelected && "is-selected", isMoveTarget && "is-parent-target"),
        style: {
          width: nodeWidth,
          height: nodeHeight,
          minHeight: NODE_MIN_HEIGHT,
          border: "none",
          background: "transparent",
          color: "var(--graph-node-text)",
          fontFamily: "var(--font-zh-serif)",
          padding: 0,
          textAlign: "center",
          ...(nodeFill ? { "--graph-node-fill": nodeFill } : {}),
          ...(nodeStroke ? { "--graph-node-stroke": nodeStroke } : {}),
          ...(nodeText ? { "--graph-node-text": nodeText } : {}),
          "--graph-node-stroke-width": `${strokeWidth}px`,
          ...(nodeDashArray ? { "--graph-node-stroke-dasharray": nodeDashArray } : {}),
          "--graph-node-font-size": `${nodeFontSize}px`,
          fontSize: nodeFontSize,
        } as CSSProperties & Record<string, string | number>,
      } satisfies GraphRegularNode;
    });
    const nextNodes: GraphFlowNode[] = [...clusterNodes, ...regularNodes];
    const nextNodeById = new Map(nextNodes.map((node) => [node.id, node]));
    const nextEdges = graphEdges.map((edge) => {
      const style = {
        ...(parsed.model.perEdgeStyles?.[edge.id] ?? {}),
        ...(overlay?.edgeStyles?.[edge.id] ?? {}),
      };
      const fixedHandles = overlay?.edgeHandles?.[edge.id];
      const renderHandles = graphEdgeRenderHandles(edge, nextNodeById, fixedHandles);
      const isSelected = inEdit && edge.id === selectedEdgeId;
      const edgeStroke = style?.stroke ?? parsed.model.themePalette?.lineColor ?? DEFAULT_EDGE_STROKE;
      const edgeLineStyle = getEdgeLineStyle(edge);
      const edgeDirection = getEdgeDirection(edge);
      const sourceMarker = edge.sourceMarker ?? (edgeDirection === "backward" || edgeDirection === "both" ? "arrow" : "none");
      const targetMarker = edge.targetMarker ?? (edgeDirection === "forward" || edgeDirection === "both" ? "arrow" : "none");
      const baseStrokeWidth = style?.strokeWidth ?? (edgeLineStyle === "thick" ? 2.8 : 1.5);
      const renderStrokeWidth = isSelected ? Math.max(baseStrokeWidth, 2.5) : baseStrokeWidth;
      const markerFor = (marker: EdgeMarkerKind) => marker === "arrow"
        ? { type: MarkerType.ArrowClosed, color: edgeStroke }
        : marker === "circle" || marker === "cross"
          ? `url(#graph-${marker}-${graphMarkerSafeId(edge.id)})`
          : undefined;
      return {
        id: edge.id,
        type: "graphEdge",
        source: edge.source,
        target: edge.target,
        sourceHandle: renderHandles.sourceHandle,
        targetHandle: renderHandles.targetHandle,
        data: {
          floating: !fixedHandles?.sourceHandle || !fixedHandles?.targetHandle,
          label: edgeLineStyle === "invisible" ? "" : edge.label ?? "",
          textColor: style?.textColor ?? parsed.model.themePalette?.textColor ?? DEFAULT_EDGE_TEXT,
          canEditLabel: inEdit && capEnabled(getCapabilities(parsed, { edgeId: edge.id }), "setEdgeLabel"),
          isEditingLabel: inEdit && editingEdgeLabelId === edge.id,
          onSelect: () => selectEdge(edge.id),
          onLabelEditStart: () => startEdgeLabelEdit(edge.id),
          onLabelCommit: (label: string) => commitEdgeLabelEdit(edge.id, label),
          onLabelCancel: cancelEdgeLabelEdit,
          sourceMarker,
          targetMarker,
          markerColor: edgeStroke,
          ...(style.curve ? { curve: style.curve } : {}),
        },
        domAttributes: edgeDomAttributes(renderHandles, !fixedHandles?.sourceHandle || !fixedHandles?.targetHandle),
        markerStart: edgeLineStyle === "invisible" ? undefined : markerFor(sourceMarker),
        markerEnd: edgeLineStyle === "invisible" ? undefined : markerFor(targetMarker),
        animated: false,
        selectable: inEdit,
        selected: isSelected,
        className: classNames(isSelected && "is-selected"),
        style: {
          stroke: edgeStroke,
          strokeWidth: renderStrokeWidth,
          ...(style.dashArray ? { strokeDasharray: style.dashArray } : edgeLineStyle === "dotted" ? { strokeDasharray: "4 6" } : {}),
          ...(edgeLineStyle === "invisible" ? { visibility: "hidden" } : {}),
        },
      } satisfies GraphFlowEdge;
    });
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [
    addConnectedNodeFromHandle,
    autoLayout,
    cancelSubgraphRename,
    cancelRename,
    canConnectEdge,
    cancelEdgeLabelEdit,
    commitRename,
    commitEdgeLabelEdit,
    commitSubgraphRename,
    commitNodeResize,
    diagramLayout.clusters,
    editingEdgeLabelId,
    graphEdges,
    graphHandleDirection,
    graphNodes,
    inEdit,
    moveParentTargetIds,
    overlay,
    parentPickerNodeId,
    parsed.model,
    parsed,
    previewNodeResize,
    renamingNodeId,
    renamingSubgraphId,
    selectedEdgeId,
    selectedNodeId,
    selectedSubgraphId,
    selectEdge,
    selectSubgraph,
    startEdgeLabelEdit,
    startRename,
    startSubgraphRename,
  ]);

  const passiveNodes = useMemo<GraphFlowNode[]>(
    () => nodes.map((node) => (
      node.type === "graphNode"
        ? {
            ...node,
            selected: false,
            data: {
              ...node.data,
              isRenaming: false,
              canRename: false,
              canQuickAdd: false,
              canResize: false,
            },
          }
        : {
            ...node,
            selected: false,
            data: {
              ...node.data,
              isRenaming: false,
              canEdit: false,
            },
          }
    )),
    [nodes],
  );

  const beginParentPicker = useCallback(() => {
    if (!selectedNodeId || !isMindmap || !capEnabled(selectedNodeCaps, "moveNode")) return;
    setOpenToolbarMenu(null);
    setParentPickerNodeId(selectedNodeId);
    setRenamingNodeId(null);
    setError(null);
  }, [isMindmap, selectedNodeCaps, selectedNodeId]);

  const handleEditorNodeClick = useCallback(
    (node: Node) => {
      if (node.type === "graphCluster") {
        selectSubgraph(node.id);
        return;
      }
      if (!parentPickerNodeId) {
        selectNode(node.id);
        return;
      }
      if (node.id === parentPickerNodeId || !moveParentTargetIds.has(node.id) || !capEnabled(getCapabilities(parsed, { nodeId: parentPickerNodeId }), "moveNode")) {
        setError("请选择可作为父节点的目标节点");
        return;
      }
      const result = runEdit({ kind: "moveNode", nodeId: parentPickerNodeId, newParentId: node.id });
      if (!result?.ok) return;
      const movedNodeId = result.idMap?.nodes?.[parentPickerNodeId] ?? parentPickerNodeId;
      setSelectedNodeId(movedNodeId);
      setSelectedNodeIds([movedNodeId]);
      setSelectedEdgeId(null);
      setParentPickerNodeId(null);
      setRenamingNodeId(null);
      setError(null);
    },
    [moveParentTargetIds, parentPickerNodeId, parsed, runEdit, selectNode, selectSubgraph],
  );

  const contextPosition = useMemo(
    () => getFloatingPosition({
      selectedNodeId: selectedNodeId ?? selectedSubgraphId,
      selectedEdge,
      nodes,
      viewport: editViewport,
      canvasFrame: editCanvasFrame,
    }),
    [editCanvasFrame, editViewport, nodes, selectedEdge, selectedNodeId, selectedSubgraphId],
  );
  const contextStyle = contextPosition
    ? ({ left: contextPosition.left, top: contextPosition.top } as const)
    : undefined;
  const selectedNodeCanAdd = capEnabled(selectedNodeCaps, "addNode");
  const selectedNodeCanDelete = capEnabled(selectedNodeCaps, "deleteNode");
  const selectedNodeCanMove = capEnabled(selectedNodeCaps, "moveNode") && moveParentOptions.length > 0;
  const selectedNodeCanStyle = !!selectedNodeId && ids.nodes.has(selectedNodeId);
  const selectedNodeCanShape = capEnabled(selectedNodeCaps, "setNodeShape");
  const selectedNodeStyle = selectedNodeId
    ? {
        ...(parsed.model.perNodeStyles?.[selectedNodeId] ?? {}),
        ...(overlay?.styles?.[selectedNodeId] ?? {}),
      }
    : undefined;
  const selectedNodeFill = selectedNodeStyle?.fill ?? parsed.model.themePalette?.nodeFill ?? DEFAULT_NODE_FILL;
  const selectedNodeStroke = selectedNodeStyle?.stroke ?? parsed.model.themePalette?.nodeStroke ?? DEFAULT_NODE_STROKE;
  const selectedSubgraphStyle = selectedSubgraphId && parsed.model.type === "flowchart"
    ? parsed.model.perSubgraphStyles?.[selectedSubgraphId]
    : undefined;
  const selectedSubgraphFill = selectedSubgraphStyle?.fill ?? parsed.model.themePalette?.clusterFill ?? DEFAULT_CLUSTER_FILL;
  const selectedSubgraphStroke = selectedSubgraphStyle?.stroke ?? parsed.model.themePalette?.clusterStroke ?? DEFAULT_CLUSTER_STROKE;
  const selectedNodeShape = selectedNode ? getNodeShape(selectedNode) : "rect";
  const canAddNodeFromToolbar = canAddNodeEmpty || selectedNodeCanAdd;
  const selectedEdgeCanDelete = capEnabled(selectedEdgeCaps, "deleteEdge");
  const selectedEdgeCanStyle = !!selectedEdgeId && ids.edges.has(selectedEdgeId);
  const selectedEdgeCanArrow = capEnabled(selectedEdgeCaps, "setEdgeArrow");
  const selectedEdgeStyle = selectedEdgeId ? overlay?.edgeStyles?.[selectedEdgeId] : undefined;
  const selectedEdgeDirection = selectedEdge ? getEdgeDirection(selectedEdge) : "forward";
  const selectedEdgeLineStyle = selectedEdge ? getEdgeLineStyle(selectedEdge) : "solid";

  const duplicateNodeAt = useCallback(
    (snapshot: GraphNodeDragSnapshot, position: { x: number; y: number }) => {
      if (!capEnabled(getCapabilities(parseDiagram(liveSourceRef.current), { nodeId: snapshot.id }), "addNode")) return;
      const addResult = runEdit({
        kind: "addNode",
        label: snapshot.label,
        parentId: isMindmap ? findMindmapParentId(parsed.model, snapshot.id) ?? undefined : undefined,
      });
      const newNodeId = addResult?.newNodeId;
      if (!addResult?.ok || !newNodeId) return;
      if (snapshot.shape && capEnabled(getCapabilities(parseDiagram(liveSourceRef.current), { nodeId: newNodeId }), "setNodeShape")) {
        runEdit({ kind: "setNodeShape", nodeId: newNodeId, shape: snapshot.shape });
      }
      emitOverlay(
        {
          ...(overlayRef.current ?? {}),
          positions: {
            ...(overlayRef.current?.positions ?? {}),
            [newNodeId]: { x: Math.round(position.x), y: Math.round(position.y) },
          },
          styles: snapshot.style
            ? {
                ...(overlayRef.current?.styles ?? {}),
                [newNodeId]: { ...snapshot.style },
              }
            : overlayRef.current?.styles,
        },
        { nodes: [newNodeId] },
      );
      setSelectedNodeId(newNodeId);
      setSelectedNodeIds([newNodeId]);
      setSelectedEdgeId(null);
      setSelectedEdgeIds([]);
    },
    [emitOverlay, isMindmap, parsed.model, runEdit],
  );

  const commitDroppedNodes = useCallback((droppedNodes: Node[]) => {
    commitNodePositions(droppedNodes);
    if (!parsed.ok || parsed.model.type !== "flowchart") return;
    const clusterNodes = nodesRef.current.filter((item): item is GraphClusterNode => item.type === "graphCluster");
    const modelNodeById = new Map(parsed.model.nodes.map((item) => [item.id, item]));
    for (const droppedNode of droppedNodes) {
      if (droppedNode.type === "graphCluster") continue;
      const modelNode = modelNodeById.get(droppedNode.id);
      if (!modelNode) continue;
      const targetSubgraph = deepestSubgraphAtPoint(graphNodeCenter(droppedNode), clusterNodes);
      const target = targetSubgraph
        ? parsed.model.subgraphs.find((subgraph) => subgraph.id === targetSubgraph)
        : undefined;
      const nextScopePath = target ? [...target.scopePath, target.id] : [];
      if (sameStringPath(modelNode.scopePath, nextScopePath)) continue;
      runRewrite((baseSource) => moveNodeToSubgraph(baseSource, droppedNode.id, targetSubgraph));
    }
  }, [commitNodePositions, parsed, runRewrite]);

  const handleNodeDragStart = useCallback(
    (event: MouseEvent | TouchEvent, node: Node, draggedNodes: Node[]) => {
      editorRef.current?.focus({ preventScroll: true });
      if (!inEdit) return;
      if (node.type === "graphCluster" && parsed.ok && parsed.model.type === "flowchart") {
        const descendantNodeIds = new Set(
          parsed.model.nodes.filter((item) => item.scopePath.includes(node.id)).map((item) => item.id),
        );
        const descendantSubgraphIds = new Set(
          parsed.model.subgraphs.filter((item) => item.scopePath.includes(node.id)).map((item) => item.id),
        );
        clusterDragRef.current = {
          clusterId: node.id,
          startPosition: { ...node.position },
          movingPositions: Object.fromEntries(
            nodesRef.current
              .filter((item) => descendantNodeIds.has(item.id) || descendantSubgraphIds.has(item.id))
              .map((item) => [item.id, { ...item.position }]),
          ),
        };
        altDuplicateDragRef.current = null;
        shiftDragRef.current = null;
        selectSubgraph(node.id);
        return;
      }
      const source = graphNodes.find((item) => item.id === node.id);
      if (!source) return;
      if (eventHasAlt(event) && capEnabled(getCapabilities(parseDiagram(liveSourceRef.current), { nodeId: node.id }), "addNode")) {
        altDuplicateDragRef.current = {
          source: {
            id: node.id,
            position: { ...node.position },
            label: source.label,
            shape: copyableFlowShape(source),
            style: overlayRef.current?.styles?.[node.id] ? { ...overlayRef.current.styles[node.id] } : undefined,
          },
          dropPosition: { ...node.position },
        };
        shiftDragRef.current = null;
        return;
      }
      if (eventHasShift(event)) {
        const group = draggedNodes.length > 0 ? draggedNodes : [node];
        shiftDragRef.current = {
          active: true,
          axis: null,
          startPositions: Object.fromEntries(group.map((item) => [item.id, { ...item.position }])),
        };
      } else {
        shiftDragRef.current = null;
      }
    },
    [graphNodes, inEdit, parsed, selectSubgraph],
  );

  const handleNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: Node) => {
    const clusterState = clusterDragRef.current;
    if (clusterState && clusterState.clusterId === node.id) {
      const dx = node.position.x - clusterState.startPosition.x;
      const dy = node.position.y - clusterState.startPosition.y;
      setNodes((current) =>
        current.map((item) => {
          const start = clusterState.movingPositions[item.id];
          return start ? { ...item, position: { x: start.x + dx, y: start.y + dy } } : item;
        }),
      );
      return;
    }
    const altState = altDuplicateDragRef.current;
    if (altState && altState.source.id === node.id) {
      altState.dropPosition = { ...node.position };
      setNodes((current) =>
        current.map((item) =>
          item.id === altState.source.id ? { ...item, position: { ...altState.source.position }, dragging: false } : item,
        ),
      );
      return;
    }
    const shiftState = shiftDragRef.current;
    if (!shiftState?.active) return;
    const constrained = constrainedShiftPositions(shiftState, node);
    setNodes((current) =>
      current.map((item) => (constrained[item.id] ? { ...item, position: constrained[item.id]! } : item)),
    );
  }, []);

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node, draggedNodes: Node[]) => {
      const clusterState = clusterDragRef.current;
      if (clusterState && clusterState.clusterId === node.id) {
        clusterDragRef.current = null;
        const dx = node.position.x - clusterState.startPosition.x;
        const dy = node.position.y - clusterState.startPosition.y;
        const movedElements = nodesRef.current
          .filter((item) => !!clusterState.movingPositions[item.id])
          .map((item) => {
            const start = clusterState.movingPositions[item.id]!;
            return { ...item, position: { x: start.x + dx, y: start.y + dy }, dragging: false };
          });
        setNodes((current) =>
          current.map((item) => {
            const start = clusterState.movingPositions[item.id];
            return start ? { ...item, position: { x: start.x + dx, y: start.y + dy }, dragging: false } : item;
          }),
        );
        commitNodePositions([{ ...node, position: { ...node.position }, dragging: false }, ...movedElements]);
        return;
      }
      const altState = altDuplicateDragRef.current;
      if (altState && altState.source.id === node.id) {
        altDuplicateDragRef.current = null;
        setNodes((current) =>
          current.map((item) =>
            item.id === altState.source.id ? { ...item, position: { ...altState.source.position }, dragging: false } : item,
          ),
        );
        duplicateNodeAt(altState.source, altState.dropPosition);
        return;
      }
      const shiftState = shiftDragRef.current;
      if (shiftState?.active) {
        shiftDragRef.current = null;
        const constrained = constrainedShiftPositions(shiftState, node);
        const committed = (draggedNodes.length > 0 ? draggedNodes : [node])
          .map((item) => (constrained[item.id] ? { ...item, position: constrained[item.id]! } : item));
        setNodes((current) =>
          current.map((item) => (constrained[item.id] ? { ...item, position: constrained[item.id]!, dragging: false } : item)),
        );
        commitDroppedNodes(committed);
        return;
      }
      commitDroppedNodes(draggedNodes.length > 0 ? draggedNodes : [node]);
    },
    [commitDroppedNodes, commitNodePositions, duplicateNodeAt],
  );

  useEffect(() => {
    if (import.meta.env.MODE !== "test" || !inEdit) return;
    const editor = editorRef.current;
    if (!editor) return;

    // DOM 回归测试用入口，避免 jsdom 依赖 d3 全局拖拽状态。
    const handleTestAction = (event: Event) => {
      const action = (event as CustomEvent<GraphDiagramTestAction>).detail;
      if (!action) return;
      if (action.kind === "altDuplicate") {
        const source = graphNodes.find((item) => item.id === action.nodeId);
        if (!source) return;
        const flowNode = nodesRef.current.find((item) => item.id === action.nodeId);
        duplicateNodeAt(
          {
            id: action.nodeId,
            position: flowNode?.position ?? overlayRef.current?.positions?.[action.nodeId] ?? { x: 0, y: 0 },
            label: source.label,
            shape: copyableFlowShape(source),
            style: overlayRef.current?.styles?.[action.nodeId] ? { ...overlayRef.current.styles[action.nodeId] } : undefined,
          },
          action.dropPosition,
        );
        return;
      }
      if (action.kind === "shiftDrag") {
        const flowNode = nodesRef.current.find((item) => item.id === action.nodeId);
        if (!flowNode) return;
        const dx = action.dropPosition.x - flowNode.position.x;
        const dy = action.dropPosition.y - flowNode.position.y;
        const position = Math.abs(dx) >= Math.abs(dy)
          ? { x: action.dropPosition.x, y: flowNode.position.y }
          : { x: flowNode.position.x, y: action.dropPosition.y };
        setNodes((current) =>
          current.map((item) => (item.id === action.nodeId ? { ...item, position } : item)),
        );
        commitDroppedNodes([{ ...flowNode, position }]);
        return;
      }
      if (action.kind === "boxSelect") {
        const nodeIds = action.nodeIds.filter((id) => ids.nodes.has(id));
        const edgeIds = (action.edgeIds ?? []).filter((id) => ids.edges.has(id));
        const selectedNodes = new Set(nodeIds);
        const selectedEdges = new Set(edgeIds);
        setNodes((current) =>
          current.map((item) => ({ ...item, selected: selectedNodes.has(item.id) })),
        );
        setEdges((current) =>
          current.map((item) => ({ ...item, selected: selectedEdges.has(item.id) })),
        );
        setSelectedNodeIds(nodeIds);
        setSelectedEdgeIds(edgeIds);
        setSelectedNodeId(nodeIds.length === 1 && edgeIds.length === 0 ? nodeIds[0]! : null);
        setSelectedEdgeId(edgeIds.length === 1 && nodeIds.length === 0 ? edgeIds[0]! : null);
        if (nodeIds.length !== 1 || edgeIds.length > 0) setRenamingNodeId(null);
        if (nodeIds.length !== 1 || edgeIds.length > 0) setParentPickerNodeId(null);
        if (nodeIds.length !== 1 && edgeIds.length !== 1) setOpenToolbarMenu(null);
        return;
      }
      if (action.kind === "moveParent") {
        if (!capEnabled(getCapabilities(parseDiagram(liveSourceRef.current), { nodeId: action.nodeId }), "moveNode")) return;
        const result = runEdit({ kind: "moveNode", nodeId: action.nodeId, newParentId: action.newParentId });
        if (!result?.ok) return;
        const movedNodeId = result.idMap?.nodes?.[action.nodeId] ?? action.nodeId;
        setSelectedNodeId(movedNodeId);
        setSelectedNodeIds([movedNodeId]);
        setSelectedEdgeId(null);
        setSelectedEdgeIds([]);
        setRenamingNodeId(null);
        setEditingEdgeLabelId(null);
        setParentPickerNodeId(null);
        setOpenToolbarMenu(null);
        return;
      }
      if (action.kind === "drawSubgraph") {
        createSubgraphFromRect(action.rect);
        return;
      }
      if (action.kind === "dropNode") {
        const flowNode = nodesRef.current.find((item): item is GraphRegularNode => item.id === action.nodeId && item.type === "graphNode");
        if (!flowNode) return;
        const moved = { ...flowNode, position: action.position };
        setNodes((current) => current.map((item) => (item.id === action.nodeId ? moved : item)));
        commitDroppedNodes([moved]);
        return;
      }
      if (action.kind === "resizeNode") {
        previewNodeResize(action.nodeId, action.rect);
        commitNodeResize(action.nodeId, action.rect);
        return;
      }
      if (action.kind === "resizeNodePreview") {
        previewNodeResize(action.nodeId, action.rect);
        return;
      }
      if (action.kind === "moveSubgraph" && parsed.ok && parsed.model.type === "flowchart") {
        const descendantIds = new Set(
          parsed.model.nodes.filter((item) => item.scopePath.includes(action.subgraphId)).map((item) => item.id),
        );
        const descendantSubgraphIds = new Set(
          parsed.model.subgraphs.filter((item) => item.scopePath.includes(action.subgraphId)).map((item) => item.id),
        );
        const moved = nodesRef.current
          .filter((item) => (
            item.id === action.subgraphId ||
            descendantIds.has(item.id) ||
            descendantSubgraphIds.has(item.id)
          ))
          .map((item) => ({
            ...item,
            position: {
              x: item.position.x + action.delta.x,
              y: item.position.y + action.delta.y,
            },
          }));
        setNodes((current) =>
          current.map((item) => {
            const next = moved.find((candidate) => candidate.id === item.id);
            return next ?? item;
          }),
        );
        commitNodePositions(moved);
      }
    };

    editor.addEventListener("graph-diagram-test-action", handleTestAction);
    return () => editor.removeEventListener("graph-diagram-test-action", handleTestAction);
  }, [
    commitDroppedNodes,
    commitNodePositions,
    commitNodeResize,
    duplicateNodeAt,
    graphNodes,
    ids.edges,
    ids.nodes,
    inEdit,
    parsed,
    previewNodeResize,
    createSubgraphFromRect,
    runEdit,
  ]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || isEditableKeyboardTarget(event.target)) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        deleteSelection();
      }
    },
    [deleteSelection],
  );

  if (!parsed.ok) {
    return <pre className="pm-diagram-error">图表解析失败:{parsed.error ?? "unknown"}{"\n\n"}{liveSource}</pre>;
  }

  const editor = editing && !readOnly && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={editorRef}
          className="graph-diagram-editor diagram-editor-chrome"
          role="dialog"
          aria-modal="true"
          aria-label="图表编辑器"
          tabIndex={-1}
          data-editor-owner={editorOwnerIdRef.current ?? undefined}
          style={themeStyle}
          onKeyDown={handleEditorKeyDown}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
            else if (!isEditableKeyboardTarget(event.target)) editorRef.current?.focus({ preventScroll: true });
          }}
        >
          <div className="graph-diagram-editor__topbar diagram-editor-chrome__topbar">
            <div className="graph-diagram-editor__title diagram-editor-chrome__title">Mermaid 编辑</div>
            <button
              type="button"
              className="graph-diagram-editor__close diagram-editor-chrome__close"
              aria-label="关闭"
              title="关闭"
              onClick={closeEditor}
            >
              ✕
            </button>
          </div>
          <div className="graph-diagram-editor__bottom-toolbar diagram-editor-chrome__toolbar" role="toolbar" aria-label="图表编辑操作">
            <CanvasToolButton
              label="新增节点"
              icon="plus"
              disabled={!canAddNodeFromToolbar}
              showLabel
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                addNode();
              }}
            />
            {parsed.model.type === "flowchart" && (
              <CanvasToolButton
                label="新增分区"
                icon="subgraph"
                active={subgraphDrawMode}
                pressed={subgraphDrawMode}
                showLabel
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  beginSubgraphDrawing();
                }}
              />
            )}
          </div>
          {error && <div className="graph-diagram-error graph-diagram-error--floating">{error}</div>}
          <div
            className={classNames(
              "graph-diagram-canvas",
              "graph-diagram-canvas--editor",
              connecting && "is-connecting",
              subgraphDrawMode && "is-drawing-subgraph",
              (panMode || spacePanning) && "is-pan-enabled",
            )}
            ref={editorFit.canvasRef}
            onPointerDownCapture={handleSubgraphPointerDown}
            onPointerMove={handleSubgraphPointerMove}
            onPointerUp={handleSubgraphPointerUp}
            onPointerCancel={() => {
              subgraphDrawStartRef.current = null;
              setSubgraphPreview(null);
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={graphNodeTypes}
              edgeTypes={graphEdgeTypes}
              connectionMode={ConnectionMode.Loose}
              fitView
              minZoom={0.1}
              onInit={editorFit.onInit}
              onMove={(_event, viewport) => setEditViewport(viewport)}
              nodesDraggable={inEdit && !subgraphDrawMode}
              nodesConnectable={canConnectEdge && !subgraphDrawMode}
              elementsSelectable={!subgraphDrawMode}
              deleteKeyCode={null}
              selectionKeyCode={["Control", "Meta"]}
              multiSelectionKeyCode={["Control", "Meta"]}
              selectionMode={SelectionMode.Partial}
              selectionOnDrag={false}
              panOnDrag={!subgraphDrawMode && (panMode || spacePanning)}
              proOptions={{ hideAttribution: true }}
              zoomOnDoubleClick={false}
              // 关掉拖节点时的自动平移:alt 拖拽复制会把源节点钉在原位,但 React Flow 的拖拽仍"活跃",
              // 光标靠近边缘就触发 autoPan → 画布跟着被拖走(用户反馈)。本编辑器默认 fitView 能整张展示,不需要自动平移。
              autoPanOnNodeDrag={false}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStart={handleNodeDragStart}
              onNodeDrag={handleNodeDrag}
              onNodeDragStop={handleNodeDragStop}
              onConnect={onConnect}
              onReconnect={onReconnect}
              edgesReconnectable={canConnectEdge}
              onSelectionChange={syncSelection}
              onConnectStart={() => setConnecting(true)}
              onConnectEnd={() => setConnecting(false)}
              onNodeClick={(event, node) => {
                event.stopPropagation();
                handleEditorNodeClick(node);
              }}
              onNodeDoubleClick={(event, node) => {
                event.stopPropagation();
                if (node.type === "graphCluster") startSubgraphRename(node.id);
                else startRename(node.id);
              }}
              onEdgeClick={(event, edge) => {
                event.stopPropagation();
                selectEdge(edge.id);
              }}
              onEdgeDoubleClick={(event, edge) => {
                event.stopPropagation();
                startEdgeLabelEdit(edge.id);
              }}
              onPaneClick={() => {
                if (!subgraphDrawMode) clearSelection();
              }}
            >
              <FitOnNodesInitialized />
              <Background color="#d8c9a8" gap={18} />
              <GraphViewportControls
                showHistory
                onUndo={onUndo}
                onRedo={onRedo}
                canUndo={canUndo}
                canRedo={canRedo}
                panMode={panMode}
                onPanModeChange={setPanMode}
              />
              {subgraphPreview && (
                <ViewportPortal>
                  <div
                    className="graph-diagram-subgraph-draft"
                    style={{
                      left: subgraphPreview.x,
                      top: subgraphPreview.y,
                      width: subgraphPreview.width,
                      height: subgraphPreview.height,
                    }}
                  >
                  </div>
                </ViewportPortal>
              )}
            </ReactFlow>
          </div>
          {selectedSubgraph && contextPosition && renamingSubgraphId !== selectedSubgraph.id && (
            <div
              className={classNames(
                "graph-diagram-context graph-diagram-toolbar doc-toolbar on graph-diagram-context--subgraph",
                `graph-diagram-context--${contextPosition.placement}`,
                contextPosition.placement === "below" && "is-below",
              )}
              style={contextStyle}
              aria-label="分区上下文操作"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="graph-diagram-toolbar__row" role="toolbar" aria-label="分区操作工具栏">
                <ToolbarDropdownButton
                  menu="subgraph-fill"
                  label="填充"
                  icon="fill"
                  swatchColor={selectedSubgraphFill}
                  openMenu={openToolbarMenu}
                  onToggle={setOpenToolbarMenu}
                />
                <ToolbarDropdownButton
                  menu="subgraph-border"
                  label="边框"
                  icon="border"
                  swatchColor={selectedSubgraphStroke}
                  openMenu={openToolbarMenu}
                  onToggle={setOpenToolbarMenu}
                />
                <button
                  type="button"
                  className="graph-diagram-toolbar__button"
                  aria-label="解散分区"
                  title="解散分区"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dissolveSelectedSubgraph();
                  }}
                >
                  <CanvasToolIcon name="dissolve" />
                </button>
              </div>
              {openToolbarMenu === "subgraph-fill" && (
                <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="分区填充设置">
                  <ColorControl
                    label="分区填充色"
                    value={selectedSubgraphFill}
                    disabled={false}
                    swatches={NODE_FILL_COLORS}
                    onChange={(fill) => updateSelectedSubgraphStyle({ fill })}
                  />
                </div>
              )}
              {openToolbarMenu === "subgraph-border" && (
                <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="分区边框设置">
                  <ColorControl
                    label="分区边框色"
                    value={selectedSubgraphStroke}
                    disabled={false}
                    swatches={NODE_STROKE_COLORS}
                    onChange={(stroke) => updateSelectedSubgraphStyle({ stroke })}
                  />
                </div>
              )}
            </div>
          )}
          {selectedNode && contextPosition && renamingNodeId !== selectedNode.id && (
            <div
              className={classNames(
                "graph-diagram-context graph-diagram-toolbar doc-toolbar on graph-diagram-context--node",
                `graph-diagram-context--${contextPosition.placement}`,
                contextPosition.placement === "below" && "is-below",
              )}
              style={contextStyle}
              aria-label="节点上下文操作"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {parentPickerNodeId === selectedNode.id ? (
                <div className="graph-diagram-toolbar__row">
                  <span className="graph-diagram-context__hint">点击目标节点完成改父</span>
                  <button type="button" className="graph-diagram-toolbar__button dt-btn" onClick={() => setParentPickerNodeId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <div className="graph-diagram-toolbar__row" role="toolbar" aria-label="节点样式工具栏">
                    <ToolbarDropdownButton
                      menu="node-shape"
                      label="形状"
                      icon="shape"
                      valueLabel={NODE_SHAPE_LABELS[selectedNodeShape]}
                      disabled={!selectedNodeCanShape}
                      openMenu={openToolbarMenu}
                      onToggle={setOpenToolbarMenu}
                    />
                    <ToolbarDropdownButton menu="node-fill" label="填充" icon="fill" swatchColor={selectedNodeFill} disabled={!selectedNodeCanStyle} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                    <ToolbarDropdownButton menu="node-border" label="边框" icon="border" swatchColor={selectedNodeStroke} disabled={!selectedNodeCanStyle} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                    <ToolbarDropdownButton menu="node-text" label="文字" icon="text" disabled={!selectedNodeCanStyle} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                    <ToolbarDropdownButton menu="node-more" label="…更多" icon="more" openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                  </div>
                  {openToolbarMenu === "node-shape" && (
                    <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="形状选择">
                      <div className="graph-diagram-shape-grid" aria-label="节点形状">
                        {NODE_SHAPE_OPTIONS.map((item) => (
                          <button
                            key={item.shape}
                            type="button"
                            className={classNames("graph-diagram-shape-btn dt-mi", selectedNodeShape === item.shape && "is-active")}
                            disabled={!selectedNodeCanShape}
                            aria-pressed={selectedNodeShape === item.shape}
                            onClick={() => {
                              setSelectedNodeShape(item.shape);
                              setOpenToolbarMenu(null);
                            }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {openToolbarMenu === "node-fill" && (
                    <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="填充设置">
                      <ColorControl
                        label="填充色"
                        value={selectedNodeStyle?.fill ?? DEFAULT_NODE_FILL}
                        disabled={!selectedNodeCanStyle}
                        swatches={NODE_FILL_COLORS}
                        opacityLabel="填充不透明度"
                        onChange={(fill) => updateNodeStyle({ fill })}
                      />
                    </div>
                  )}
                  {openToolbarMenu === "node-border" && (
                    <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="边框设置">
                      <ColorControl
                        label="边框色"
                        value={selectedNodeStyle?.stroke ?? DEFAULT_NODE_STROKE}
                        disabled={!selectedNodeCanStyle}
                        swatches={NODE_STROKE_COLORS}
                        onChange={(stroke) => updateNodeStyle({ stroke })}
                      />
                      <NumberRangeControl
                        label="边框粗细"
                        inputLabel="边框粗细(px)"
                        disabled={!selectedNodeCanStyle}
                        value={selectedNodeStyle?.strokeWidth ?? 1.5}
                        min={NODE_STROKE_WIDTH_RANGE.min}
                        max={NODE_STROKE_WIDTH_RANGE.max}
                        step={NODE_STROKE_WIDTH_RANGE.step}
                        onChange={(strokeWidth) => updateNodeStyle({ strokeWidth })}
                      />
                    </div>
                  )}
                  {openToolbarMenu === "node-text" && (
                    <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="文字设置">
                      <ColorControl
                        label="文字色"
                        value={selectedNodeStyle?.textColor ?? DEFAULT_NODE_TEXT}
                        disabled={!selectedNodeCanStyle}
                        swatches={NODE_TEXT_COLORS}
                        onChange={(textColor) => updateNodeStyle({ textColor })}
                      />
                      <NumberRangeControl
                        label="字号"
                        inputLabel="字号(px)"
                        disabled={!selectedNodeCanStyle}
                        value={selectedNodeStyle?.fontSize ?? DEFAULT_NODE_FONT_SIZE}
                        min={NODE_FONT_SIZE_RANGE.min}
                        max={NODE_FONT_SIZE_RANGE.max}
                        step={NODE_FONT_SIZE_RANGE.step}
                        onChange={(fontSize) => updateNodeStyle({ fontSize })}
                      />
                    </div>
                  )}
                  {openToolbarMenu === "node-more" && (
                    <div className="graph-diagram-popover graph-diagram-popover--menu dt-menu" role="menu" aria-label="节点更多操作">
                      <MenuActionButton label={isMindmap ? "加子节点" : "新增节点"} shortcut={isMindmap ? "Tab" : "N"} disabled={!selectedNodeCanAdd} onClick={addNode} />
                      {isMindmap && <MenuActionButton label="改父" shortcut="M" disabled={!selectedNodeCanMove} onClick={beginParentPicker} />}
                      <MenuActionButton label="重置样式" shortcut="⌥R" disabled={!selectedNodeCanStyle} onClick={resetNodeStyle} />
                      <MenuActionButton label="删除节点" shortcut="Del" disabled={!selectedNodeCanDelete} danger onClick={deleteSelectedNode} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {selectedEdge && contextPosition && editingEdgeLabelId !== selectedEdge.id && (
            <div
              className={classNames(
                "graph-diagram-context graph-diagram-toolbar doc-toolbar on graph-diagram-context--edge",
                `graph-diagram-context--${contextPosition.placement}`,
                contextPosition.placement === "below" && "is-below",
              )}
              style={contextStyle}
              aria-label="连线上下文操作"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <div className="graph-diagram-toolbar__row" role="toolbar" aria-label="连线样式工具栏">
                <ToolbarDropdownButton menu="edge-line" label="线" icon="line" disabled={!selectedEdgeCanStyle} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                <ToolbarDropdownButton menu="edge-arrow" label="箭头" icon={edgeDirectionIcon(selectedEdgeDirection)} disabled={!selectedEdgeCanArrow} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                <ToolbarDropdownButton menu="edge-label" label="标签" icon="text" disabled={!selectedEdgeCanStyle} openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
                <ToolbarDropdownButton menu="edge-more" label="…更多" icon="more" openMenu={openToolbarMenu} onToggle={setOpenToolbarMenu} />
              </div>
              {openToolbarMenu === "edge-line" && (
                <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="线条设置">
                  <ColorControl
                    label="线色"
                    value={selectedEdgeStyle?.stroke ?? DEFAULT_EDGE_STROKE}
                    disabled={!selectedEdgeCanStyle}
                    swatches={EDGE_COLORS}
                    onChange={(stroke) => updateEdgeStyle({ stroke })}
                  />
                  <NumberRangeControl
                    label="线宽"
                    inputLabel="线宽(px)"
                    disabled={!selectedEdgeCanStyle}
                    value={selectedEdgeStyle?.strokeWidth ?? 1.5}
                    min={EDGE_STROKE_WIDTH_RANGE.min}
                    max={EDGE_STROKE_WIDTH_RANGE.max}
                    step={EDGE_STROKE_WIDTH_RANGE.step}
                    onChange={(strokeWidth) => updateEdgeStyle({ strokeWidth })}
                  />
                </div>
              )}
              {openToolbarMenu === "edge-arrow" && (
                <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="箭头设置">
                  <IconOptionGroup label="方向">
                    {EDGE_DIRECTION_OPTIONS.map((item) => (
                      <IconOptionButton
                        key={item.direction}
                        icon={item.icon}
                        label={item.label}
                        active={selectedEdgeDirection === item.direction}
                        disabled={!selectedEdgeCanArrow}
                        onClick={() => setSelectedEdgeArrow({ direction: item.direction })}
                      />
                    ))}
                  </IconOptionGroup>
                  <IconOptionGroup label="线型">
                    {EDGE_LINE_STYLE_OPTIONS.map((item) => (
                      <IconOptionButton
                        key={item.lineStyle}
                        icon={item.icon}
                        label={item.label}
                        active={selectedEdgeLineStyle === item.lineStyle}
                        disabled={!selectedEdgeCanArrow}
                        onClick={() => setSelectedEdgeArrow({ lineStyle: item.lineStyle })}
                      />
                    ))}
                  </IconOptionGroup>
                </div>
              )}
              {openToolbarMenu === "edge-label" && (
                <div className="graph-diagram-popover dt-menu" role="dialog" aria-label="标签设置">
                  <ColorControl
                    label="标签色"
                    value={selectedEdgeStyle?.textColor ?? DEFAULT_EDGE_TEXT}
                    disabled={!selectedEdgeCanStyle}
                    swatches={NODE_TEXT_COLORS}
                    onChange={(textColor) => updateEdgeStyle({ textColor })}
                  />
                </div>
              )}
              {openToolbarMenu === "edge-more" && (
                <div className="graph-diagram-popover graph-diagram-popover--menu dt-menu" role="menu" aria-label="连线更多操作">
                  <MenuActionButton label="重置样式" shortcut="⌥R" disabled={!selectedEdgeCanStyle} onClick={resetEdgeStyle} />
                  <MenuActionButton label="删除连线" shortcut="Del" disabled={!selectedEdgeCanDelete} danger onClick={deleteSelectedEdge} />
                </div>
              )}
            </div>
          )}
        </div>,
        document.body,
      )
    : null;

  const fullscreenViewer = viewingFullscreen && typeof document !== "undefined"
    ? createPortal(
        <div
          className="graph-diagram-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="图表全屏预览"
          style={themeStyle}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFullscreen();
          }}
        >
          <div className="graph-diagram-viewer__topbar">
            <div className="graph-diagram-viewer__title">图表预览</div>
            <button type="button" className="graph-diagram-editor__close" onClick={closeFullscreen}>
              关闭
            </button>
          </div>
          <div
            className="graph-diagram-canvas graph-diagram-canvas--preview graph-diagram-canvas--fullscreen"
            ref={fullscreenFit.canvasRef}
          >
            <ReactFlow
              nodes={passiveNodes}
              edges={edges}
              nodeTypes={graphNodeTypes}
              edgeTypes={graphEdgeTypes}
              connectionMode={ConnectionMode.Loose}
              fitView
              minZoom={MIN_PREVIEW_ZOOM}
              onInit={fullscreenFit.onInit}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={panMode}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
              zoomOnDoubleClick={false}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
            >
              <FitOnNodesInitialized />
              <Background color="#d8c9a8" gap={18} />
              <GraphViewportControls
                showHistory={false}
                panMode={panMode}
                onPanModeChange={setPanMode}
              />
            </ReactFlow>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="graph-diagram" data-diagram-type={parsed.model.type} style={themeStyle}>
      {error && !inEdit && <div className="graph-diagram-error">{error}</div>}
      <div
        className="graph-diagram-canvas graph-diagram-canvas--preview"
        ref={previewFit.canvasRef}
      >
        <ReactFlow
          nodes={passiveNodes}
          edges={edges}
          nodeTypes={graphNodeTypes}
          edgeTypes={graphEdgeTypes}
          connectionMode={ConnectionMode.Loose}
          fitView
          minZoom={MIN_PREVIEW_ZOOM}
          onInit={previewFit.onInit}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onPaneClick={clearSelection}
        >
          <FitPreviewOnLayoutApplied expectedLayoutKey={previewFitKey} />
          <Background color="#d8c9a8" gap={18} />
          <GraphPreviewToolbar
            readOnly={readOnly}
            align={align}
            onAlignChange={onAlignChange}
            onZoomIn={previewFit.zoomIn}
            onZoomOut={previewFit.zoomOut}
            onFullscreen={openFullscreen}
          />
        </ReactFlow>
      </div>
      {editor}
      {fullscreenViewer}
      <div className="graph-diagram-export" aria-hidden="true" dangerouslySetInnerHTML={{ __html: graphToSvg(liveSource, overlay ?? undefined) ?? "" }} />
    </div>
  );
}

function ToolbarDropdownButton({
  menu,
  label,
  icon,
  swatchColor,
  valueLabel,
  disabled = false,
  openMenu,
  onToggle,
}: {
  menu: ToolbarMenu;
  label: string;
  icon: IconName;
  swatchColor?: string;
  valueLabel?: string;
  disabled?: boolean;
  openMenu: ToolbarMenu | null;
  onToggle: (menu: ToolbarMenu | null) => void;
}) {
  const active = openMenu === menu;
  return (
    <button
      type="button"
      className={classNames("graph-diagram-toolbar__button dt-btn", active && "is-active")}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={active}
      aria-label={valueLabel ? `${label}:${valueLabel}` : label}
      title={valueLabel ? `${label}:${valueLabel}` : label}
      onClick={() => onToggle(active ? null : menu)}
      data-swatch-color={swatchColor}
    >
      <GraphIcon name={icon} color={swatchColor} />
      {valueLabel ? <span className="graph-diagram-toolbar__value">{valueLabel}</span> : null}
      <span className="graph-diagram-toolbar__caret" aria-hidden="true">▾</span>
    </button>
  );
}

function IconOptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="graph-diagram-icon-options" aria-label={label}>
      <div className="graph-diagram-icon-options__label">{label}</div>
      <div className="graph-diagram-icon-options__row">{children}</div>
    </div>
  );
}

function IconOptionButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={classNames("graph-diagram-icon-option dt-btn", active && "is-active")}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <GraphIcon name={icon} />
    </button>
  );
}

function GraphIcon({ name, color }: { name: IconName; color?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg className="graph-diagram-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === "shape" && <rect x="5" y="5" width="14" height="14" rx="3" {...common} />}
      {name === "fill" && (
        <circle
          className="graph-diagram-icon__color-sample graph-diagram-icon__color-sample--fill"
          cx="12"
          cy="12"
          r="6"
          fill={color ?? "currentColor"}
          stroke="rgba(255, 250, 240, 0.55)"
          strokeWidth="1"
        />
      )}
      {name === "border" && (
        <circle
          className="graph-diagram-icon__color-sample graph-diagram-icon__color-sample--border"
          cx="12"
          cy="12"
          r="5.5"
          fill="none"
          stroke={color ?? "currentColor"}
          strokeWidth="2.5"
        />
      )}
      {name === "text" && (
        <>
          <path d="M5 6h14" {...common} />
          <path d="M12 6v12" {...common} />
          <path d="M9 18h6" {...common} />
        </>
      )}
      {name === "more" && (
        <>
          <circle cx="7" cy="12" r="1.2" fill="currentColor" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
          <circle cx="17" cy="12" r="1.2" fill="currentColor" />
        </>
      )}
      {name === "line" && <path d="M4 12h16" {...common} />}
      {name === "line-dotted" && <path d="M4 12h16" strokeDasharray="2 4" {...common} />}
      {name === "line-thick" && <path d="M4 12h16" strokeWidth="3.2" strokeLinecap="round" stroke="currentColor" />}
      {name === "arrow-right" && (
        <>
          <path d="M4 12h15" {...common} />
          <path d="m14 7 5 5-5 5" {...common} />
        </>
      )}
      {name === "arrow-left" && (
        <>
          <path d="M5 12h15" {...common} />
          <path d="m10 7-5 5 5 5" {...common} />
        </>
      )}
      {name === "arrow-both" && (
        <>
          <path d="M5 12h14" {...common} />
          <path d="m10 7-5 5 5 5" {...common} />
          <path d="m14 7 5 5-5 5" {...common} />
        </>
      )}
      {name === "trash" && (
        <>
          <path d="M6 7h12" {...common} />
          <path d="M9 7V5h6v2" {...common} />
          <path d="M8 10v8h8v-8" {...common} />
        </>
      )}
      {name === "plus" && (
        <>
          <path d="M12 5v14" {...common} />
          <path d="M5 12h14" {...common} />
        </>
      )}
      {name === "reset" && (
        <>
          <path d="M7 8a7 7 0 1 1-1 7" {...common} />
          <path d="M7 4v4h4" {...common} />
        </>
      )}
      {name === "move" && (
        <>
          <path d="M12 4v16" {...common} />
          <path d="M4 12h16" {...common} />
          <path d="m8 8 4-4 4 4" {...common} />
          <path d="m8 16 4 4 4-4" {...common} />
        </>
      )}
    </svg>
  );
}

function edgeDirectionIcon(direction: EdgeDirection): IconName {
  if (direction === "backward") return "arrow-left";
  if (direction === "both") return "arrow-both";
  if (direction === "none") return "line";
  return "arrow-right";
}

function MenuActionButton({
  label,
  shortcut,
  disabled,
  danger = false,
  onClick,
}: {
  label: string;
  shortcut: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={classNames("graph-diagram-menu-item dt-mi", danger && "is-danger")}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}

function ColorControl({
  label,
  value,
  disabled,
  swatches,
  opacityLabel,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  swatches: string[];
  opacityLabel?: string;
  onChange: (value: string) => void;
}) {
  const opaqueValue = toOpaqueHex(value);
  const opacityPercent = colorOpacityPercent(value);
  const applyColor = (nextColor: string) => onChange(withColorOpacity(nextColor, opacityPercent));
  const applyOpacity = (nextPercent: number) => onChange(withColorOpacity(opaqueValue, nextPercent));
  return (
    <div className="graph-diagram-color-control" aria-label={label}>
      <div className="graph-diagram-color-control__row">
        <label className="graph-diagram-color-control__custom">
          <span>自定义</span>
          <input
            type="color"
            aria-label={label}
            value={opaqueValue}
            disabled={disabled}
            onChange={(event) => applyColor(event.currentTarget.value)}
          />
        </label>
        <div className="graph-diagram-swatch-group">
          {swatches.map((color) => (
            <button
              key={color}
              type="button"
              className="graph-diagram-swatch"
              style={{ background: withColorOpacity(color, opacityLabel ? opacityPercent : 100) }}
              disabled={disabled}
              aria-label={`${label} ${color}`}
              onClick={() => applyColor(color)}
            />
          ))}
        </div>
      </div>
      {opacityLabel ? (
        <NumberRangeControl
          label="不透明度"
          inputLabel={opacityLabel}
          disabled={disabled}
          value={opacityPercent}
          min={10}
          max={100}
          step={1}
          unit="%"
          onChange={applyOpacity}
        />
      ) : null}
    </div>
  );
}

function NumberRangeControl({
  label,
  inputLabel,
  disabled,
  value,
  min,
  max,
  step,
  unit = "px",
  onChange,
}: {
  label: string;
  inputLabel: string;
  disabled: boolean;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const normalizedValue = clampNumber(value, min, max);
  const commit = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(clampNumber(next, min, max));
  };
  return (
    <div className="graph-diagram-range-control" aria-label={label}>
      <div className="graph-diagram-range-control__header">
        <span>{label}</span>
        <label>
          <input
            type="number"
            aria-label={inputLabel}
            value={Number.isInteger(normalizedValue) ? normalizedValue : normalizedValue.toFixed(1)}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(event) => commit(event.currentTarget.value)}
          />
          <span>{unit}</span>
        </label>
      </div>
      <input
        type="range"
        aria-label={`${inputLabel}滑块`}
        value={normalizedValue}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => commit(event.currentTarget.value)}
      />
    </div>
  );
}

function useFitOnResize(active: boolean, onCanvasFrameChange?: (frame: CanvasFrame) => void) {
  const rfRef = useRef<ReactFlowInstance<GraphFlowNode, GraphFlowEdge> | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRef = useCallback((node: HTMLDivElement | null) => {
    setCanvasEl(node);
  }, []);
  const onInit = useCallback((inst: ReactFlowInstance<GraphFlowNode, GraphFlowEdge>) => {
    rfRef.current = inst;
    requestAnimationFrame(() => inst.fitView({ padding: 0.15, maxZoom: 1 }));
  }, []);
  const screenToFlowPosition = useCallback((point: { x: number; y: number }) => {
    return rfRef.current?.screenToFlowPosition(point) ?? null;
  }, []);
  const zoomIn = useCallback(() => {
    void rfRef.current?.zoomIn({ duration: 120 });
  }, []);
  const zoomOut = useCallback(() => {
    void rfRef.current?.zoomOut({ duration: 120 });
  }, []);

  useEffect(() => {
    if (!active || !canvasEl || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const update = () => {
      const rect = canvasEl.getBoundingClientRect();
      onCanvasFrameChange?.({ width: rect.width, height: rect.height, left: rect.left, top: rect.top });
      rfRef.current?.fitView({ padding: 0.15, maxZoom: 1 });
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    });
    ro.observe(canvasEl);
    update();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active, canvasEl, onCanvasFrameChange]);

  return { canvasRef, onInit, screenToFlowPosition, zoomIn, zoomOut };
}

function modelNodes(model: DiagramModel): BaseNode[] {
  if (model.type === "flowchart") return model.nodes;
  if (model.type === "state") return model.nodes;
  if (model.type === "er") return model.entities;
  if (model.type === "class") return model.classes;
  return flattenMindmap(model.root).map((node) => ({
    id: node.id,
    label: node.label,
    declared: true,
    hasStableId: node.hasStableId,
    scopePath: node.scopePath,
    sourceRefs: node.sourceRefs,
  }));
}

function modelEdges(model: DiagramModel): DiagramBaseEdge[] {
  if (model.type === "flowchart") return model.edges;
  if (model.type === "state") return model.edges;
  if (model.type === "er") return model.rels;
  if (model.type === "class") return model.rels;
  const nodes = flattenMindmap(model.root);
  const edges: DiagramBaseEdge[] = [];
  let order = 0;
  const nextEdgeId = createStableEdgeIdFactory("mind");
  for (const node of nodes) {
    for (const child of node.children) {
      const orderIndex = order++;
      edges.push({
        id: nextEdgeId({ source: node.id, target: child.id, syntaxKind: "tree" }),
        source: node.id,
        target: child.id,
        syntaxKind: "tree",
        orderIndex,
        scopePath: child.scopePath.slice(0, -1),
        rewritable: node.hasStableId && child.hasStableId,
        stmt: child.line,
      });
    }
  }
  return edges;
}

function flattenMindmap(root: MindNode): MindNode[] {
  const out: MindNode[] = [];
  const walk = (node: MindNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

type StableEdgeIdInput = { source: string; target: string; syntaxKind: string; label?: string };

function createStableEdgeIdFactory(prefix: string): (input: StableEdgeIdInput) => string {
  const seen = new Map<string, number>();
  return (input) => {
    const key = stableEdgeIdentityKey(input);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return `${prefix}-edge-${hashText(JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null, occurrence]))}`;
  };
}

function stableEdgeIdentityKey(input: StableEdgeIdInput): string {
  return JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null]);
}

function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function renderNodeLabel(node: BaseNode, model: DiagramModel): string {
  if (model.type === "er") {
    const entity = model.entities.find((item) => item.id === node.id);
    return entity?.attrs.length ? `${node.label}\n${entity.attrs.map((attr) => `${attr.type} ${attr.name}`).join("\n")}` : node.label;
  }
  if (model.type === "class") {
    const cls = model.classes.find((item) => item.id === node.id);
    return cls?.members.length ? `${node.label}\n${cls.members.map((member) => member.raw).join("\n")}` : node.label;
  }
  return displayGraphLabel(node.label);
}

function displayGraphLabel(label: string): string {
  return label.replace(/<br\s*\/?>/gi, "\n");
}

function getNodeShape(node: BaseNode): GraphNodeShape {
  const raw = getRawNodeShape(node);
  return normalizeGraphNodeShape(raw);
}

function getRawNodeShape(node: BaseNode): string | null {
  const value = (node as BaseNode & { shape?: unknown }).shape;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeGraphNodeShape(raw: string | null): GraphNodeShape {
  return normalizeFlowShapeName(raw);
}

function renderShapeSvg(shape: GraphNodeShape) {
  const geometry = getFlowShapeGeometry(shape);
  const shapeStyle = {
    fill: geometry.open ? "none" : "var(--graph-node-fill)",
    stroke: geometry.outlineVisible === false ? "none" : "var(--graph-node-stroke)",
    strokeWidth: "var(--graph-node-stroke-width)",
    strokeDasharray: "var(--graph-node-stroke-dasharray, none)",
    vectorEffect: "non-scaling-stroke",
  } satisfies CSSProperties;
  const lineStyle = {
    fill: "none",
    stroke: "var(--graph-node-stroke)",
    strokeWidth: "var(--graph-node-stroke-width)",
    vectorEffect: "non-scaling-stroke",
  } satisfies CSSProperties;
  const hoverRingStyle = {
    fill: "none",
    stroke: "#8f6d30",
    strokeWidth: 2.5,
    vectorEffect: "non-scaling-stroke",
  } satisfies CSSProperties;
  const selectionRingStyle = {
    fill: "none",
    stroke: "#8f6d30",
    strokeWidth: 3,
    vectorEffect: "non-scaling-stroke",
  } satisfies CSSProperties;

  return (
    <>
      <path className="graph-diagram-node-shape-fill" d={geometry.outlinePath} style={shapeStyle} />
      {geometry.detailPaths.map((path, index) => (
        <path key={`${shape}-detail-${index}`} className="graph-diagram-node-shape-detail" d={path} style={lineStyle} />
      ))}
      <path className="graph-diagram-node-selection-ring" d={geometry.outlinePath} style={selectionRingStyle} />
      <path className="graph-diagram-node-hover-ring" d={geometry.outlinePath} style={hoverRingStyle} />
    </>
  );
}

function getGraphDirection(model: DiagramModel): GraphDirection {
  if (model.type === "flowchart") return normalizeGraphDirection(model.direction);
  if (model.type === "mindmap") return "LR";
  return "TB";
}

function getEdgeDirection(edge: DiagramBaseEdge): EdgeDirection {
  if (edge.direction) return edge.direction;
  const syntax = edge.syntaxKind.trim();
  if (syntax.includes("<") && syntax.includes(">")) return "both";
  if (syntax.startsWith("<")) return "backward";
  if (syntax.endsWith(">")) return "forward";
  if (syntax.includes("-->")) return "forward";
  return "none";
}

function getEdgeLineStyle(edge: DiagramBaseEdge): EdgeLineStyle {
  if (edge.lineStyle) return edge.lineStyle;
  const syntax = edge.syntaxKind.trim();
  if (syntax.includes(".")) return "dotted";
  if (syntax.includes("=")) return "thick";
  return "solid";
}

function normalizeGraphDirection(direction: string | undefined): GraphDirection {
  const value = (direction ?? "").trim().toUpperCase().replace(/;$/, "");
  if (value === "TD" || value === "TB") return "TB";
  if (value === "BT") return "BT";
  if (value === "LR") return "LR";
  if (value === "RL") return "RL";
  return "TB";
}

function handleLabel(handleId: GraphHandleId): string {
  if (handleId === "t") return "上方";
  if (handleId === "r") return "右侧";
  if (handleId === "b") return "下方";
  return "左侧";
}

function normalizeGraphHandleId(handleId: string | null | undefined): GraphHandleId | null {
  return handleId === "t" || handleId === "r" || handleId === "b" || handleId === "l" ? handleId : null;
}

function oppositeHandle(handleId: GraphHandleId): GraphHandleId {
  if (handleId === "t") return "b";
  if (handleId === "b") return "t";
  if (handleId === "l") return "r";
  return "l";
}

function handlePosition(handleId: GraphHandleId): Position {
  if (handleId === "t") return Position.Top;
  if (handleId === "r") return Position.Right;
  if (handleId === "b") return Position.Bottom;
  return Position.Left;
}

function quickAddNodePosition(sourceNode: Node, handleId: GraphHandleId): { x: number; y: number } {
  const width = sourceNode.measured?.width ?? sourceNode.width ?? NODE_WIDTH;
  const height = sourceNode.measured?.height ?? sourceNode.height ?? NODE_HEIGHT;
  const gapX = width + 96;
  const gapY = height + 88;
  if (handleId === "r") return { x: Math.round(sourceNode.position.x + gapX), y: Math.round(sourceNode.position.y) };
  if (handleId === "l") return { x: Math.round(sourceNode.position.x - gapX), y: Math.round(sourceNode.position.y) };
  if (handleId === "b") return { x: Math.round(sourceNode.position.x), y: Math.round(sourceNode.position.y + gapY) };
  return { x: Math.round(sourceNode.position.x), y: Math.round(sourceNode.position.y - gapY) };
}

function findAddedEdgeId(oldSource: string, newSource: string, sourceId: string, targetId: string): string | null {
  const oldParsed = parseDiagram(oldSource);
  const newParsed = parseDiagram(newSource);
  if (!oldParsed.ok || !newParsed.ok) return null;
  const oldEdgeIds = new Set(modelEdges(oldParsed.model).map((edge) => edge.id));
  const candidates = modelEdges(newParsed.model).filter((edge) => edge.source === sourceId && edge.target === targetId && !oldEdgeIds.has(edge.id));
  return candidates.at(-1)?.id ?? null;
}

function findReconnectedEdgeId(oldSource: string, newSource: string, oldEdgeId: string, sourceId: string, targetId: string): string | null {
  const newParsed = parseDiagram(newSource);
  if (!newParsed.ok) return null;
  const sameId = modelEdges(newParsed.model).find((edge) => edge.id === oldEdgeId);
  if (sameId) return sameId.id;
  const oldParsed = parseDiagram(oldSource);
  const oldEdgeIds = oldParsed.ok ? new Set(modelEdges(oldParsed.model).map((edge) => edge.id)) : new Set<string>();
  return modelEdges(newParsed.model)
    .filter((edge) => edge.source === sourceId && edge.target === targetId && !oldEdgeIds.has(edge.id))
    .at(-1)?.id ?? null;
}

function graphEdgeRenderHandles(
  edge: DiagramBaseEdge,
  nodes: Map<string, GraphFlowNode>,
  fixedHandles: { sourceHandle?: string | null; targetHandle?: string | null } | undefined,
): { sourceHandle: GraphHandleId; targetHandle: GraphHandleId } {
  const fixedSource = normalizeGraphHandleId(fixedHandles?.sourceHandle);
  const fixedTarget = normalizeGraphHandleId(fixedHandles?.targetHandle);
  const sourceNode = nodes.get(edge.source);
  const targetNode = nodes.get(edge.target);
  if (!sourceNode || !targetNode) {
    return {
      sourceHandle: fixedSource ?? "b",
      targetHandle: fixedTarget ?? "t",
    };
  }
  const sourceRect = nodeRect(sourceNode);
  const targetRect = nodeRect(targetNode);
  if (fixedSource && fixedTarget) return { sourceHandle: fixedSource, targetHandle: fixedTarget };
  if (fixedSource) {
    return {
      sourceHandle: fixedSource,
      targetHandle: fixedTarget ?? boundaryHandleToward(targetRect, handlePoint(sourceRect, fixedSource)),
    };
  }
  if (fixedTarget) {
    return {
      sourceHandle: fixedSource ?? boundaryHandleToward(sourceRect, handlePoint(targetRect, fixedTarget)),
      targetHandle: fixedTarget,
    };
  }
  return {
    sourceHandle: boundaryHandleToward(sourceRect, rectCenter(targetRect)),
    targetHandle: boundaryHandleToward(targetRect, rectCenter(sourceRect)),
  };
}

function edgeDomAttributes(
  handles: { sourceHandle: GraphHandleId; targetHandle: GraphHandleId },
  floating: boolean,
): GraphFlowEdge["domAttributes"] {
  return {
    "data-source-handle": handles.sourceHandle,
    "data-target-handle": handles.targetHandle,
    "data-floating-edge": floating ? "true" : "false",
  } as unknown as GraphFlowEdge["domAttributes"];
}

function nodeRect(node: Node): { x: number; y: number; width: number; height: number } {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? NODE_HEIGHT,
  };
}

function rectCenter(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function handlePoint(rect: { x: number; y: number; width: number; height: number }, handleId: GraphHandleId): { x: number; y: number } {
  const center = rectCenter(rect);
  if (handleId === "t") return { x: center.x, y: rect.y };
  if (handleId === "r") return { x: rect.x + rect.width, y: center.y };
  if (handleId === "b") return { x: center.x, y: rect.y + rect.height };
  return { x: rect.x, y: center.y };
}

function boundaryHandleToward(rect: { x: number; y: number; width: number; height: number }, toward: { x: number; y: number }): GraphHandleId {
  const center = rectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return "b";
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  if (scaleX < scaleY) {
    return dx >= 0 ? "r" : "l";
  }
  return dy >= 0 ? "b" : "t";
}

function positionToHandle(position: Position): GraphHandleId {
  if (position === Position.Top) return "t";
  if (position === Position.Right) return "r";
  if (position === Position.Bottom) return "b";
  return "l";
}

function eventHasAlt(event: MouseEvent | TouchEvent): boolean {
  return "altKey" in event && event.altKey === true;
}

function eventHasShift(event: MouseEvent | TouchEvent): boolean {
  return "shiftKey" in event && event.shiftKey === true;
}

function constrainedShiftPositions(state: ShiftDragState, primaryNode: Node): Record<string, { x: number; y: number }> {
  const start = state.startPositions[primaryNode.id];
  if (!start) return {};
  const dx = primaryNode.position.x - start.x;
  const dy = primaryNode.position.y - start.y;
  const axis = state.axis ?? (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
  state.axis = axis;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, startPosition] of Object.entries(state.startPositions)) {
    out[id] = axis === "x"
      ? { x: Math.round(startPosition.x + dx), y: Math.round(startPosition.y) }
      : { x: Math.round(startPosition.x), y: Math.round(startPosition.y + dy) };
  }
  return out;
}

function copyableFlowShape(node: BaseNode): FlowNodeShape | null {
  const shape = getNodeShape(node);
  if (
    shape === "rect"
    || shape === "round"
    || shape === "stadium"
    || shape === "subroutine"
    || shape === "cylinder"
    || shape === "circle"
    || shape === "doublecircle"
    || shape === "asymmetric"
    || shape === "diamond"
    || shape === "hexagon"
    || shape === "parallelogram"
    || shape === "parallelogram-alt"
    || shape === "trapezoid"
    || shape === "trapezoid-alt"
  ) {
    return shape;
  }
  return null;
}

function findMindmapParentId(model: DiagramModel, nodeId: string): string | null {
  if (model.type !== "mindmap") return null;
  return flattenMindmap(model.root).find((node) => node.id === nodeId)?.parentId ?? null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function selectEditableContents(el: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isDescendantNode(candidate: BaseNode, ancestor: BaseNode): boolean {
  return candidate.scopePath.length > ancestor.scopePath.length && ancestor.scopePath.every((part, index) => candidate.scopePath[index] === part);
}

export function getFloatingPosition({
  selectedNodeId,
  selectedEdge,
  nodes,
  viewport,
  canvasFrame,
}: {
  selectedNodeId: string | null;
  selectedEdge: DiagramBaseEdge | undefined;
  nodes: Node[];
  viewport: Viewport;
  canvasFrame: CanvasFrame;
}): { left: number; top: number; placement: FloatingPlacement } | null {
  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : undefined;
  let flowX = 0;
  let flowY = 0;
  if (selectedNode) {
    flowX = selectedNode.position.x + ((selectedNode.measured?.width ?? NODE_WIDTH) / 2);
    flowY = selectedNode.position.y;
  } else if (selectedEdge) {
    const source = nodes.find((node) => node.id === selectedEdge.source);
    const target = nodes.find((node) => node.id === selectedEdge.target);
    if (!source || !target) return null;
    flowX = (source.position.x + target.position.x + NODE_WIDTH) / 2;
    flowY = (source.position.y + target.position.y + NODE_HEIGHT) / 2;
  } else {
    return null;
  }
  const screenX = canvasFrame.left + flowX * viewport.zoom + viewport.x;
  const screenY = canvasFrame.top + flowY * viewport.zoom + viewport.y;
  const width = canvasFrame.width || 900;
  const height = canvasFrame.height || 600;
  const leftMin = canvasFrame.left + 156;
  const leftMax = canvasFrame.left + Math.max(156, width - 156);
  const left = clamp(screenX, leftMin, leftMax);
  // 四向快速新增会在节点外侧铺一层幽灵节点；工具栏需越过这层操作区，
  // 否则顶部把手刚变成加号就会被工具栏截住。
  const handlePreviewClearance = selectedNode ? 116 : 14;
  const topAbove = screenY - handlePreviewClearance;
  // 选"above"时,工具栏在元素上方,其二级下拉(popover)还会再向上展开 ~一屏高度;
  // 只留工具栏自身高度(~70)会让靠顶部的下拉越出视口被裁切(实测 y 为负)。
  // 因此这里预留 工具栏 + 一个 popover 的headroom:不够就翻到"below"(下拉改向下展开、向下有充足空间)。
  const ABOVE_HEADROOM = 240;
  if (topAbove > canvasFrame.top + ABOVE_HEADROOM) return { left, top: topAbove, placement: "above" };
  const selectedHeight = selectedNode?.measured?.height
    ?? (typeof selectedNode?.style?.height === "number" ? selectedNode.style.height : NODE_HEIGHT);
  const belowY = selectedNode
    ? screenY + selectedHeight * viewport.zoom + handlePreviewClearance
    : screenY + 24;
  return { left, top: clamp(belowY, canvasFrame.top + 24, canvasFrame.top + Math.max(24, height - 72)), placement: "below" };
}

function capEnabled(caps: Capability[], op: EditOp["kind"]): boolean {
  return caps.find((cap) => cap.op === op)?.enabled === true;
}

function classNames(...items: Array<string | false | null | undefined>): string | undefined {
  const value = items.filter(Boolean).join(" ");
  return value || undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampNumber(value: number | undefined, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function toOpaqueHex(value: string): string {
  const normalized = normalizeHex(value);
  if (!normalized) return "#000000";
  return normalized.slice(0, 7);
}

function colorOpacityPercent(value: string): number {
  const normalized = normalizeHex(value);
  if (!normalized || normalized.length !== 9) return 100;
  return Math.round((parseInt(normalized.slice(7, 9), 16) / 255) * 100);
}

function withColorOpacity(color: string, opacityPercent: number): string {
  const normalized = normalizeHex(color) ?? "#000000";
  const opaque = normalized.slice(0, 7);
  const percent = clamp(Math.round(opacityPercent), 10, 100);
  if (percent >= 100) return opaque;
  const alpha = Math.round((percent / 100) * 255).toString(16).padStart(2, "0");
  return `${opaque}${alpha}`;
}

function normalizeHex(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const short = raw.match(/^#([0-9a-f]{3})([0-9a-f])?$/);
  if (short) {
    const rgb = short[1]!.split("").map((part) => `${part}${part}`).join("");
    const alpha = short[2] ? `${short[2]}${short[2]}` : "";
    return `#${rgb}${alpha}`;
  }
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(raw)) return raw;
  return null;
}

function remapSelectedId(id: string | null, idMap: Record<string, string> | undefined): string | null {
  return id ? idMap?.[id] ?? id : null;
}

function cleanOverlay(overlay: DiagramOverlay, nodeIds: Set<string>, edgeIds: Set<string>): DiagramOverlay {
  const positions = filterRecord(overlay.positions, nodeIds);
  const styles = filterRecord(overlay.styles, nodeIds);
  const edgeStyles = filterRecord(overlay.edgeStyles, edgeIds);
  const edgeHandles = filterRecord(overlay.edgeHandles, edgeIds);
  return {
    ...(positions ? { positions } : {}),
    ...(styles ? { styles } : {}),
    ...(edgeStyles ? { edgeStyles } : {}),
    ...(edgeHandles ? { edgeHandles } : {}),
  };
}

function filterRecord<T>(record: Record<string, T> | undefined, allowed: Set<string>): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isOverlayEmpty(overlay: DiagramOverlay): boolean {
  return !overlay.positions && !overlay.styles && !overlay.edgeStyles && !overlay.edgeHandles;
}

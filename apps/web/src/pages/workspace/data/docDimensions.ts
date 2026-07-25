import type { ContentDocState, EditorState } from "./protocol";
import type { WorkspaceState } from "./workspaceState";
import type { WireActiveOverlay } from "@qingagent/contract-ts";

export type ActiveOverlay = WireActiveOverlay;

export interface DocDimensions {
  content: ContentDocState;
  agentBusy: boolean;
  overlay: ActiveOverlay;
  editor: EditorState;
}

function deriveEditorState(
  content: ContentDocState,
  agentBusy: boolean,
  streamActive: boolean,
  overlay: ActiveOverlay,
): EditorState {
  // 锁定(用户决议:agent 生成时禁止用户编辑):agentBusy 已由 reducer 统一吸收后端投影、
  // 活跃 stream 与运行中工具。这里仍并联 streamActive 作为防御性约束，避免恢复/旧缓存
  // 形成不一致状态时放开编辑，浮层期间也一律只读。
  if (agentBusy || streamActive || overlay !== null) return "locked";
  if (content.kind === "empty") return "empty";
  if (content.kind === "pendingReview") return "pendingReview";
  return "editable";
}

export function deriveDocDimensions(state: WorkspaceState): DocDimensions {
  const overlay = state.activeOverlay;
  const agentBusy = state.agentBusy;

  return {
    content: state.docState,
    agentBusy,
    overlay,
    editor: deriveEditorState(state.docState, agentBusy, state.streamActive, overlay),
  };
}

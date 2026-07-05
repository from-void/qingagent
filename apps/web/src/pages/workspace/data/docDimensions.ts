import type { ContentDocState, EditorState } from "./protocol";
import type { WorkspaceState } from "./workspaceState";

export type ActiveOverlay = "askUser" | "imageProgress" | null;

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
  // 锁定(用户决议:agent 生成时禁止用户编辑):后端 agentBusy 投影 或 前端可靠的 streamActive
  // 任一为真即生成中,加上浮层期间,都置只读。streamActive 必须并联——P0 后 agentBusy 读后端投影态、
  // 生成进行中不保证为 true(见 WorkspacePage 辉光判据同款并联),只看 agentBusy 会漏掉
  // "streamActive 真但 agentBusy 假"的生成窗口,导致用户编辑与 agent 写竞态。
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

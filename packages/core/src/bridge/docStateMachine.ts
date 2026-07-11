import type {
  ContentDocState,
  ToolCallSpec,
  BridgeFrame,
} from "@qingagent/contract-ts";
import type { SessionState } from "./sessionState.js";
import { getActiveSuspensionOwner, hasActiveSuspension } from "./sessionState.js";
import { hasApplicableSuggestion, hasCanonicalDoc } from "./docFacts.js";
import { isQuestionnaireTool } from "./questionnaireTools.js";

export type ContentState = ContentDocState["kind"];
export type ActiveOverlay = "askUser" | "imageProgress" | null;
export type EditorState = "empty" | "editable" | "locked" | "pendingReview";

function iterToolCalls(state: SessionState): ToolCallSpec[] {
  const specs: ToolCallSpec[] = [];
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall") {
        specs.push(part.data);
      }
    }
  }
  return specs;
}

function hasToolCallWithStatus(
  state: SessionState,
  name: string,
  statuses: readonly ToolCallSpec["status"]["kind"][],
): boolean {
  return iterToolCalls(state).some(
    (spec) => spec.name === name && statuses.includes(spec.status.kind),
  );
}

export function deriveContentState(state: SessionState): ContentDocState {
  const stateHasDoc = hasCanonicalDoc(state);

  if (stateHasDoc && hasApplicableSuggestion(state)) {
    return { kind: "pendingReview" };
  }

  if (stateHasDoc) {
    return { kind: "editing" };
  }

  return { kind: "empty" };
}

export function deriveAgentBusy(state: SessionState): boolean {
  if (hasActiveSuspension(state)) {
    return false;
  }

  return state.streamId !== null;
}

export function deriveActiveOverlay(state: SessionState): ActiveOverlay {
  const owner = getActiveSuspensionOwner(state);
  // askUser overlay 两态都要:① 已 suspend 待答(owner);② 正在【流式产题】(running)——
  // 问卷选项边生成边展示需要它,与 imageProgress 按 running 派生一致。
  // 不含 pending(无活跃挂起的 pending=孤儿)→ 不引回 Bug B。
  if (
    (owner && isQuestionnaireTool(owner.toolName)) ||
    iterToolCalls(state).some(
      (spec) => isQuestionnaireTool(spec.name) && spec.status.kind === "running",
    )
  ) {
    return "askUser";
  }

  if (hasToolCallWithStatus(state, "generateSvg", ["running"])) {
    return "imageProgress";
  }

  return null;
}

export function deriveEditorState(
  content: ContentDocState | ContentState,
  agentBusy: boolean,
  overlay: ActiveOverlay,
): EditorState {
  if (agentBusy || overlay !== null) {
    return "locked";
  }

  const kind = typeof content === "string" ? content : content.kind;
  switch (kind) {
    case "empty":
      return "empty";
    case "pendingReview":
      return "pendingReview";
    case "editing":
      return "editable";
  }
}

export function coerceLegacyContentKind(kind: string): ContentDocState {
  switch (kind) {
    case "init":
    case "empty":
      return { kind: "empty" };
    case "plan":
    case "drafting":
    case "draft":
    case "locked":
    case "editing":
      return { kind: "editing" };
    case "review":
    case "pendingReview":
      return { kind: "pendingReview" };
    case "committed":
    case "history":
      return { kind: "editing" };
    default:
      return { kind: "empty" };
  }
}

export function* emitProjectedDocState(
  state: SessionState,
  _reason: string,
): Generator<BridgeFrame> {
  const stateForWire = deriveContentState(state);
  const activeOverlay = deriveActiveOverlay(state);
  const agentBusy = deriveAgentBusy(state);
  const projectionKey = `${stateForWire.kind}:${activeOverlay ?? "none"}:${agentBusy ? "busy" : "idle"}`;

  if (projectionKey === state._lastEmittedWireKind) {
    return;
  }

  state._lastEmittedWireKind = projectionKey;
  yield {
    kind: "docStateChanged",
    data: { state: stateForWire, activeOverlay, agentBusy },
  };
}

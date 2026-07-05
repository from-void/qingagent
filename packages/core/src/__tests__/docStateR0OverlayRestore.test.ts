import { describe, expect, it } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import { createSession, recordSuspension } from "../bridge/sessionState.js";
import type { SessionState } from "../bridge/sessionState.js";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
} from "../bridge/docStateMachine.js";
import { normalizeRestoredDocStateKind } from "../bridge/docStateTransitions.js";

function addToolCall(
  state: SessionState,
  name: string,
  status: ToolCallSpec["status"],
  id = `${name}-${status.kind}`,
): void {
  const body: ToolCallSpec["body"] = name === "askUser"
    ? {
        kind: "askUser",
        data: {
          id: `ask-${id}`,
          mode: { kind: "overlay" },
          purpose: { kind: "quickClarification" },
          source: null,
          rationale: null,
          questions: [
            {
              id: "q-1",
              label: "补充方向?",
              kind: { kind: "text" },
              options: [],
              placeholder: null,
            },
          ],
        },
      }
    : { kind: "generic", data: { argsJson: "{}" } };
  state.chatHistory.push({
    id: `msg-${name}-${status.kind}`,
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id,
          name,
          render: { kind: "chatInline" },
          status,
          body,
          result: null,
        },
      },
    ],
  });
}

function addEmptyPendingAskUser(state: SessionState, id = "ask-empty"): void {
  state.chatHistory.push({
    id: `msg-${id}`,
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id,
          name: "askUser",
          render: { kind: "rightForm" },
          status: { kind: "pending" },
          body: {
            kind: "askUser",
            data: {
              id: `ask-${id}`,
              mode: { kind: "overlay" },
              purpose: { kind: "quickClarification" },
              source: null,
              rationale: null,
              questions: [],
            },
          },
          result: null,
        },
      },
    ],
  });
}

function recordToolSuspension(
  state: SessionState,
  toolName: "askUser",
  toolCallId: string,
): void {
  recordSuspension(state, {
    streamId: "stream-1",
    runId: `run-${toolCallId}`,
    toolCallId,
    toolName,
  });
}

function running(): ToolCallSpec["status"] {
  return { kind: "running", data: { progressPct: null, etaSec: null } };
}

function dimensionsFor(setup: (state: SessionState) => void) {
  const state = createSession("overlay-r0");
  setup(state);
  return {
    agentBusy: deriveAgentBusy(state),
    overlay: deriveActiveOverlay(state),
  };
}

describe("R0 overlay lifecycle and cold restore red tests", () => {
  it("OL-1..OL-10 couple overlays to non-terminal toolCalls and clear them on terminal statuses", () => {
    const failed: ToolCallSpec["status"] = {
      kind: "failed",
      data: { reason: "R0 terminalized", retriable: false },
    };
    const actual = {
      "OL-1 askUser pending": dimensionsFor((s) =>
        {
          addToolCall(s, "askUser", { kind: "pending" }, "ask-1");
          recordToolSuspension(s, "askUser", "ask-1");
        },
      ).overlay,
      "OL-2 writeDraft pending": dimensionsFor((s) =>
        addToolCall(s, "writeDraft", { kind: "pending" }, "write-draft-pending"),
      ).overlay,
      "OL-3 writeDraft running": dimensionsFor((s) =>
        {
          s.streamId = "stream-doc";
          addToolCall(s, "writeDraft", running());
        },
      ).agentBusy,
      "OL-6 writeDraft success": dimensionsFor((s) =>
        addToolCall(s, "writeDraft", { kind: "done" }),
      ).agentBusy,
      "OL-7 writeDraft failure": dimensionsFor((s) =>
        addToolCall(s, "writeDraft", failed),
      ).agentBusy,
      "OL-8 generateSvg running overlay": dimensionsFor((s) =>
        addToolCall(s, "generateSvg", running()),
      ).overlay,
      "OL-8 generateSvg running busy": dimensionsFor((s) =>
        {
          s.streamId = "stream-image";
          addToolCall(s, "generateSvg", running());
        },
      ).agentBusy,
      "OL-9 finally terminalizes stale running": dimensionsFor((s) =>
        addToolCall(s, "generateSvg", failed),
      ).overlay,
      "OL-10 askUser terminal": dimensionsFor((s) =>
        addToolCall(s, "askUser", failed),
      ).overlay,
      "OL-10 writeDraft terminal": dimensionsFor((s) =>
        addToolCall(s, "writeDraft", failed),
      ).overlay,
    };

    expect(actual).toEqual({
      "OL-1 askUser pending": "askUser",
      "OL-2 writeDraft pending": null,
      "OL-3 writeDraft running": true,
      "OL-6 writeDraft success": false,
      "OL-7 writeDraft failure": false,
      "OL-8 generateSvg running overlay": "imageProgress",
      "OL-8 generateSvg running busy": true,
      "OL-9 finally terminalizes stale running": null,
      "OL-10 askUser terminal": null,
      "OL-10 writeDraft terminal": null,
    });
  });

  it("derives askUser overlay from an ACTIVE empty-questions askUser owner (skeleton loading)", () => {
    // 活跃挂起(owner.runId 与 state.runId 匹配)但 questions 暂空(挂起瞬间问卷尚未回写/
    // 流式中断)→ 必须仍派生 overlay="askUser",让前端渲染骨架 loading 卡;否则刷新后活跃
    // 反问卡会凭空消失(回归)。活跃 vs 旧残留靠 runId 匹配区分,而非靠 questions 是否为空。
    const state = createSession("overlay-empty-askuser");
    addEmptyPendingAskUser(state, "ask-empty");
    recordToolSuspension(state, "askUser", "ask-empty");

    expect({
      overlay: deriveActiveOverlay(state),
      agentBusy: deriveAgentBusy(state),
    }).toEqual({
      overlay: "askUser",
      agentBusy: false,
    });
  });

  it("does NOT derive askUser overlay from an ORPHAN empty askUser (runId mismatch = 旧会话残留)", () => {
    // 旧会话残留:tool-call 还在 chatHistory 里 pending,但 suspension owner 的 runId 与
    // 当前 state.runId 不匹配(孤儿)→ 不是活跃挂起 → 不得重开浮层(Bug B 防回归)。
    const state = createSession("overlay-orphan-askuser");
    addEmptyPendingAskUser(state, "ask-orphan");
    recordSuspension(state, {
      streamId: "stream-stale",
      runId: "run-ask-orphan",
      toolCallId: "ask-orphan",
      toolName: "askUser",
    });
    // 模拟新一轮:state.runId 漂移到别的 run,owner 变孤儿。
    state.runId = "run-new-turn";

    expect({
      overlay: deriveActiveOverlay(state),
      agentBusy: deriveAgentBusy(state),
    }).toEqual({
      overlay: null,
      agentBusy: false,
    });
  });

  it("RT-1 normalizes stale askUser on cold restore", () => {
    const actual = {
      "RT-1 stale askUser with doc": normalizeRestoredDocStateKind({
        persistedKind: "plan",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: true,
        hasRestorableSuspension: false,
      }),
    };

    expect(actual).toEqual({
      "RT-1 stale askUser with doc": "editing",
    });
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import { pmDocFromText } from "./pmTestUtils.js";
import { createSession } from "../session/sessionState.js";
import type { SessionState } from "../session/sessionState.js";
import { emitProjectedDocState } from "../doc-engine/docStateMachine.js";
import { transitionDocState } from "../doc-engine/docStateTransitions.js";

function seedDoc(state: SessionState): void {
  state.doc = pmDocFromText("正文");
  state.docState = { kind: "editing" };
}

function addSuggestion(state: SessionState, id = "p1"): void {
  state.doc ??= pmDocFromText("正文");
  state.suggestions.set(id, {
    messageId: "m",
    toolCallId: id,
    before: "正",
    after: "新",
    blockIndex: 0,
    suggestion: {
      id,
      docId: state.docId,
      baseVersion: state.docVersion,
      baseSchemaVersion: state.doc.attrs.schemaVersion,
      status: "reviewing",
      anchor: {
        blockId: state.doc.content[0]?.attrs.blockId ?? "block-review",
        pmFrom: 1,
        pmTo: 2,
        quote: "正",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "正", insertText: "新" },
      summary: "改",
    },
  });
}

function upsertToolCall(
  state: SessionState,
  name: string,
  status: ToolCallSpec["status"],
): void {
  const spec: ToolCallSpec = {
    id: `${name}-1`,
    name,
    render: { kind: "chatInline" },
    status,
    body: { kind: "generic", data: { argsJson: "{}" } },
    result: null,
  };
  state.chatHistory = [{
    id: `msg-${name}`,
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [{ kind: "toolCall", data: spec }],
  }];
}

function stateKinds(frames: BridgeFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "docStateChanged" ? [frame.data.state.kind] : [],
  );
}

function projectedKind(setup: (state: SessionState) => void): string[] {
  const state = createSession("projection");
  seedDoc(state);
  setup(state);
  return stateKinds(Array.from(emitProjectedDocState(state, "modern-test")));
}

describe("modern wire projection", () => {
  it("emits only the PM content-state model", () => {
    expect(stateKinds(Array.from(emitProjectedDocState(
      createSession("empty"),
      "initial",
    )))).toEqual(["empty"]);

    expect(projectedKind((s) =>
      upsertToolCall(s, "askUser", { kind: "pending" }),
    )).toEqual(["editing"]);
    expect(projectedKind((s) => {
      s.streamId = "stream-1";
      upsertToolCall(s, "generateDoc", {
        kind: "running",
        data: { progressPct: null, etaSec: null },
      });
    })).toEqual(["editing"]);
    expect(projectedKind((s) => addSuggestion(s))).toEqual(["pendingReview"]);
  });

  it("deduplicates repeated wire states", () => {
    const state = createSession("dedupe");
    seedDoc(state);

    expect(stateKinds(Array.from(emitProjectedDocState(state, "first")))).toEqual(["editing"]);
    expect(stateKinds(Array.from(emitProjectedDocState(state, "same")))).toEqual([]);
    addSuggestion(state);
    expect(stateKinds(Array.from(emitProjectedDocState(state, "review")))).toEqual(["pendingReview"]);
  });

  it("外部租约活跃、过期与结束都会进入投影键并按变化发帧", () => {
    const state = createSession("external-editing-projection");
    seedDoc(state);
    const lease = {
      turnId: "turn-external",
      principalId: "external:plugin",
      expiresAt: Date.now() + 60_000,
      startedFromEmpty: false,
      directCommitCount: 0,
    };

    state.externalBusyLease = lease;
    const active = Array.from(emitProjectedDocState(state, "lease-active"));
    expect(active).toEqual([
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: true,
          externalEditing: true,
        },
      },
    ]);
    expect(state._lastEmittedWireKind).toContain(":external");
    expect(Array.from(emitProjectedDocState(state, "lease-still-active"))).toEqual([]);

    state.externalBusyLease = { ...lease, expiresAt: Date.now() - 1 };
    const expired = Array.from(emitProjectedDocState(state, "lease-expired"));
    expect(expired[0]?.kind === "docStateChanged" && expired[0].data.externalEditing).toBe(false);
    expect(state._lastEmittedWireKind).toContain(":native");

    state.externalBusyLease = lease;
    expect(Array.from(emitProjectedDocState(state, "lease-renewed"))).toHaveLength(1);
    state.externalBusyLease = null;
    const ended = Array.from(emitProjectedDocState(state, "lease-ended"));
    expect(ended[0]?.kind === "docStateChanged" && ended[0].data.externalEditing).toBe(false);
    expect(state._lastEmittedWireKind).toContain(":native");
  });

  it("EC-15 requires transitionDocState to stop emitting frames directly", () => {
    const result = transitionDocState(
      createSession("ec-15"),
      { kind: "empty" },
      "draft_candidate_committed",
      { mode: "normalize" },
    );
    const source = readFileSync(
      new URL("../doc-engine/docStateTransitions.ts", import.meta.url),
      "utf8",
    );

    expect({
      transitionChanged: result.changed,
      directDocStateChangedCount: (source.match(/kind:\s*"docStateChanged"/g) ?? []).length,
    }).toEqual({
      transitionChanged: false,
      directDocStateChangedCount: 0,
    });
  });
});

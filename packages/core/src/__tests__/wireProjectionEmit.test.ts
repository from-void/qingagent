import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { createSession } from "../session/sessionState.js";
import type { SessionState } from "../session/sessionState.js";
import { emitProjectedDocState } from "../doc-engine/docStateMachine.js";
import { transitionDocState } from "../doc-engine/docStateTransitions.js";

function seedDoc(state: SessionState): void {
  state.legacySections = [{ kind: "p", data: { text: "正文" } }];
  state.doc = legacySectionsToPm(state.legacySections as never);
  state.docState = { kind: "editing" };
}

function addSuggestion(state: SessionState, id = "p1"): void {
  state.doc ??= legacySectionsToPm(state.legacySections as never);
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

import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { describe, expect, it, vi } from "vitest";
import {
  advanceNativeConcurrentState,
  buildNativeDiffInstructions,
  createNativeConcurrentState,
  type NativeConcurrentStep,
  type NativePresentationRun,
} from "../../../data/nativeDiffAnimation";
import { laneColor } from "../../../data/humanCursorLanes";
import {
  applyNativeConcurrentFrame,
  applyNativeConcurrentSteps,
  nativePresentationDecorationKey,
  NativePresentationDecorations,
  setNativePresentationDecorations,
  type NativeCursorMarker,
  type NativeEditorOperationRuntime,
} from "../../../data/nativePresentationPm";
import { splitGraphemes } from "../../../data/presentationSpans";
import type { ViewBlock } from "../../../data/protocol";

interface FrameHarness {
  oldEditor: Editor;
  newEditor: Editor;
  oldRuntime: NativeEditorOperationRuntime;
  newRuntime: NativeEditorOperationRuntime;
  oldDispatch: ReturnType<typeof vi.spyOn>;
  newDispatch: ReturnType<typeof vi.spyOn>;
}

type SerializedDecoration =
  | {
      kind: "widget";
      from: number;
      to: number;
      className: string;
      lane: string | null;
      name: string | null;
      color: string | null;
      cursorColor: string;
    }
  | {
      kind: "inline";
      from: number;
      to: number;
      className: string;
    };

function p(text: string): ViewBlock {
  return { kind: "p", spans: [{ kind: "text", text }] };
}

function createEditor(content: string): Editor {
  return new Editor({
    extensions: [...createQingagentExtensions(), NativePresentationDecorations],
    content,
  });
}

function createRuntime(): NativeEditorOperationRuntime {
  return {
    offsets: new Map(),
    operationOffsets: new Map(),
    charEnters: [],
  };
}

function createHarness(seedHtml: string): FrameHarness {
  const oldEditor = createEditor(seedHtml);
  const newEditor = createEditor(seedHtml);
  return {
    oldEditor,
    newEditor,
    oldRuntime: createRuntime(),
    newRuntime: createRuntime(),
    oldDispatch: vi.spyOn(oldEditor.view, "dispatch"),
    newDispatch: vi.spyOn(newEditor.view, "dispatch"),
  };
}

function destroyHarness(harness: FrameHarness): void {
  harness.oldDispatch.mockRestore();
  harness.newDispatch.mockRestore();
  harness.oldEditor.destroy();
  harness.newEditor.destroy();
}

function serializeMarkers(markers: readonly NativeCursorMarker[]) {
  return markers.map((marker) => ({ ...marker }));
}

function serializeDecorations(editor: Editor): SerializedDecoration[] {
  const set = nativePresentationDecorationKey.getState(editor.state);
  const decorations = set?.find() ?? [];
  const widgets = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>(".native-presentation-cursor"),
  );
  let widgetIndex = 0;

  return decorations.map((decoration) => {
    if (decoration.from === decoration.to) {
      const el = widgets[widgetIndex++];
      return {
        kind: "widget",
        from: decoration.from,
        to: decoration.to,
        className: el?.className ?? "",
        lane: el?.getAttribute("data-hc-lane") ?? null,
        name: el?.getAttribute("data-hc-name") ?? null,
        color: el?.getAttribute("data-hc-color") ?? null,
        cursorColor: el?.style.getPropertyValue("--native-cursor-color") ?? "",
      };
    }

    const raw = decoration as unknown as {
      type?: { attrs?: { class?: string } };
    };
    return {
      kind: "inline",
      from: decoration.from,
      to: decoration.to,
      className: raw.type?.attrs?.class ?? "",
    };
  });
}

function snapshot(editor: Editor, markers: readonly NativeCursorMarker[]) {
  return {
    doc: editor.state.doc.toJSON(),
    selection: {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    },
    decorations: serializeDecorations(editor),
    markers: serializeMarkers(markers),
  };
}

function applyTapeFrame(
  harness: FrameHarness,
  label: string,
  steps: readonly NativeConcurrentStep[],
): { oldDispatchCount: number; newDispatchCount: number } {
  harness.oldRuntime.charEnters.length = 0;
  harness.oldDispatch.mockClear();
  const oldMarkers = applyNativeConcurrentSteps(
    harness.oldEditor,
    steps,
    harness.oldRuntime,
  );
  setNativePresentationDecorations(
    harness.oldEditor,
    oldMarkers,
    harness.oldRuntime.charEnters,
  );
  const oldDispatchCount = harness.oldDispatch.mock.calls.length;

  harness.newRuntime.charEnters.length = 0;
  harness.newDispatch.mockClear();
  const newMarkers = applyNativeConcurrentFrame(
    harness.newEditor,
    steps,
    harness.newRuntime,
  );
  const newDispatchCount = harness.newDispatch.mock.calls.length;

  expect(snapshot(harness.newEditor, newMarkers), label).toEqual(
    snapshot(harness.oldEditor, oldMarkers),
  );
  expect(newDispatchCount, `${label} dispatch`).toBeLessThanOrEqual(1);
  return { oldDispatchCount, newDispatchCount };
}

function baseStep(
  key: string,
  blockIndex: number,
  agent = 1,
): Pick<
  NativeConcurrentStep,
  | "agentId"
  | "assignmentId"
  | "label"
  | "color"
  | "taskId"
  | "operationIndex"
  | "operationKey"
  | "blockIndex"
> {
  return {
    agentId: `agent-${agent}`,
    assignmentId: agent,
    label: `Agent·${agent}`,
    color: laneColor(agent),
    taskId: `task-${key}`,
    operationIndex: 0,
    operationKey: key,
    blockIndex,
  };
}

function cursorStep(key: string, blockIndex: number, at: number): NativeConcurrentStep {
  return {
    ...baseStep(key, blockIndex),
    kind: "cursor",
    at,
    tone: "blue",
    operationLength: 0,
    operationComplete: true,
  };
}

function redDotStep(key: string, blockIndex: number, at: number): NativeConcurrentStep {
  return {
    ...baseStep(key, blockIndex),
    kind: "redDot",
    at,
    operationLength: 0,
    operationComplete: true,
  };
}

function insertStep(
  key: string,
  blockIndex: number,
  at: number,
  text: string,
  agent = 1,
): NativeConcurrentStep {
  const length = splitGraphemes(text).length;
  return {
    ...baseStep(key, blockIndex, agent),
    kind: "insertText",
    at,
    chunkFrom: 0,
    chunkTo: length,
    text,
    operationLength: length,
    operationComplete: true,
  };
}

function deleteStep(
  key: string,
  blockIndex: number,
  chunkFrom: number,
  chunkTo: number,
  operationLength: number,
  agent = 1,
): NativeConcurrentStep {
  return {
    ...baseStep(key, blockIndex, agent),
    kind: "deleteText",
    chunkFrom,
    chunkTo,
    operationLength,
    operationComplete: true,
  };
}

describe("nativePresentationFrameTape", () => {
  it("探针:chain 内 commands 共享 tr 且整条 chain 只 dispatch 一次", () => {
    const editor = createEditor("<p></p>");
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const seen: string[] = [];

    try {
      const ok = editor
        .chain()
        .command(({ commands }) => {
          commands.setTextSelection(1);
          return commands.insertContentAt(1, "a < b & c");
        })
        .command(({ tr, commands }) => {
          seen.push(tr.doc.textContent);
          const pos = Math.max(1, tr.doc.content.size - 1);
          commands.setTextSelection(pos);
          return commands.insertContentAt(pos, " Z");
        })
        .run();

      expect(ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["a < b & c"]);
      expect(editor.state.doc.textContent).toBe("a < b & c Z");
    } finally {
      dispatch.mockRestore();
      editor.destroy();
    }
  });

  it("手工帧 tape:cursor/redDot/delete/insert/mixed/跨块/CJK-emoji/HTML-special 逐帧等价", () => {
    const harness = createHarness(
      "<h1></h1><p>删掉ABC</p><p></p><p>Alpha Beta</p><p></p>",
    );
    const counts: Array<{ oldDispatchCount: number; newDispatchCount: number }> = [];

    try {
      counts.push(applyTapeFrame(harness, "cursor-only", [
        cursorStep("manual-cursor", 2, 0),
      ]));
      counts.push(applyTapeFrame(harness, "redDot-only", [
        redDotStep("manual-red-dot", 1, 0),
      ]));
      counts.push(applyTapeFrame(harness, "pure insert + HTML-special", [
        insertStep("manual-html", 2, 0, "a < b & c"),
      ]));
      counts.push(applyTapeFrame(harness, "cross-block + CJK-emoji", [
        insertStep("manual-title", 0, 0, "标题", 1),
        insertStep("manual-cjk-emoji", 4, 0, "中😀文", 2),
      ]));
      counts.push(applyTapeFrame(harness, "pure delete", [
        deleteStep("manual-delete", 1, 2, 5, 3),
      ]));
      counts.push(applyTapeFrame(harness, "insert+delete same frame", [
        deleteStep("manual-mixed-delete", 3, 6, 10, 4, 1),
        insertStep("manual-mixed-insert", 3, 10, "Gamma", 2),
      ]));

      expect(counts.some((count) => count.oldDispatchCount > 1)).toBe(true);
      expect(counts.every((count) => count.newDispatchCount <= 1)).toBe(true);
    } finally {
      destroyHarness(harness);
    }
  });

  it("状态机帧 tape:多 agent 并发 insert 帧逐帧等价", () => {
    const finalSections: ViewBlock[] = [
      { kind: "h1", text: "标题" },
      p("a < b & c <strong>字面</strong>"),
      p("第二段中😀文"),
    ];
    const run: NativePresentationRun = {
      id: 44,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    let scheduler = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 3,
      stepDelayMs: 1,
      chunkSize: 2,
      maxDurationMs: 10000,
      startJitter: false,
    });
    const harness = createHarness("<h1></h1><p></p><p></p>");
    const counts: Array<{ oldDispatchCount: number; newDispatchCount: number }> = [];
    const covered = new Set<string>();

    try {
      for (let frame = 0; frame < 200 && scheduler.phase !== "done"; frame += 1) {
        const advanced = advanceNativeConcurrentState(scheduler, scheduler.stepDelayMs);
        scheduler = advanced.state;
        if (advanced.steps.length === 0) continue;
        if (advanced.steps.every((step) => step.kind === "insertText")) {
          covered.add("pure insert");
        }
        if (new Set(advanced.steps.map((step) => step.blockIndex)).size > 1) {
          covered.add("cross-block");
        }
        if (
          advanced.steps.some(
            (step) => step.kind === "insertText" && /[<>&]/.test(step.text),
          )
        ) {
          covered.add("HTML-special");
        }
        if (
          advanced.steps.some(
            (step) => step.kind === "insertText" && /[\u4e00-\u9fff😀]/u.test(step.text),
          )
        ) {
          covered.add("CJK-emoji");
        }
        counts.push(applyTapeFrame(harness, `state-frame-${frame}`, advanced.steps));
      }

      expect(scheduler.phase).toBe("done");
      expect(covered).toEqual(
        new Set(["pure insert", "cross-block", "HTML-special", "CJK-emoji"]),
      );
      expect(counts.length).toBeGreaterThan(0);
      expect(counts.some((count) => count.oldDispatchCount > 1)).toBe(true);
      expect(counts.every((count) => count.newDispatchCount <= 1)).toBe(true);
    } finally {
      destroyHarness(harness);
    }
  });

  // F3 回归:光标 widget 的 data-hc-name 必须落成 lane→百家姓映射(小赵/小钱…),
  // 绝不能直出原始 agent 标签(agent1/agent2),否则会盖掉 overlay 的百家姓名。
  it("光标 data-hc-name 走 laneName(小赵/小钱),不直出 agent 原始 label", () => {
    const editor = createEditor("<p>甲乙丙</p>");
    try {
      const markers: NativeCursorMarker[] = [
        { pos: 1, tone: "blue", label: "agent1", color: laneColor(1) },
        { pos: 2, tone: "blue", label: "agent2", color: laneColor(2) },
      ];
      setNativePresentationDecorations(editor, markers);
      const widgets = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>(".native-presentation-cursor"),
      );
      const names = widgets.map((el) => el.getAttribute("data-hc-name"));
      const lanes = widgets.map((el) => el.getAttribute("data-hc-lane"));
      expect(lanes).toEqual(["1", "2"]);
      expect(names).toEqual(["小赵", "小钱"]);
      expect(names).not.toContain("agent1");
      expect(names).not.toContain("agent2");
    } finally {
      editor.destroy();
    }
  });
});

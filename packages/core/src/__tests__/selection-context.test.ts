import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../bridge/sessionState.js";
import type { BridgeFrame } from "@qingagent/contract-ts";

const agentStreamCalls: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(async (messages: unknown[], options: Record<string, unknown>) => {
      agentStreamCalls.push({ messages, options });
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta" as const,
            payload: { text: "收到。" },
          };
        })(),
        toolCalls: Promise.resolve([]),
      };
    }),
  },
}));

describe("selection chip edit context", () => {
  beforeEach(() => {
    agentStreamCalls.length = 0;
  });

  it("sends exact selected document text as AI-IR edit guidance", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const state = createSession("sess-selection-ctx");
    state.legacySections = [
      { kind: "h1", data: { text: "春天的校园" } },
      { kind: "p", data: { text: "三月的阳光透过教学楼的玻璃窗，洒在走廊的地砖上。" } },
    ];
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    const selected = "三月的阳光";
    await collectFrames(
      runAgentTurn(
        state,
        "把它改得更温暖一点",
        [],
        [
          {
            kind: { kind: "selection" },
            resourceRef: null,
            prefix: null,
            label: "AI 修改",
            suffix: null,
            from: 9,
            to: 9 + selected.length,
          },
        ],
      ),
    );

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;
    expect(content).toContain("【用户选中的文档片段】");
    expect(content).toContain(selected);
    expect(content).toContain(`readDraft(query: ${JSON.stringify(selected)})`);
    expect(content).toContain('action:"replaceText"');
    expect(content).toContain('action:"markText"');
    expect(content).toContain("withinRef");
    expect(content).not.toContain("AI 修改");

    expect(agentStreamCalls).toHaveLength(1);
    expect(agentStreamCalls[0]!.options.toolChoice).toBeUndefined();
  });
});

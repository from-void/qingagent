import type { ScorerRunInputForAgent, ScorerRunOutputForAgent } from "@mastra/core/evals";
import { describe, expect, it } from "vitest";
import { askUserLiveWriteDraftFollowthroughScorer } from "../evals/askUserScorers.js";
import { validateEditDraftStructOutput } from "../evals/editDraftStructScorers.js";

function agentInput(text: string): ScorerRunInputForAgent {
  return {
    inputMessages: [
      {
        id: "user-1",
        role: "user",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        content: { format: 2, parts: [{ type: "text", text }] },
      },
    ],
    rememberedMessages: [],
    systemMessages: [],
    taggedSystemMessages: {},
  };
}

function agentTextOutput(text: string): ScorerRunOutputForAgent {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      content: { format: 2, parts: [{ type: "text", text }] },
    },
  ];
}

function agentWriteDraftOutput(): ScorerRunOutputForAgent {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      content: {
        format: 2,
        parts: [{ type: "text", text: "收到。" }],
        metadata: { toolName: "writeDraft" },
      },
    },
  ];
}

describe("D8 deterministic scorers", () => {
  it("editDraft struct scorer rejects QingML bad-block fragments", () => {
    const result = validateEditDraftStructOutput({
      scenarioKey: "insert-table",
      raw: JSON.stringify({
        ops: [
          {
            action: "insertBlock",
            position: "after",
            ref: "para-compare",
            blocks: "<table><tr><th><p>维度</p></th><th>V2.6</th><th>V2.7</th></tr></table>",
          },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.note).toContain("QingML bad-block");
  });

  it("editDraft struct scorer does not count two-level lists as three-level nesting", () => {
    const result = validateEditDraftStructOutput({
      scenarioKey: "nested-3level",
      raw: JSON.stringify({
        ops: [
          {
            action: "replaceBlock",
            ref: "para-terms",
            block: "<ul><li>第一章<ul><li>第一条</li></ul></li></ul>",
          },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.note).toBe("深度<3");
  });

  it("editDraft struct scorer accepts QingML callout fragments", () => {
    const result = validateEditDraftStructOutput({
      scenarioKey: "insert-callout",
      raw: JSON.stringify({
        ops: [
          {
            action: "insertBlock",
            position: "after",
            ref: "para-risk",
            blocks: "<callout tone=\"warning\">上线前确认回滚预案。</callout>",
          },
        ],
      }),
    });

    expect(result.ok).toBe(true);
  });

  it("live askUser follow-through scorer rejects agent output without writeDraft", async () => {
    const result = await askUserLiveWriteDraftFollowthroughScorer.run({
      runId: "live-missing-writeDraft",
      input: agentInput("帮我写一篇发布稿"),
      output: agentTextOutput("好的,我开始写。"),
      groundTruth: {
        toolCallId: "ask-1",
        request: "帮我写一篇发布稿",
        answers: { topic: { freeText: "D8 scorer" } },
      },
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain("未调用 writeDraft");
  });

  it("live askUser follow-through scorer accepts writeDraft tool calls", async () => {
    const result = await askUserLiveWriteDraftFollowthroughScorer.run({
      runId: "live-with-writeDraft",
      input: agentInput("帮我写一篇发布稿"),
      output: agentWriteDraftOutput(),
      groundTruth: {
        toolCallId: "ask-1",
        request: "帮我写一篇发布稿",
        answers: { topic: { freeText: "D8 scorer" } },
      },
    });

    expect(result.score).toBe(1);
  });
});

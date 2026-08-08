import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../session/sessionState.js";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";

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

  it("activeDocument 只追加到本次模型输入，不污染持久历史与可见用户气泡", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("sess-derivative-turn-context");

    await collectFrames(
      runAgentTurn(
        state,
        "把标题改得更抓人",
        [],
        [],
        [],
        null,
        undefined,
        undefined,
        undefined,
        {
          activeDocument: {
            kind: "derivative",
            docId: "derivative-xhs-1",
          },
          turnKind: "generateDerivative",
        },
      ),
    );

    const modelUserMessage = state.messages.find((message) => message.role === "user");
    expect(modelUserMessage?.content).toContain("把标题改得更抓人");
    expect(modelUserMessage?.content).not.toContain("当前文档目标");
    const streamedMessages = agentStreamCalls[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(streamedMessages.at(-1)?.content).toContain(
      "本轮发送时界面激活的是衍生稿(doc_id: derivative-xhs-1)",
    );
    const visibleUserMessage = state.chatHistory.find(
      (message) => message.role.kind === "user",
    );
    expect(visibleUserMessage?.parts).toEqual([
      { kind: "text", data: { body: "把标题改得更抓人" } },
    ]);
    const requestContext = agentStreamCalls[0]?.options.requestContext as {
      get: (key: string) => unknown;
    };
    expect(requestContext.get("usageCallSite")).toBe("generateDerivative");
    expect(requestContext.get("activeDerivativeDocId")).toBeNull();
    expect(agentStreamCalls[0]?.options.tracingOptions).toMatchObject({
      metadata: { site: "generateDerivative" },
    });
  });

  it("普通追问把当前日语译稿绑定到工具 RequestContext", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("sess-japanese-translation-followup");

    await collectFrames(
      runAgentTurn(
        state,
        "语气更正式一点",
        [],
        [],
        [],
        null,
        undefined,
        undefined,
        undefined,
        {
          activeDocument: {
            kind: "derivative",
            docId: "translation-ja-only",
          },
        },
      ),
    );

    const requestContext = agentStreamCalls.at(-1)?.options.requestContext as {
      get: (key: string) => unknown;
    };
    expect(requestContext.get("activeDerivativeDocId"))
      .toBe("translation-ja-only");
  });

  it("同 session 历史含衍生稿标记时，主稿目标在当前轮尾部明确复位", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("sess-main-after-derivative");
    state.messages.push({
      role: "user",
      content:
        "旧轮请求\n\n[系统:用户当前正查看衍生稿(doc_id: stale-derivative,类型=公众号稿)。]",
    });
    state.messages.push({ role: "assistant", content: "已生成衍生稿。" });

    await collectFrames(
      runAgentTurn(
        state,
        "把第二段改短一点",
        [],
        [],
        [],
        null,
        undefined,
        undefined,
        undefined,
        { activeDocument: { kind: "main" } },
      ),
    );

    const streamedMessages = agentStreamCalls.at(-1)?.messages as Array<{
      role: string;
      content: string;
    }>;
    const currentUserMessage = streamedMessages.at(-1);
    expect(currentUserMessage?.content).toContain("把第二段改短一点");
    expect(currentUserMessage?.content).toContain(
      "本轮发送时界面激活的是主文档",
    );
    expect(currentUserMessage?.content).toContain(
      "历史消息中任何“当前正查看衍生稿”",
    );
    expect(state.messages.at(-1)?.content).not.toContain("当前文档目标");
  });

  it("blockId 缺失时用 chip label 作为 readDraft 模糊定位文本", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-selection-ctx");
    state.doc = legacySectionsToPm([
      { kind: "h1", data: { text: "春天的校园" } },
      { kind: "p", data: { text: "三月的阳光透过教学楼的玻璃窗，洒在走廊的地砖上。" } },
    ] as never);
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
    expect(content).toContain("AI 修改");
    expect(content).toContain('readDraft(query: "AI 修改")');
    expect(content).not.toContain(selected);
    expect(content).toContain('action:"replaceText"');
    expect(content).toContain('action:"markText"');
    expect(content).toContain("withinRef");
    const requestContext = agentStreamCalls[0]?.options.requestContext as {
      get: (key: string) => unknown;
    };
    expect(requestContext.get("usageCallSite")).toBe("agentSelectionEdit");

    expect(agentStreamCalls).toHaveLength(1);
    expect(agentStreamCalls[0]!.options.toolChoice).toBeUndefined();
  });
});

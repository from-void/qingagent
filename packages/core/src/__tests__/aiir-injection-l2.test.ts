import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { createSession } from "../session/sessionState.js";
import { pmDocFromBlocks } from "./pmTestUtils.js";

const agentStreamCalls: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function fixtureDoc() {
  return pmDocFromBlocks([
    { type: "heading", level: 1, text: "春天的校园" },
    { type: "paragraph", text: "三月的阳光透过教学楼的玻璃窗。" },
  ]);
}

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => "[]"),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
  getObservability: () => null,
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
          yield { type: "text-delta" as const, payload: { text: "收到。" } };
        })(),
        toolCalls: Promise.resolve([]),
      };
    }),
    resumeStream: vi.fn(),
  },
}));

describe("AI-IR prompt injection L2", () => {
  beforeEach(async () => {
    agentStreamCalls.length = 0;
    // 固定时钟,让时间锚内容确定可断言(时间注入已恒开,原环境变量开关已转正删除)
    const { __setTimeProviderForTest } = await import("../session/timeProvider.js");
    __setTimeProviderForTest(() => new Date(2026, 5, 11, 14, 30));
  });

  afterEach(async () => {
    const { __setTimeProviderForTest } = await import("../session/timeProvider.js");
    __setTimeProviderForTest(null);
  });

  it("末条 user message 不含整篇快照和行号,但包含前置时间锚", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("aiir-injection-on");
    state.doc = fixtureDoc();
    state.docVersion = 3;
    state.lastSyncedDocumentSnapshot = 0;
    state.docState = { kind: "editing" };

    await collectFrames(runAgentTurn(state, "把选中的文字改温暖一点", [], [
      {
        kind: { kind: "selection" },
        resourceRef: null,
        prefix: null,
        label: "AI 修改",
        suffix: null,
        from: 8,
        to: 13,
      },
    ]));

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;
    expect(content).not.toContain("──── 当前文档");
    expect(content).not.toMatch(/\[\d+\]/);
    expect(content).toContain("服务器系统时间");
    // 固定时钟下时间锚内容确定可断言(2026-06-11 14:30 是星期四)
    expect(content).toContain("2026年6月11日 星期四 14:30");
    expect(content.indexOf("服务器系统时间")).toBeGreaterThanOrEqual(0);
    expect(content.indexOf("服务器系统时间")).toBeLessThan(500);
    expect(content).toContain("readDraft(query:");
    expect(content).toContain('action:"replaceText"');
    expect(content).toContain('action:"markText"');
    expect(content).toContain("withinRef");
    expect(content).not.toContain("blockIndex");
    expect(content).not.toContain("before 必须原样填写");
    expect(content).not.toContain('format:"bold"');
    expect(state._sectionToLine).toBeInstanceOf(Map);
    expect(Array.from(state._sectionToLine ?? [])).toEqual([[0, 1], [1, 3]]);
    expect(state.lastSyncedDocumentSnapshot).toBe(3);
    expect(agentStreamCalls).toHaveLength(1);
    const providerPrompt = JSON.stringify(agentStreamCalls[0]?.messages ?? []);
    expect(providerPrompt).not.toContain("──── 当前文档");
    expect(providerPrompt).not.toContain("[1] # 春天的校园");
  });

  it("文档同步不改写既有历史消息字节", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("aiir-history-byte-guard");
    state.doc = fixtureDoc();
    state.docVersion = 5;
    state.lastSyncedDocumentSnapshot = 0;
    state.docState = { kind: "editing" };
    const originalUserText = "originalUserText";
    const historicalMessage = { role: "user" as const, content: originalUserText };
    Object.freeze(historicalMessage);
    state.messages = [historicalMessage];
    const beforeLen = state.messages.length;
    const beforeBytes = JSON.stringify(state.messages.slice(0, beforeLen));

    await collectFrames(runAgentTurn(state, "把第二段改得更明亮"));

    expect(JSON.stringify(state.messages.slice(0, beforeLen))).toBe(beforeBytes);
    expect(state.messages[beforeLen - 1]?.content).toBe(originalUserText);
    expect(String(state.messages[beforeLen - 1]?.content)).not.toContain("──── 当前文档");
    expect(String(state.messages[beforeLen - 1]?.content)).not.toContain("服务器系统时间");
    const appended = state.messages.slice(beforeLen);
    const appendedUser = appended.find((message) => message.role === "user");
    expect(appendedUser).toBeDefined();
    expect(String(appendedUser?.content)).not.toContain("──── 当前文档");
    expect(String(appendedUser?.content)).not.toMatch(/\[\d+\]/);
  });

});

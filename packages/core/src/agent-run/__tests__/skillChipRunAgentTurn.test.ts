import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@mastra/core/request-context";
import type { BridgeFrame, ChatChip } from "@qingagent/contract-ts";
import { createSession } from "../../session/sessionState.js";
import { getActivatedSkillRegistrations } from "../../skills/writeInject.js";

const agentStreamCalls: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

vi.mock("../../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async (id: string) => id === "feishu" || id === "web-search"),
    get: vi.fn(async () => null),
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

vi.mock("../../agents/toolSearch.js", () => ({
  QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY: "qingagentToolSearchProcessor",
  isQingagentToolSearchEnabled: vi.fn(() => false),
  preloadQingagentToolSearchTools: vi.fn(async () => []),
}));

vi.mock("../skillChipInstructionLoader.js", () => ({
  createSkillChipInstructionLoader: vi.fn(() => async ({ id }: { id: string }) => ({
    ok: true as const,
    id,
    source: `/skills/${id}/SKILL.md`,
    content: `---\nname: ${id}\n---\n# ${id} instruction\n按本技能执行。`,
  })),
}));

function skillChip(label: string, skillId: string): ChatChip {
  return {
    kind: { kind: "skill" },
    resourceRef: null,
    skillId,
    prefix: null,
    label,
    suffix: null,
  };
}

describe("runAgentTurn skill chip context injection", () => {
  beforeEach(() => {
    agentStreamCalls.length = 0;
  });

  it("模型侧把 qa_chip_context 紧随对应 chip 锚点,展示侧仍保留 richText", async () => {
    const { runAgentTurn } = await import("../runAgentTurn.js");
    const state = createSession("sess-skill-chip-inline");
    const chips = [skillChip("飞书", "feishu"), skillChip("联网搜", "web-search")];

    await collectFrames(
      runAgentTurn(
        state,
        "A 查日历,B 搜资料",
        [],
        chips,
        [{ id: "feishu", version: null }, { id: "web-search", version: null }],
        null,
        "m-user-skill-chip",
        "A {{chip:0}}查日历,B {{chip:1}}搜资料",
      ),
    );

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;
    expect(content).toContain("A 「技能：飞书」\n<qa_chip_context");
    expect(content).toContain('index="0"');
    expect(content).toContain('id="feishu"');
    expect(content).toContain("# feishu instruction");
    expect(content).toContain("查日历,B 「技能：联网搜」\n<qa_chip_context");
    expect(content).toContain('index="1"');
    expect(content).toContain('id="web-search"');
    expect(content).toContain("搜资料");
    expect(content).not.toContain("本轮请优先使用技能");

    const visibleUser = state.chatHistory.find((m) => m.id === "m-user-skill-chip");
    expect(visibleUser?.parts[0]).toEqual({
      kind: "text",
      data: { body: "A {{chip:0}}查日历,B {{chip:1}}搜资料" },
    });
    expect(agentStreamCalls).toHaveLength(1);
    const requestContext = agentStreamCalls[0]!.options
      .requestContext as RequestContext;
    expect(
      getActivatedSkillRegistrations(requestContext).map((entry) => entry.name),
    ).toEqual(["feishu", "web-search"]);
  }, 15_000);

  it("chip-only 消息只展开技能并追加询问缺失输入的引导,不泛化成空问候", async () => {
    const { runAgentTurn } = await import("../runAgentTurn.js");
    const state = createSession("sess-skill-chip-only");

    await collectFrames(
      runAgentTurn(
        state,
        "",
        [],
        [skillChip("飞书", "feishu")],
        [{ id: "feishu", version: null }],
        null,
        "m-user-chip-only",
        "{{chip:0}}",
      ),
    );

    const userMsg = state.messages.find((m) => m.role === "user");
    const content = userMsg!.content as string;
    expect(content).toContain("「技能：飞书」\n<qa_chip_context");
    expect(content).toContain("用户没有输入文字，仅发送了以上选择");
    expect(content).toContain("先向用户询问缺少的输入");
    expect(content).not.toContain("本轮请优先使用技能");
    const visibleUser = state.chatHistory.find((m) => m.id === "m-user-chip-only");
    expect(visibleUser?.parts[0]).toEqual({
      kind: "text",
      data: { body: "{{chip:0}}" },
    });
  }, 15_000);

  it("重试复用已有 clientMessageId 时不重复追加用户气泡，但仍重新调用模型", async () => {
    const { runAgentTurn } = await import("../runAgentTurn.js");
    const state = createSession("sess-retry-existing-user");
    state.chatHistory.push({
      id: "m-user-retry",
      role: { kind: "user" },
      ts: "2026-08-06T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "请重新生成" } }],
      chips: null,
    });

    await collectFrames(runAgentTurn(
      state,
      "请重新生成",
      [],
      [],
      [],
      null,
      "m-user-retry",
      undefined,
      undefined,
      { reuseExistingUserMessage: true },
    ));

    expect(state.chatHistory.filter((message) =>
      message.role.kind === "user" && message.id === "m-user-retry"
    )).toHaveLength(1);
    expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(agentStreamCalls).toHaveLength(1);
  }, 15_000);

  it("结构化自定义审查回合只暴露正式批注入口，不暴露正文写稿工具", async () => {
    const { runAgentTurn } = await import("../runAgentTurn.js");
    const state = createSession("sess-custom-review-tools");

    const frames = await collectFrames(runAgentTurn(
      state,
      "对当前文档做自定义审查。",
      [],
      [],
      [],
      [{
        kind: "actionCard",
        data: {
          title: "自定义审查",
          lines: [{ label: "模板", value: "对外发布" }],
          status: "running",
        },
      }],
      "m-user-custom-review",
      undefined,
      {
        type: "custom",
        templateId: "review-custom-publish",
        templateName: "对外发布",
      },
    ));

    expect(agentStreamCalls).toHaveLength(1);
    const options = agentStreamCalls[0]!.options as {
      requestContext: RequestContext;
      toolsets: { sessionScoped: Record<string, unknown> };
    };
    expect(options.toolsets.sessionScoped.readDraft).toBeDefined();
    expect(options.toolsets.sessionScoped.create_annotation_groups).toBeDefined();
    expect(options.toolsets.sessionScoped.editDraft).toBeUndefined();
    expect(options.toolsets.sessionScoped.writeDraft).toBeUndefined();
    expect(options.requestContext.get("reviewContext")).toEqual({
      type: "custom",
      templateId: "review-custom-publish",
      templateName: "对外发布",
    });
    expect(frames).toContainEqual({
      kind: "actionCardUpdated",
      data: {
        messageId: "m-user-custom-review",
        card: {
          title: "自定义审查",
          lines: [{ label: "模板", value: "对外发布" }],
          status: "done",
        },
      },
    });
  }, 15_000);
});

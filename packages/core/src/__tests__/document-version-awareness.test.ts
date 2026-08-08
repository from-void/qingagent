import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  pmToLegacySections,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { CoreMessage } from "ai";
import { createSession } from "../session/sessionState.js";
import { createSessionScopedTools } from "../session/sessionTools.js";
import {
  DOC_VERSION_AWARENESS_MARKER,
  appendDocVersionAwarenessToPromptOptions,
  buildDocVersionAwarenessContent,
  docVersionAwarenessSourceFromRequestContext,
  resolveDocVersionAwarenessContent,
  wrapModelWithDocVersionAwareness,
} from "../llm/docVersionAwarenessPrompt.js";
import {
  OM_OBSERVATIONS_MARKER,
  wrapModelWithOmObservations,
} from "../llm/omObservationsPrompt.js";
import { wrapModelWithTodoAwareness } from "../llm/todoAwarenessPrompt.js";
import { TODO_AWARENESS_MARKER } from "../agent-run/todoAwareness.js";

const agentStreamCalls: Array<{
  messages: CoreMessage[];
  options: Record<string, unknown>;
}> = [];

async function* streamOfText(text: string): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text } };
}

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function messageText(message: CoreMessage): string {
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return JSON.stringify(content);
}

function providerMessagesWithDocVersionAwareness(
  call: { messages: CoreMessage[]; options: Record<string, unknown> },
): CoreMessage[] {
  const requestContext = call.options.requestContext as {
    get?: (key: string) => unknown;
  };
  const content = resolveDocVersionAwarenessContent(
    docVersionAwarenessSourceFromRequestContext(requestContext),
  );
  return appendDocVersionAwarenessToPromptOptions(
    { prompt: call.messages },
    content,
  ).prompt as CoreMessage[];
}

const currentDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "paragraph",
    attrs: { blockId: "block-current" },
    content: [{ type: "text", text: "用户刚刚修改的正文" }],
  }],
};

function bindCurrentDoc(
  state: ReturnType<typeof createSession>,
  docVersion: number,
): void {
  state.doc = currentDoc;
  state.docVersion = docVersion;
}

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(async (messages: CoreMessage[], options: Record<string, unknown>) => {
      agentStreamCalls.push({ messages: [...messages], options });
      return {
        runId: `run-${agentStreamCalls.length}`,
        fullStream: streamOfText("收到。"),
      };
    }),
  },
}));

describe("正文版本动态感知", () => {
  beforeEach(() => {
    agentStreamCalls.length = 0;
    vi.clearAllMocks();
    vi.stubEnv("QINGAGENT_OM_SIDECAR", "0");
    vi.stubEnv("QINGAGENT_OM_COMPRESS", "0");
  });

  it("用户手改推进版本后在 provider prompt 尾部注入信号，readDraft 后消失", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("doc-version-user-edit");
    bindCurrentDoc(state, 2);
    state.modelKnownDocVersion = 1;

    await collectFrames(runAgentTurn(state, "核查一下当前正文"));

    expect(agentStreamCalls).toHaveLength(1);
    expect(agentStreamCalls[0]!.messages.some((message) =>
      messageText(message).includes(DOC_VERSION_AWARENESS_MARKER)
    )).toBe(false);
    const firstProviderMessages = providerMessagesWithDocVersionAwareness(
      agentStreamCalls[0]!,
    );
    expect(messageText(firstProviderMessages.at(-1)!)).toBe(
      `${DOC_VERSION_AWARENESS_MARKER} 正文自你上次读取(v1)后已更新到 v2。` +
      "任何基于正文内容的判断(审阅/核查/改写/引用)之前,必须先重新 readDraft;" +
      "不得沿用上下文中的历史读取结果。",
    );

    const { readDraftAiIr } = createSessionScopedTools(state);
    const readResult = await readDraftAiIr.execute!({ mode: "full" }, {} as never) as {
      ok: boolean;
      docVersion?: number;
    };
    expect(readResult).toMatchObject({ ok: true, docVersion: 2 });
    expect(state.modelKnownDocVersion).toBe(2);

    await collectFrames(runAgentTurn(state, "继续核查"));

    expect(agentStreamCalls).toHaveLength(2);
    expect(providerMessagesWithDocVersionAwareness(agentStreamCalls[1]!)).toEqual(
      agentStreamCalls[1]!.messages,
    );
  });

  it("服务重启后的未读态有正文时提示首读，无正文时不注入", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const restored = createSession("doc-version-restored");
    bindCurrentDoc(restored, 3);
    expect(restored.modelKnownDocVersion).toBeNull();

    await collectFrames(runAgentTurn(restored, "继续上次任务"));

    const providerMessages = providerMessagesWithDocVersionAwareness(
      agentStreamCalls[0]!,
    );
    expect(messageText(providerMessages.at(-1)!)).toBe(
      `${DOC_VERSION_AWARENESS_MARKER} 本会话你尚未读取正文,涉及正文的任务先 readDraft;` +
      "不得沿用上下文中的历史读取结果。",
    );

    const emptyRestored = createSession("doc-version-restored-empty");
    emptyRestored.docVersion = 3;
    expect(buildDocVersionAwarenessContent(emptyRestored)).toBeNull();
  });

  it("与任务清单和长期观察共存时，长期观察后紧邻正文版本信号", async () => {
    const seenPrompts: CoreMessage[][] = [];
    const baseModel = {
      async doGenerate(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt as CoreMessage[]);
        return { content: [], finishReason: "stop", usage: {}, warnings: [] };
      },
      async doStream() {
        return { stream: new ReadableStream() };
      },
    };
    const wrapped = wrapModelWithTodoAwareness(
      wrapModelWithOmObservations(
        wrapModelWithDocVersionAwareness(
          baseModel,
          `${DOC_VERSION_AWARENESS_MARKER} 请先重新 readDraft。`,
        ),
        `${OM_OBSERVATIONS_MARKER}\n- 用户偏好精简。`,
      ),
      `${TODO_AWARENESS_MARKER} 当前清单:1.[待办]核查。`,
    );

    await wrapped.doGenerate({ prompt: [{ role: "user", content: "继续" }] });

    const prompt = seenPrompts[0]!;
    const tail = prompt.slice(-3).map(messageText);
    expect(tail[0]).toContain(TODO_AWARENESS_MARKER);
    expect(tail[1]).toContain(OM_OBSERVATIONS_MARKER);
    expect(tail[2]).toContain(DOC_VERSION_AWARENESS_MARKER);
  });
});

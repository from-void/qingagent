import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

// show_qr 二维码卡桥层回归:异常 result 路径也必须 append 可渲染 part;
// 缺 content 时不能产出前端 validator 会拒绝的空 qrCard。

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collect(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function collectWithReturn<T>(
  gen: AsyncGenerator<BridgeFrame, T>,
): Promise<{ frames: BridgeFrame[]; result: T }> {
  const frames: BridgeFrame[] = [];
  let next = await gen.next();
  while (!next.done) {
    frames.push(next.value);
    next = await gen.next();
  }
  return { frames, result: next.value };
}

function showQrResult(toolCallId: string, args: Record<string, unknown>) {
  return {
    type: "tool-result",
    payload: { toolName: "show_qr", toolCallId, args, result: { ok: true } },
  };
}

function showQrCall(toolCallId: string, args: Record<string, unknown>) {
  return {
    type: "tool-call",
    payload: { toolName: "show_qr", toolCallId, args },
  };
}

function commandCall(toolCallId: string, command: string) {
  return {
    type: "tool-call",
    payload: {
      toolName: "mastra_workspace_execute_command",
      toolCallId,
      args: { command },
    },
  };
}

function commandResult(toolCallId: string, command: string, result: unknown) {
  return {
    type: "tool-result",
    payload: {
      toolName: "mastra_workspace_execute_command",
      toolCallId,
      args: { command },
      result,
    },
  };
}

function transientErrorChunk(message: string) {
  return {
    type: "error",
    payload: {
      error: new Error(message),
    },
  };
}

function toolSpecs(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  const specs: ToolCallSpec[] = [];
  for (const frame of frames) {
    if (frame.kind !== "toolCallUpdated") continue;
    const data = frame.data as { toolCallId: string; spec: ToolCallSpec };
    if (data.toolCallId === toolCallId) specs.push(data.spec);
  }
  return specs;
}

function appendedToolCallCount(frames: BridgeFrame[], toolCallId: string): number {
  return frames.filter(
    (frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "toolCall" &&
      frame.data.part.data.id === toolCallId,
  ).length;
}

describe("show_qr 二维码卡帧协议", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tool-result 找不到 running part 时也 append done 二维码卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-result-only");

    const frames = await collect(
      processAgentStream(
        streamOf(
          showQrResult("qr1", {
            content: "https://example.com/auth",
            title: "扫码授权飞书",
            refreshQuery: "二维码过期了,请重新生成",
          }),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(appendedToolCallCount(frames, "qr1")).toBe(1);
    const final = toolSpecs(frames, "qr1").at(-1);
    expect(final?.status.kind).toBe("done");
    expect(final?.body.kind).toBe("qrCard");
    if (final?.body.kind === "qrCard") {
      expect(final.body.data.content).toBe("https://example.com/auth");
      expect(final.body.data.expiresAt).toBeGreaterThan(Date.now());
    }
    expect(
      state.chatHistory.some((message) =>
        message.parts.some((part) => part.kind === "toolCall" && part.data.id === "qr1"),
      ),
    ).toBe(true);
  });

  it("缺 content 时不产出空 qrCard,改为 generic 失败提示", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-missing-content");

    const frames = await collect(
      processAgentStream(
        streamOf(
          showQrCall("qr2", {
            title: "扫码授权飞书",
            refreshQuery: "二维码过期了,请重新生成",
          }),
          showQrResult("qr2", {
            title: "扫码授权飞书",
            refreshQuery: "二维码过期了,请重新生成",
          }),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    const specs = toolSpecs(frames, "qr2");
    expect(specs.some((spec) => spec.body.kind === "qrCard")).toBe(false);
    const final = specs.at(-1);
    expect(final?.status.kind).toBe("done");
    expect(final?.body.kind).toBe("generic");
    expect(final?.result).toEqual({
      kind: "genericText",
      data: "show_qr 缺少 content/imageDataUri,无法渲染二维码",
    });
  });

  it("图片模式:传 imageDataUri(无 content)产出 qrCard 并透传图片", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-image-mode");
    const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
    const args = { imageDataUri: img, title: "扫码登录微信公众号", confirmQuery: "我已扫码完成" };
    const frames = await collect(
      processAgentStream(
        streamOf(showQrCall("qr-img", args), showQrResult("qr-img", args)),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );
    const final = toolSpecs(frames, "qr-img").at(-1);
    expect(final?.status.kind).toBe("done");
    expect(final?.body.kind).toBe("qrCard");
    if (final?.body.kind === "qrCard") {
      expect(final.body.data.imageDataUri).toBe(img);
      expect(final.body.data.content).toBe("");
    }
  });

  it("show_qr-only 回合结束等待用户时不发 draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-wait-user");

    const frames = await collect(
      processAgentStream(
        streamOf(
          showQrCall("qr3", {
            content: "https://example.com/auth",
            title: "扫码授权飞书",
            note: "用飞书 App 扫码,或 [点此授权](https://example.com/auth)",
            confirmQuery: "我已完成飞书扫码授权,请继续收尾",
          }),
          showQrResult("qr3", {
            content: "https://example.com/auth",
            title: "扫码授权飞书",
            note: "用飞书 App 扫码,或 [点此授权](https://example.com/auth)",
            confirmQuery: "我已完成飞书扫码授权,请继续收尾",
          }),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(
      frames.some((frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed"),
    ).toBe(false);
    expect(
      frames
        .filter((frame) => frame.kind === "chatMessageAppended" && frame.data.part.kind === "text")
        .map((frame) => (frame.kind === "chatMessageAppended" && frame.data.part.kind === "text"
          ? frame.data.part.data.body
          : ""))
        .join("\n"),
    ).not.toContain("本轮做了多步工具调用");

    const final = toolSpecs(frames, "qr3").at(-1);
    expect(final?.status.kind).toBe("done");
    expect(final?.body.kind).toBe("qrCard");
  });

  it("CLI 授权命令 + show_qr 混合回合结束等待用户时不发 draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-cli-wait-user");
    const command = "lark-cli auth login --no-wait --json --domain all";
    const authStdout = JSON.stringify({
      verification_url: "https://example.com/device?user_code=ABCD",
      device_code: "device-code-123",
      expires_in: 300,
    });
    const qrArgs = {
      content: "https://example.com/device?user_code=ABCD",
      title: "扫码授权飞书",
      code: "ABCD",
      note: "用飞书 App 扫码,或 [点此授权](https://example.com/device?user_code=ABCD)",
      confirmQuery: "我已完成飞书扫码授权,请继续收尾",
    };

    const frames = await collect(
      processAgentStream(
        streamOf(
          commandCall("cmd-auth", command),
          commandResult("cmd-auth", command, authStdout),
          showQrCall("qr-cli", qrArgs),
          showQrResult("qr-cli", qrArgs),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(
      frames.some((frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed"),
    ).toBe(false);
    expect(
      frames
        .filter((frame) => frame.kind === "chatMessageAppended" && frame.data.part.kind === "text")
        .map((frame) => (frame.kind === "chatMessageAppended" && frame.data.part.kind === "text"
          ? frame.data.part.data.body
          : ""))
        .join("\n"),
    ).not.toContain("本轮做了多步工具调用");

    const toolContext = state.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(toolContext).toContain("mastra_workspace_execute_command");
    expect(toolContext).toContain("device_code");
    expect(toolContext).toContain("device-code-123");
  });

  it("show_qr 产出卡片后标记 producedVisibleFrame,瞬态错误不再被当零可见产出重试", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("qr-visible-before-transient");

    const { result } = await collectWithReturn(
      processAgentStream(
        streamOf(
          showQrCall("qr-visible", {
            content: "https://example.com/auth",
            title: "扫码授权飞书",
          }),
          transientErrorChunk("other side closed"),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(result.producedVisibleFrame).toBe(true);
    expect(result.transientErrorChunk).toBeUndefined();
  });

  it("runAgentTurn 旧流 finally 不清空已被新流占用的 streamId", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("qr-stream-owner-guard");

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "old-run",
      fullStream: streamOf({ type: "text-delta", payload: { text: "旧流产出" } }),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    const gen = runAgentTurn(state, "触发旧流");
    let oldStreamId: string | null = null;
    for (;;) {
      const next = await gen.next();
      if (next.done) throw new Error("expected a text frame before runAgentTurn finishes");
      const frame = next.value;
      if (frame.kind === "stream" && frame.data.kind === "start") {
        oldStreamId = frame.data.data.streamId;
      }
      if (
        frame.kind === "chatMessageAppended" &&
        frame.data.part.kind === "text" &&
        frame.data.part.data.body.includes("旧流产出")
      ) {
        break;
      }
    }

    expect(oldStreamId).toBeTruthy();
    expect(state.streamId).toBe(oldStreamId);

    state.streamId = "new-owner-stream";
    const rest = await collect(gen);

    expect(rest).toContainEqual({
      kind: "stream",
      data: { kind: "end", data: { streamId: oldStreamId, reason: { kind: "done" } } },
    });
    expect(state.streamId).toBe("new-owner-stream");
  });
});

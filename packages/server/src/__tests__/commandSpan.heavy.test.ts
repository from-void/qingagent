import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, BridgeFrame } from "@qingagent/contract-ts";

type FakeSpan = {
  options: Record<string, unknown>;
  endCalls: Array<Record<string, unknown> | undefined>;
  errorCalls: Array<Record<string, unknown>>;
  end(options?: Record<string, unknown>): void;
  error(options: Record<string, unknown>): void;
};

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function loadBridgeWithFakeObservability(
  overrides: {
    runAgentTurn?: (...args: unknown[]) => AsyncGenerator<BridgeFrame>;
  } = {},
): Promise<{
  spans: FakeSpan[];
  bridge: typeof import("../gateway/bridgeHandler");
}> {
  vi.resetModules();
  const spans: FakeSpan[] = [];

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      ...overrides,
      getObservability: () => ({
        getDefaultInstance: () => ({
          startSpan: (options: Record<string, unknown>) => {
            const span: FakeSpan = {
              options,
              endCalls: [],
              errorCalls: [],
              end(endOptions?: Record<string, unknown>) {
                this.endCalls.push(endOptions);
              },
              error(errorOptions: Record<string, unknown>) {
                this.errorCalls.push(errorOptions);
              },
            };
            spans.push(span);
            return span;
          },
        }),
      }),
    };
  });

  const bridge = await import("../gateway/bridgeHandler");
  return { spans, bridge };
}

describe("command span lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks thrown command failures as errored", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    const command: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "does-not-exist",
        text: "test",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    };

    await expect(collectFrames(bridge.handleCommand(command))).rejects.toThrow(
      "Session not found",
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.errorCalls).toHaveLength(1);
    expect(spans[0]?.endCalls[0]?.metadata).toMatchObject({
      outcome: "error",
      failureKind: "throw",
      failureReason: "Session not found: does-not-exist",
    });
  });

  it("marks draftingFailed frames as errored", async () => {
    async function* runAgentTurn(): AsyncGenerator<BridgeFrame> {
      yield {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "stream-1",
            reason: "tool failed",
            retriable: true,
          },
        },
      };
    }

    const { spans, bridge } = await loadBridgeWithFakeObservability({ runAgentTurn });
    const startFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    );
    const sessionMeta = startFrames.find((frame) => frame.kind === "sessionMeta");
    if (sessionMeta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");

    await collectFrames(
      bridge.handleCommand({
        kind: "sendMessage",
        data: {
          sessionId: sessionMeta.data.sessionId,
          text: "test",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
        },
      }),
    );

    const sendSpan = spans.find((span) => {
      const metadata = span.options.metadata as { kind?: string } | undefined;
      return metadata?.kind === "sendMessage";
    });
    expect(sendSpan?.errorCalls).toHaveLength(1);
    expect(sendSpan?.endCalls[0]?.metadata).toMatchObject({
      outcome: "error",
      failureKind: "draftingFailed",
      failureReason: "tool failed",
    });
  });

  it("can mark commit command failures as errored", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    const span = bridge.recordCommandSpan(
      { kind: "commitPatches", data: { ids: ["patch-1"] } },
      "session-1",
      "1234567890abcdef1234567890abcdef",
    );

    span.endError(new Error("commit failed"), { failureKind: "commitFailed" });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.errorCalls).toHaveLength(1);
    expect(spans[0]?.endCalls[0]?.metadata).toMatchObject({
      outcome: "error",
      failureKind: "commitFailed",
      failureReason: "commit failed",
    });
  });

  it("attachFolder command span 只记录 provider/sessionId 摘要", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    const command: Command = {
      kind: "attachFolder",
      data: {
        sessionId: "sess-redact",
        requestId: "attach-redact",
        source: {
          provider: "desktop-local",
          selectionToken: "dfs_7_/Users/alice/SecretDocs",
        },
      },
    };

    bridge.recordCommandSpan(command, "sess-redact", undefined).endOk();

    expect(spans[0]?.options.input).toEqual({
      sessionId: "sess-redact",
      provider: "desktop-local",
    });
    expect(JSON.stringify(spans[0]?.options)).not.toContain("SecretDocs");
    expect(JSON.stringify(spans[0]?.options)).not.toContain("selectionToken");
  });

  it("reparseMaterial command span 记录 sessionId/fileId 摘要", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    const command: Command = {
      kind: "reparseMaterial",
      data: {
        sessionId: "sess-reparse",
        fileId: "11111111-1111-4111-8111-111111111111",
      },
    };

    bridge.recordCommandSpan(command, "sess-reparse", undefined).endOk();

    expect(spans[0]?.options.input).toEqual({
      sessionId: "sess-reparse",
      fileId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("attachFolder 业务失败帧会把 command span 标记为 error", async () => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    const startFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    );
    const sessionMeta = startFrames.find((frame) => frame.kind === "sessionMeta");
    if (sessionMeta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "attachFolder",
        data: {
          sessionId: sessionMeta.data.sessionId,
          requestId: "attach-missing",
          source: {
            provider: "desktop-local",
            selectionToken: "dfs_missing",
          },
        },
      }),
    );

    expect(frames).toContainEqual({
      kind: "folderSourceOperationResult",
      data: {
        ok: false,
        op: "attach",
        requestId: "attach-missing",
        clientSourceId: null,
        reason: "unsupported_environment",
      },
    });
    const attachSpan = spans.find((span) => {
      const metadata = span.options.metadata as { kind?: string } | undefined;
      return metadata?.kind === "attachFolder";
    });
    expect(attachSpan?.errorCalls).toHaveLength(1);
    expect(attachSpan?.endCalls[0]?.metadata).toMatchObject({
      outcome: "error",
      failureKind: "folderSource.attach",
      failureReason: "unsupported_environment",
    });
    expect(attachSpan?.endCalls[0]?.output).toEqual({
      accepted: false,
      failureReason: "unsupported_environment",
    });
  });
});

describe("origin (触发来源) 透传", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parseOrigin: agent/e2e 直通(含大小写/空白),其余与缺省 → manual", async () => {
    const { bridge } = await loadBridgeWithFakeObservability();
    expect(bridge.parseOrigin("agent")).toBe("agent");
    expect(bridge.parseOrigin("e2e")).toBe("e2e");
    expect(bridge.parseOrigin("AGENT")).toBe("agent");
    expect(bridge.parseOrigin("  e2e ")).toBe("e2e");
    expect(bridge.parseOrigin("manual")).toBe("manual");
    expect(bridge.parseOrigin("bogus")).toBe("manual");
    expect(bridge.parseOrigin("")).toBe("manual");
    expect(bridge.parseOrigin(undefined)).toBe("manual");
  });

  it("recordCommandSpan 把 origin 写进 command span metadata", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    bridge
      .recordCommandSpan(
        { kind: "commitPatches", data: { ids: ["p1"] } },
        "session-1",
        "1234567890abcdef1234567890abcdef",
        "agent",
      )
      .endOk();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.options.metadata).toMatchObject({
      eventKind: "command",
      origin: "agent",
    });
  });

  it("recordCommandSpan origin 缺省为 manual", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    bridge
      .recordCommandSpan(
        { kind: "commitPatches", data: { ids: ["p1"] } },
        "session-1",
        "1234567890abcdef1234567890abcdef",
      )
      .endOk();
    expect(spans[0]?.options.metadata).toMatchObject({ origin: "manual" });
  });

  it("handleCommand 透传 origin=agent 到 command span(覆盖面)", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    await collectFrames(
      bridge.handleCommand(
        { kind: "startSession", data: { mode: { kind: "new", data: { template: null } } } },
        undefined,
        "agent",
      ),
    );
    const cmd = spans.find(
      (s) => (s.options.metadata as { eventKind?: string })?.eventKind === "command",
    );
    expect((cmd?.options.metadata as { origin?: string })?.origin).toBe("agent");
  });

  it("handleCommand 不传 origin → command span 缺省 manual", async () => {
    const { spans, bridge } = await loadBridgeWithFakeObservability();
    await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    );
    const cmd = spans.find(
      (s) => (s.options.metadata as { eventKind?: string })?.eventKind === "command",
    );
    expect((cmd?.options.metadata as { origin?: string })?.origin).toBe("manual");
  });
});

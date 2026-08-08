import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createTool } from "@mastra/core/tools";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import type { QingagentThreadMetadata } from "@qingagent/core";

const originalDatabaseUrl = process.env.DATABASE_URL;

const RESOURCE_ID = "qingagent-user";
const WORKFLOW_NAME = "agentic-loop";

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  vi.resetModules();
  vi.doUnmock("@qingagent/core");
});

function streamFrom(parts: unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function hasAskUserToolResult(prompt: unknown): boolean {
  const serialized = JSON.stringify(prompt);
  return serialized.includes('"tool-result"') && serialized.includes("askUser");
}

function usage() {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
}

function createDurableMockModel(): any {
  const finalText = "durable resumed through resumeAskUser";
  const contentFor = (prompt: unknown) =>
    hasAskUserToolResult(prompt)
      ? [{ type: "text", text: finalText }]
      : [
          {
            type: "tool-call",
            toolCallId: "call_durable_ask",
            toolName: "askUser",
            input: "{}",
          },
        ];
  const finishReasonFor = (prompt: unknown) =>
    hasAskUserToolResult(prompt) ? "stop" : "tool-calls";
  const streamPartsFor = (prompt: unknown) => {
    if (hasAskUserToolResult(prompt)) {
      return [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: finalText },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop", usage: usage() },
      ];
    }
    return [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_durable_ask",
        toolName: "askUser",
        input: "{}",
      },
      { type: "finish", finishReason: "tool-calls", usage: usage() },
    ];
  };

  return {
    specificationVersion: "v2",
    provider: "qingagent-test",
    modelId: "durable-resume-bridge-mock",
    supportedUrls: {},
    async doGenerate(options: any) {
      return {
        content: contentFor(options.prompt),
        finishReason: finishReasonFor(options.prompt),
        usage: usage(),
        warnings: [],
      };
    },
    async doStream(options: any) {
      return { stream: streamFrom(streamPartsFor(options.prompt)) };
    },
  };
}

const durableAskUserTool = createTool({
  id: "askUser",
  description: "Durable askUser bridge test tool",
  execute: async (_input, context: any) => {
    const resumeData = context?.agent?.resumeData as
      | Record<string, { chosen: string[]; freeText: string | null }>
      | undefined;
    if (!resumeData || Object.keys(resumeData).length === 0) {
      return await context?.agent?.suspend({
        questions: ["需要确认什么？"],
      });
    }
    return resumeData;
  },
});

function createHarness(dbFile: string) {
  const storage = new LibSQLStore({
    id: "qingagent-durable-bridge-test",
    url: `file:${dbFile}`,
  });
  const agent = new Agent({
    id: "qingagent-durable-bridge-test-agent",
    name: "Qingagent Durable Bridge Test Agent",
    instructions: "Use askUser once, then finish after resume.",
    model: createDurableMockModel(),
    tools: { askUser: durableAskUserTool },
  });
  const mastra = new Mastra({
    agents: { qingagentDurableBridgeTest: agent },
    storage,
  });
  return { agent, mastra, storage };
}

async function collectChunks(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function collectFrames(stream: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of stream) {
    frames.push(frame);
  }
  return frames;
}

function askUserToolCallSpec(id: string): ToolCallSpec {
  return {
    id,
    name: "askUser",
    render: { kind: "rightForm" },
    status: { kind: "running", data: { progressPct: null, etaSec: null } },
    body: {
      kind: "askUser",
      data: {
        id,
        mode: { kind: "fullpage" },
        purpose: { kind: "initialBrief" },
        source: null,
        rationale: null,
        questions: [
          {
            id: "q-one",
            label: "需要确认什么？",
            kind: { kind: "text" },
            options: [],
            placeholder: null,
          },
        ],
      },
    },
    result: null,
  };
}

function metadata(runId: string, toolCallId: string): QingagentThreadMetadata {
  return {
    docId: "durable-bridge-session",
    docState: { kind: "empty" },
    docVersion: 0,
    lastSyncedDocumentSnapshot: 0,
    materials: [],
    title: "Durable bridge session",
    runId,
    toolCallId,
    askUserCompleted: true,
    chatHistory: [
      {
        id: "msg-ask",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: askUserToolCallSpec(toolCallId) }],
        chips: null,
      },
    ],
    lastPersistedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("bridgeHandler durable askUser resume", () => {
  it("restores a cold askUser suspension and resumes through resumeAskUser without fresh-turn fallback", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "qingagent-durable-bridge-"));
    try {
      const dbFile = join(tempDir, "durable.db");
      // 影子双写已恒开:DATABASE_URL 指向临时库,双写天然隔离,无需再关。
      process.env.DATABASE_URL = `file:${dbFile}`;

      const sessionId = "durable-bridge-session";
      const first = createHarness(dbFile);
      void first.mastra;
      const firstStream = await first.agent.stream("start durable ask", {
        maxSteps: 4,
        memory: { thread: sessionId, resource: RESOURCE_ID },
      });
      const firstChunks = await collectChunks(firstStream.fullStream);
      const suspended = firstChunks.find(
        (chunk) => chunk.type === "tool-call-suspended",
      );
      expect(suspended).toBeDefined();
      expect(firstStream.runId).toBeTruthy();

      const workflows = await first.storage.getStore("workflows");
      const snapshot = await workflows?.loadWorkflowSnapshot({
        workflowName: WORKFLOW_NAME,
        runId: firstStream.runId,
      });
      expect(snapshot?.status).toBe("suspended");

      vi.resetModules();
      const productForSeed = await import("@qingagent/core");
      await productForSeed.getMemory().saveThread({
        thread: {
          id: sessionId,
          title: "Durable bridge session",
          resourceId: RESOURCE_ID,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: metadata(
            firstStream.runId,
            suspended.payload.toolCallId,
          ) as unknown as Record<string, unknown>,
        },
      });

      const second = createHarness(dbFile);
      void second.mastra;
      vi.resetModules();
      vi.doMock("@qingagent/core", async () => {
        const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
        return {
          ...actual,
          qingagentAgent: second.agent,
        };
      });
      const bridge = await import("../gateway/bridgeHandler");
      const {
        buildAskUserAnswerUserMessage,
        loadSessionFromThread,
      } = await import("@qingagent/core");

      const restoreFrames = await collectFrames(
        bridge.handleCommand({
          kind: "startSession",
          data: { mode: { kind: "existing", data: { id: sessionId } } },
        }),
      );
      const restored = bridge.getSession(sessionId);
      expect(restored?.runId).toBe(firstStream.runId);
      expect(restored?.toolCallId).toBe(suspended.payload.toolCallId);
      expect(restored?._suspensionOwner).toEqual({
        streamId: `restored:${firstStream.runId}`,
        runId: firstStream.runId,
        toolCallId: suspended.payload.toolCallId,
        toolName: "askUser",
      });
      expect(
        restoreFrames.some(
          (frame) =>
            frame.kind === "toolCallUpdated" &&
            frame.data.toolCallId === suspended.payload.toolCallId &&
            frame.data.spec.status.kind === "running",
        ),
      ).toBe(true);
      const preResumeMessageCount = restored?.messages.length ?? 0;
      const preResumeMessagesBytes = JSON.stringify(restored?.messages ?? []);

      const resumeFrames = await collectFrames(
        bridge.handleCommand({
          kind: "resumeAskUser",
          data: {
            sessionId,
            toolCallId: suspended.payload.toolCallId,
            answers: {
              "q-one": { chosen: [], freeText: "答案A" },
            },
          },
        }),
      );

      const doneFrame = resumeFrames.find(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === suspended.payload.toolCallId &&
          frame.data.spec.status.kind === "done",
      );
      expect(doneFrame).toBeDefined();
      expect(JSON.stringify(resumeFrames)).toContain(
        "durable resumed through resumeAskUser",
      );
      expect(
        resumeFrames.some(
          (frame) =>
            frame.kind === "stream" &&
            frame.data.kind === "draftingFailed",
        ),
      ).toBe(false);
      expect(restored?.runId).toBeNull();
      expect(restored?.toolCallId).toBeNull();
      expect(restored?._suspensionOwner).toBeNull();

      const expectedAnswerMessage = buildAskUserAnswerUserMessage({
        toolCallId: suspended.payload.toolCallId,
        spec: askUserToolCallSpec(suspended.payload.toolCallId),
        answers: {
          "q-one": { chosen: [], freeText: "答案A" },
        },
      });
      const answerMessages = restored?.messages.filter((message) =>
        typeof message.content === "string" &&
        message.content.startsWith(`[askUserAnswers:${suspended.payload.toolCallId}]`)
      );
      expect(JSON.stringify(restored?.messages.slice(0, preResumeMessageCount) ?? []))
        .toBe(preResumeMessagesBytes);
      expect(restored?.messages[preResumeMessageCount]).toEqual(expectedAnswerMessage);
      expect(answerMessages).toEqual([expectedAnswerMessage]);

      const coldRestored = await loadSessionFromThread(sessionId);
      expect(JSON.stringify(coldRestored?.messages)).toBe(JSON.stringify(restored?.messages));
      expect(JSON.stringify(coldRestored?.messages.slice(0, preResumeMessageCount) ?? []))
        .toBe(preResumeMessagesBytes);
      expect(coldRestored?.messages[preResumeMessageCount]).toEqual(expectedAnswerMessage);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

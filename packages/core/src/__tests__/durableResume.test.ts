import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import type { QingagentThreadMetadata } from "../session/threadPersistence.js";

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
  return JSON.stringify(prompt).includes('"tool-result"') &&
    JSON.stringify(prompt).includes("askUser");
}

function usage() {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
}

function createDurableMockModel(): any {
  const finalText = "durable resumed from snapshot";
  const contentFor = (prompt: unknown) =>
    hasAskUserToolResult(prompt)
      ? [{ type: "text", text: finalText }]
      : [{
          type: "tool-call",
          toolCallId: "call_durable_ask",
          toolName: "askUser",
          input: "{}",
        }];
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
    modelId: "durable-resume-mock",
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
  description: "Durable askUser test tool",
  inputSchema: z.object({}),
  outputSchema: z.object({ answer: z.string() }),
  suspendSchema: z.object({
    questions: z.array(z.string()),
  }),
  resumeSchema: z.object({
    answer: z.string(),
  }),
  execute: async (_input, context: any) => {
    const resumeData = context?.agent?.resumeData as
      | { answer?: string }
      | undefined;
    if (!resumeData?.answer) {
      return await context?.agent?.suspend({
        questions: ["需要确认什么？"],
      });
    }
    return { answer: resumeData.answer };
  },
});

function createHarness(dbFile: string) {
  const storage = new LibSQLStore({
    id: "qingagent-durable-test",
    url: `file:${dbFile}`,
  });
  const memory = new Memory({
    storage,
    options: {
      lastMessages: 20,
      semanticRecall: false,
      generateTitle: false,
    },
  });
  const agent = new Agent({
    id: "qingagent-durable-test-agent",
    name: "Qingagent Durable Test Agent",
    instructions: "Use askUser once, then finish after resume.",
    model: createDurableMockModel(),
    tools: { askUser: durableAskUserTool },
    memory,
  });
  const mastra = new Mastra({
    agents: { qingagentDurableTest: agent },
    storage,
    memory: { default: memory },
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
    docId: "durable-session",
    docState: { kind: "empty" },
    docVersion: 0,
    lastSyncedDocumentSnapshot: 0,
    legacySections: [],
    materials: [],
    title: "Durable session",
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

describe("askUser durable resume across fresh Mastra instances", () => {
  it("restores runId/toolCallId from thread metadata and resumes from LibSQL workflow snapshot", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "qingagent-durable-"));
    try {
      const dbFile = join(tempDir, "durable.db");
      // 影子双写已恒开:DATABASE_URL 指向临时库,双写天然隔离,无需再关。
      process.env.DATABASE_URL = `file:${dbFile}`;
      const migrations = await import("@qingagent/db/migrations");
      const documentsClient = await import("@qingagent/db/client");
      migrations.__resetMigrationsForTest();
      await migrations.runMigrations();
      documentsClient.__resetDocumentsClientForTest();
      migrations.__resetMigrationsForTest();

      const sessionId = "durable-session";
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
      expect(suspended.payload.toolCallId).toBe("call_durable_ask");

      const workflows = await first.storage.getStore("workflows");
      const snapshot = await workflows?.loadWorkflowSnapshot({
        workflowName: WORKFLOW_NAME,
        runId: firstStream.runId,
      });
      expect(snapshot).toBeTruthy();
      expect(snapshot?.status).toBe("suspended");

      vi.resetModules();
      const productForSeed = await import("../index.js");
      await productForSeed.getMemory().saveThread({
        thread: {
          id: sessionId,
          title: "Durable session",
          resourceId: RESOURCE_ID,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: metadata(firstStream.runId, suspended.payload.toolCallId) as unknown as Record<string, unknown>,
        },
      });

      vi.resetModules();
      const productAfterRestart = await import("../index.js");
      const second = createHarness(dbFile);
      void second.mastra;
      const restored = await productAfterRestart.loadSessionFromThread(sessionId);

      expect(restored?.runId).toBe(firstStream.runId);
      expect(restored?.toolCallId).toBe(suspended.payload.toolCallId);
      expect(restored?._suspensionOwner).toEqual({
        streamId: `restored:${firstStream.runId}`,
        runId: firstStream.runId,
        toolCallId: suspended.payload.toolCallId,
        toolName: "askUser",
      });
      expect(restored ? productAfterRestart.hasActiveSuspension(restored) : false)
        .toBe(true);
      const restoredTool = restored?.chatHistory[0]?.parts[0];
      expect(restoredTool).toMatchObject({
        kind: "toolCall",
        data: { status: { kind: "running" } },
      });

      const resumed = await second.agent.resumeStream(
        { answer: "答案A" },
        {
          runId: restored!.runId!,
          toolCallId: restored!.toolCallId ?? undefined,
          maxSteps: 4,
          memory: { thread: sessionId, resource: RESOURCE_ID },
        },
      );
      const resumedChunks = await collectChunks(resumed.fullStream);

      expect(JSON.stringify(resumedChunks)).toContain(
        "durable resumed from snapshot",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

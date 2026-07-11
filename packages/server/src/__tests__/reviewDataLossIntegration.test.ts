import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tableSelectionTextSignature,
  type BridgeFrame,
  type ChatChip,
  type Command,
  type LegacySection,
} from "@qingagent/contract-ts";
import {
  getPmContentHash,
  pmTableSelectionCellTexts,
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
} from "@qingagent/pm-schema";

const agentStream = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../core/src/mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => null,
    getAgent: () => ({}),
  },
  getObservability: () => null,
}));

vi.mock("../../../core/src/agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => undefined),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: agentStream, resumeStream: vi.fn() },
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
let tempDir = "";
let bridge: typeof import("../bridge/bridgeHandler");
let core: typeof import("@qingagent/core");
let resetDocumentsClientForTest: () => void;
let resetDocumentsSchemaForTest: () => void;

function paragraph(blockId: string, value: string): PmBlockNode {
  return { type: "paragraph", attrs: { blockId }, content: [{ type: "text", text: value }] };
}

function tableDoc(left: string, middle: string, right: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "table",
      attrs: { blockId: "table-a" },
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [paragraph("h-left", "列A")] },
            { type: "tableHeader", content: [paragraph("h-middle", "列B")] },
            { type: "tableHeader", content: [paragraph("h-right", "列C")] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph("c-left", left)] },
            { type: "tableCell", content: [paragraph("c-middle", middle)] },
            { type: "tableCell", content: [paragraph("c-right", right)] },
          ],
        },
      ],
    } as PmBlockNode],
  };
}

function nestedText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: unknown; text?: unknown; content?: unknown };
  if (value.type === "text" && typeof value.text === "string") return value.text;
  return Array.isArray(value.content) ? value.content.map(nestedText).join("") : "";
}

function tableTexts(doc: PmDoc | null | undefined): string[] {
  if (!doc) return [];
  const table = doc.content[0];
  if (table?.type !== "table") return [];
  const row = table.content[1];
  return row?.content.map(nestedText) ?? [];
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function updateDoc(sessionId: string, version: number, doc: PmDoc, mutation: string): Promise<void> {
  const command: Command = {
    kind: "updateDoc",
    data: {
      sessionId,
      expectedDocumentSnapshot: version,
      clientMutationId: mutation,
      doc,
      legacySections: pmToLegacySections(doc) as unknown as LegacySection[],
    },
  };
  const frames = await collectFrames(bridge.handleCommand(command));
  expect(frames).toContainEqual({
    kind: "docWriteResult",
    data: { ok: true, clientMutationId: mutation, docVersion: version + 1 },
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-review-data-loss-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "documents.db")}`;
  const documentsClient = await import("../../../core/src/db/documentsClient.js");
  resetDocumentsClientForTest = documentsClient.__resetDocumentsClientForTest;
  core = await import("@qingagent/core");
  resetDocumentsSchemaForTest = core.__resetMigrationsForTest;
  resetDocumentsClientForTest();
  resetDocumentsSchemaForTest();
  bridge = await import("../bridge/bridgeHandler");
});

afterAll(async () => {
  await core?.drainSessionPersistence().catch(() => undefined);
  resetDocumentsClientForTest?.();
  resetDocumentsSchemaForTest?.();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("审阅提交数据丢失 P0 真实命令链", () => {
  it("生成→updateDoc 手改→tableSelection editDraft turn→commit 同时保留手改与 AI patch", async () => {
    const startFrames = await collectFrames(bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }));
    const meta = startFrames.find((frame) => frame.kind === "sessionMeta");
    if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
    const sessionId = meta.data.sessionId;

    const generated = tableDoc("a1", "b1", "c1");
    await updateDoc(sessionId, 0, generated, `generated-${randomUUID()}`);
    const session = bridge.getSession(sessionId);
    if (!session) throw new Error("missing session");

    // 制造 turn1 遗留 candidate，验证真正的 server updateDoc 会将它清空。
    session.docDraftBaseDoc = generated;
    session.docDraftBaseVersion = 1;
    session.docDraftCandidateDoc = generated;
    await core.documentDraftRepo.saveCandidate({
      docId: session.docId,
      threadId: session.threadId ?? session.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(generated),
      draftPmDoc: generated,
      sourceStreamId: "turn-1",
      sourceToolCallId: "write-turn-1",
    });

    const manuallyEdited = tableDoc("用户手改保留", "b1", "c1");
    await updateDoc(sessionId, 1, manuallyEdited, `manual-${randomUUID()}`);
    expect(session.docDraftBaseDoc).toBeNull();
    expect(session.docDraftCandidateDoc).toBeNull();
    await expect(core.documentDraftRepo.load(session.docId)).resolves.toBeNull();

    const selection = { axis: "column" as const, startIndex: 1, endIndex: 1 };
    const selectedTexts = pmTableSelectionCellTexts(manuallyEdited, "table-a", selection);
    if (!selectedTexts) throw new Error("missing table selection");
    const chips: ChatChip[] = [{
      kind: { kind: "selection" },
      resourceRef: { id: "table-a", domain: { kind: "docSpan" } },
      prefix: null,
      label: selectedTexts.join("\n"),
      suffix: "表格·第2列",
      tableSelection: {
        ...selection,
        signature: tableSelectionTextSignature(selectedTexts),
      },
    }];
    const args = {
      ops: [{ action: "replaceText", find: "b1", replace: "AI 补丁", withinRef: "table-a" }],
    };
    agentStream.mockImplementationOnce(async (_messages: unknown[], options: Record<string, unknown>) => {
      const toolsets = options.toolsets as {
        sessionScoped: {
          editDraft: {
            execute: (input: typeof args, context: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        };
      };
      const result = await toolsets.sessionScoped.editDraft.execute(args, {});
      return {
        fullStream: (async function* () {
          yield { type: "tool-call", payload: { toolName: "editDraft", toolCallId: "edit-turn-2", args } };
          yield { type: "tool-result", payload: { toolName: "editDraft", toolCallId: "edit-turn-2", args, result } };
        })(),
        toolCalls: Promise.resolve([]),
      };
    });

    const turnFrames = await collectFrames(bridge.handleCommand({
      kind: "sendMessage",
      data: { sessionId, text: "修改选中的第二列", mentions: [], skills: [], chips, fileIds: [] },
    }));
    expect(agentStream).toHaveBeenCalledTimes(1);
    expect(turnFrames.some((frame) => frame.kind === "docDiffReady")).toBe(true);
    const patchIds = [...session.suggestions.keys()];
    expect(patchIds).toHaveLength(1);

    await collectFrames(bridge.handleCommand({ kind: "commitPatches", data: { ids: patchIds } }));

    expect(tableTexts(session.doc)).toEqual(["用户手改保留", "AI 补丁", "c1"]);
    const stored = await core.documentRepo.load(session.docId);
    expect(tableTexts(stored?.pmDoc ?? null)).toEqual(["用户手改保留", "AI 补丁", "c1"]);
  });
});

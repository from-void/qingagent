import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import type { ChatMessage } from "@qingagent/contract-ts";
import {
  aiIrToPm,
  getStablePmJson,
  markdownToPm,
  pmToAiIr,
  pmToMarkdown,
  pmToPlainText,
  safeParsePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
} from "@qingagent/pm-schema";
import { documentRepo } from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import { toDocx, toHtml, toPdf } from "@qingagent/doc-render";
import type { SessionState } from "../session/sessionState.js";
import type { QingagentThreadMetadata } from "../session/threadPersistence.js";
import { hasChromium } from "@qingagent/doc-render/testing";

const { memory, threads } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    saveThread: vi.fn(async ({ thread }: { thread: Record<string, unknown> }) => {
      threads.set(thread.id as string, thread);
    }),
    listThreads: vi.fn(async () => ({ threads: [], total: 0, hasMore: false })),
    updateThread: vi.fn(
      async ({
        id,
        title,
        metadata,
      }: {
        id: string;
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        const existing = threads.get(id) ?? {
          id,
          resourceId: "qingagent-user",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        threads.set(id, {
          ...existing,
          id,
          title,
          metadata,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      },
    ),
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => {
      return threads.get(threadId) ?? null;
    }),
    recall: vi.fn(async () => ({ messages: [] })),
  };
  return { memory, threads };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

vi.mock("../agent-run/agentSpans.js", () => ({
  sessionIdToTraceId: (sessionId: string) => `trace-${sessionId}`,
}));

const INLINE_ATOM_PLACEHOLDER = "\uFFFC";
const FAMILY_EMOJI = "👨‍👩‍👧‍👦";
const UNICODE_LATEX = String.raw`\sum_{项=1}^{n} α_项 + β^2 \quad \text{中文注释：均值≤方差}`;

let tempDb: TempDocumentsDb;

beforeEach(async () => {
  tempDb = prepareTempDocumentsDb("qingagent-rich-formats-persistence-");
  threads.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
  __resetSessionPersistenceForTest();
});

afterEach(async () => {
  const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
  __resetSessionPersistenceForTest();
  tempDb.cleanup();
});

function text(value: string): PmInlineNode {
  return { type: "text", text: value };
}

function inlineMath(latex: string): PmInlineNode {
  return { type: "inlineMath", attrs: { latex } };
}

function paragraph(blockId: string, content: string | PmInlineNode[]): Extract<PmBlockNode, { type: "paragraph" }> {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function taskList(
  blockId: string,
  items: Array<{ checked: boolean; content: string | PmInlineNode[] }>,
): Extract<PmBlockNode, { type: "taskList" }> {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, index) => ({
      type: "taskItem",
      attrs: { blockId: `${blockId}-item-${index + 1}`, checked: item.checked },
      content: [paragraph(`${blockId}-item-${index + 1}-p`, item.content)],
    })),
  };
}

function callout(
  blockId: string,
  content: string | PmInlineNode[],
  attrs: { emoji?: string | null; tone?: "info" | "success" | "warning" | "danger" | "neutral" | null } = {},
): Extract<PmBlockNode, { type: "callout" }> {
  return {
    type: "callout",
    attrs: { blockId, emoji: attrs.emoji ?? "ℹ️", tone: attrs.tone ?? "info" },
    content: [paragraph(`${blockId}-p`, content)],
  };
}

function blockMath(blockId: string, latex: string): Extract<PmBlockNode, { type: "blockMath" }> {
  return {
    type: "blockMath",
    attrs: { blockId, latex },
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function cloneDoc(value: PmDoc): PmDoc {
  return JSON.parse(JSON.stringify(value)) as PmDoc;
}

function chatMessage(id: string): ChatMessage {
  return {
    id,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "text", data: { body: "已恢复富格式文档" } }],
    chips: null,
  };
}

function richPersistenceDoc(): PmDoc {
  return doc([
    paragraph("persist-intro", [
      text("恢复前 "),
      inlineMath(String.raw`a^2+b^2=c^2`),
      text(" 恢复后"),
    ]),
    taskList("persist-tasks", [
      { checked: true, content: "完成恢复链路" },
      { checked: false, content: [text("检查 "), inlineMath(String.raw`\Delta t`), text(" 版本")] },
    ]),
    callout("persist-callout", "恢复时 callout 不应退化", { emoji: FAMILY_EMOJI, tone: "warning" }),
    blockMath("persist-math", UNICODE_LATEX),
  ]);
}

function largeRichDoc(): PmDoc {
  const blocks: PmBlockNode[] = [];
  for (let group = 0; group < 50; group += 1) {
    blocks.push(taskList(`large-task-${group}`, Array.from({ length: 4 }, (_, index) => ({
      checked: (group + index) % 2 === 0,
      content: [
        text(`任务 ${group}-${index} `),
        inlineMath(String.raw`x_${group}_${index}`),
        text(" / "),
        inlineMath(String.raw`y_${group}_${index}`),
        text(" / "),
        inlineMath(String.raw`z_${group}_${index}`),
      ],
    }))));
    blocks.push(blockMath(`large-math-${group}`, String.raw`\int_{${group}}^{${group + 1}} f(x)\,dx = ${group}`));
    blocks.push(callout(`large-callout-${group}`, [
      text(`提示 ${group} `),
      inlineMath(String.raw`\alpha_${group}`),
      text(" + "),
      inlineMath(String.raw`\beta_${group}`),
      text(" = "),
      inlineMath(String.raw`\gamma_${group}`),
    ], { emoji: group % 2 === 0 ? "ℹ️" : "✅", tone: group % 2 === 0 ? "info" : "success" }));
  }
  return doc(blocks);
}

function replaceSingleTaskText(value: PmDoc): PmDoc {
  const next = cloneDoc(value);
  const taskBlock = next.content.find((block) => block.attrs.blockId === "large-task-25");
  expect(taskBlock?.type).toBe("taskList");
  if (taskBlock?.type !== "taskList") return next;
  const paragraphNode = taskBlock.content[2]?.content[0];
  expect(paragraphNode?.type).toBe("paragraph");
  if (paragraphNode?.type !== "paragraph") return next;
  const firstText = paragraphNode.content?.[0];
  expect(firstText?.type).toBe("text");
  if (firstText?.type === "text") {
    firstText.text = "任务 25-2 已调整 ";
  }
  return next;
}

function bindRichDoc(state: SessionState, value: PmDoc): void {
  state.doc = value;
  state.docState = { kind: "editing" };
}

describe("rich formats persistence and scale pressure", () => {
  it("threadPersistence 通过 thread.metadata 恢复富格式 doc,docVersion 与 chatHistory 不丢", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const { loadSessionFromThread, persistSessionMetadata } = await import("../session/threadPersistence.js");
    const state = createSession("rich-persist-session");
    const richDoc = richPersistenceDoc();
    const expectedBytes = getStablePmJson(richDoc);
    const message: CoreMessage = { role: "user", content: "请保留这些富格式块" };
    state.docId = "doc-rich-persist";
    state.threadId = state.sessionId;
    state.title = "富格式恢复";
    state.docVersion = 17;
    state.lastSyncedDocumentSnapshot = 16;
    state.messages = [message];
    state.chatHistory = [chatMessage("chat-rich-1")];
    bindRichDoc(state, richDoc);

    await persistSessionMetadata(state);
    const persisted = threads.get(state.sessionId)?.metadata as QingagentThreadMetadata | undefined;
    expect(persisted?.doc).toBeDefined();
    expect(getStablePmJson(persisted?.doc)).toBe(expectedBytes);

    vi.spyOn(documentRepo, "load").mockResolvedValue(null);
    const restored = await loadSessionFromThread(state.sessionId);

    expect(documentRepo.load).toHaveBeenCalledWith("doc-rich-persist");
    expect(restored?.docVersion).toBe(17);
    expect(restored?.lastSyncedDocumentSnapshot).toBe(16);
    expect(restored?.chatHistory).toEqual(state.chatHistory);
    expect(restored?.messages).toEqual([message]);
    expect(getStablePmJson(restored?.doc)).toBe(expectedBytes);
    expect(safeParsePmDoc(restored?.doc).success).toBe(true);
  });

  // DOCX 导出含 50+ blockMath + 150+ inlineMath,需要 Chromium 批量截图渲染公式图片,给足时间。
  it("规模压力:大富格式文档 AI-IR 往返 <2s,导出成功,单点改动 diff 不爆 hunk", async () => {
    const base = largeRichDoc();
    expect(base.content).toHaveLength(150);
    const taskItemCount = base.content
      .filter((block): block is Extract<PmBlockNode, { type: "taskList" }> => block.type === "taskList")
      .reduce((sum, block) => sum + block.content.length, 0);
    expect(taskItemCount).toBe(200);
    expect(base.content.filter((block) => block.type === "blockMath")).toHaveLength(50);
    expect(base.content.filter((block) => block.type === "callout")).toHaveLength(50);

    const start = performance.now();
    const roundTrip = aiIrToPm(pmToAiIr(base));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(safeParsePmDoc(roundTrip).success).toBe(true);

    await expect(toDocx(base, { title: "规模压力" })).resolves.toSatisfy(
      (buffer: unknown) => Buffer.isBuffer(buffer) && buffer.subarray(0, 2).toString("utf8") === "PK" && buffer.length > 1_000,
    );
    // HTML 序列化(纯函数)对大文档不崩、且承载内容;真实 PDF 字节仅在有 Chromium 时核验。
    expect(toHtml(base, { title: "规模压力" }).length).toBeGreaterThan(1_000);
    if (hasChromium) {
      await expect(toPdf(base, { title: "规模压力" })).resolves.toSatisfy(
        (buffer: unknown) => Buffer.isBuffer(buffer) && buffer.subarray(0, 4).toString("utf8") === "%PDF" && buffer.length > 1_000,
      );
    }

    const changed = replaceSingleTaskText(base);
    const hunks = buildDraftDiff(base, changed);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      blockPath: [75],
      anchor: { blockId: "large-task-25" },
    });
    expect(hunks[0]?.beforeText).toContain("任务 25-2");
    expect(hunks[0]?.afterText).toContain("任务 25-2 已调整");
  });

  it("极端字符:unicode latex、多码点 emoji、字面 U+FFFC 不与 inlineMath 占位符串扰", async () => {
    const extreme = doc([
      paragraph("extreme-inline", [
        text(`字面占位 ${INLINE_ATOM_PLACEHOLDER} 前 `),
        inlineMath(String.raw`\sqrt{二}+α≤β`),
        text(" 后"),
      ]),
      callout("extreme-callout", [
        text("家庭 emoji "),
        inlineMath(String.raw`E=mc^2`),
        text(` 与字面 ${INLINE_ATOM_PLACEHOLDER}`),
      ], { emoji: FAMILY_EMOJI, tone: "warning" }),
      taskList("extreme-task", [
        { checked: false, content: `任务文本含字面 ${INLINE_ATOM_PLACEHOLDER} 字符` },
      ]),
      blockMath("extreme-math", UNICODE_LATEX),
    ]);

    expect(safeParsePmDoc(extreme).success).toBe(true);
    const plain = pmToPlainText(extreme);
    const markdown = pmToMarkdown(extreme);
    const docx = await toDocx(extreme, { title: "极端字符" });

    expect(plain).toContain(`字面占位 ${INLINE_ATOM_PLACEHOLDER} 前 \\sqrt{二}+α≤β 后`);
    expect(plain).toContain(`任务文本含字面 ${INLINE_ATOM_PLACEHOLDER} 字符`);
    expect(plain).toContain(UNICODE_LATEX);
    expect(markdown).toContain(`> ${FAMILY_EMOJI} 家庭 emoji $E=mc^2$ 与字面 ${INLINE_ATOM_PLACEHOLDER}`);
    expect(markdown).toContain(`- [ ] 任务文本含字面 ${INLINE_ATOM_PLACEHOLDER} 字符`);
    expect(markdown).toContain(`$$\n${UNICODE_LATEX}\n$$`);
    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");

    const roundTrip = aiIrToPm(pmToAiIr(extreme));
    const originalLiteralCount = (plain.match(/\uFFFC/g) ?? []).length;
    const roundTripPlain = pmToPlainText(roundTrip);
    expect((roundTripPlain.match(/\uFFFC/g) ?? []).length).toBe(originalLiteralCount);
    expect(roundTripPlain).toContain(String.raw`\sqrt{二}+α≤β`);
    expect(safeParsePmDoc(roundTrip).success).toBe(true);
  });

  it("markdownToPm 解析 taskList 并解析 $$ 数学块", () => {
    const imported = markdownToPm([
      "- [x] 已完成 task",
      "- [ ] 未完成 task",
      "",
      "$$",
      String.raw`\sum_{i=1}^{n} i`,
      "$$",
    ].join("\n"));

    expect(safeParsePmDoc(imported).success).toBe(true);
    expect(imported.content.map((block) => block.type)).toEqual([
      "taskList",
      "blockMath",
    ]);
    expect(imported.content[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: true }),
          content: [{ type: "paragraph", content: [{ type: "text", text: "已完成 task" }] }],
        },
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: false }),
          content: [{ type: "paragraph", content: [{ type: "text", text: "未完成 task" }] }],
        },
      ],
    });
    expect(imported.content[1]).toMatchObject({ type: "blockMath", attrs: { latex: String.raw`\sum_{i=1}^{n} i` } });
  });
});

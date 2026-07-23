import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeFrame, Command, LegacySection } from "@qingagent/contract-ts";
import { getPmContentHash, type PmBlockNode, type PmDoc, type PmInlineNode } from "@qingagent/pm-schema";

const originalDatabaseUrl = process.env.DATABASE_URL;

let tempDir = "";
let app: (typeof import("../app"))["app"];
let core: typeof import("@qingagent/core");
let validateCommandKind: (typeof import("../routes/stream"))["validateCommandKind"];
let resetDocumentsClientForTest: () => void;
let resetDocumentsSchemaForTest: () => void;

type DocWriteFrame = Extract<BridgeFrame, { kind: "docWriteResult" }>;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-rich-formats-bridge-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "bridge.db")}`;

  const documentsClient = await import("@qingagent/db/client");
  resetDocumentsClientForTest = documentsClient.__resetDocumentsClientForTest;
  core = await import("@qingagent/core");
  resetDocumentsSchemaForTest = core.__resetMigrationsForTest;
  resetDocumentsClientForTest();
  resetDocumentsSchemaForTest();

  ({ app } = await import("../app"));
  ({ validateCommandKind } = await import("../routes/stream"));
});

afterAll(async () => {
  await core?.drainSessionPersistence().catch(() => undefined);
  resetDocumentsClientForTest?.();
  resetDocumentsSchemaForTest?.();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("rich formats HTTP bridge E2E", () => {
  it("POST /api/v1/stream updateDoc accepts a legal PM doc with all new rich blocks", async () => {
    const sessionId = await seedRestoredSession("合法富格式桥接", baseDoc("bridge-legal-base"));

    const mutationId = `mutation-${randomUUID()}`;
    const { res, frames } = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 1,
      clientMutationId: mutationId,
      doc: richPmDoc("legal"),
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(findDocWriteFrame(frames, mutationId).data).toEqual({
      ok: true,
      clientMutationId: mutationId,
      docVersion: 2,
    });
  });

  it.each([
    {
      name: "taskItem.checked 为字符串",
      doc: doc([
        {
          type: "taskList",
          attrs: { blockId: "invalid-task-list" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "invalid-task-item", checked: "yes" },
              content: [paragraph("invalid-task-item-p", [text("checked 类型错误")])],
            },
          ],
        },
      ] as unknown as PmBlockNode[]),
      pathHints: ["content", "attrs", "checked"],
    },
    {
      name: "callout.tone 非法",
      doc: doc([
        {
          type: "callout",
          attrs: { blockId: "invalid-callout", tone: "urgent", emoji: "!" },
          content: [paragraph("invalid-callout-p", [text("非法 tone")])],
        },
      ] as unknown as PmBlockNode[]),
      pathHints: ["content", "attrs", "tone"],
    },
    {
      name: "blockMath.attrs.latex 为数字",
      doc: doc([
        {
          type: "blockMath",
          attrs: { blockId: "invalid-block-math", latex: 42 },
        },
      ] as unknown as PmBlockNode[]),
      pathHints: ["content", "attrs", "latex"],
    },
    {
      name: "inlineMath 缺 attrs",
      doc: doc([
        paragraph("invalid-inline-math-p", [
          text("公式 "),
          { type: "inlineMath" } as unknown as PmInlineNode,
        ]),
      ]),
      pathHints: ["content", "attrs"],
    },
  ])("POST /api/v1/stream updateDoc rejects illegal rich PM variant: $name", async ({ doc: invalidDoc, pathHints }) => {
    const res = await request("POST", "/api/v1/stream", updateDocCommand({
      sessionId: "session-for-request-validation",
      expectedDocumentSnapshot: 1,
      clientMutationId: `mutation-${randomUUID()}`,
      doc: invalidDoc,
    }));

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("updateDoc.data.doc");
    for (const hint of pathHints) {
      expect(json.error).toContain(hint);
    }
  });

  it("双标签 coalesce 窗口内整篇写入走 conflict 提示且不覆盖先写内容", async () => {
    const sessionId = await seedRestoredSession("版本冲突桥接", baseDoc("bridge-conflict-base"));
    const firstDoc = richPmDoc("conflict-first");
    const staleDoc = richPmDoc("conflict-stale");

    const firstMutationId = `mutation-${randomUUID()}`;
    const first = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 1,
      clientMutationId: firstMutationId,
      doc: firstDoc,
    }));
    expect(first.res.status).toBe(200);
    expect(findDocWriteFrame(first.frames, firstMutationId).data).toEqual({
      ok: true,
      clientMutationId: firstMutationId,
      docVersion: 2,
    });

    const staleMutationId = `mutation-${randomUUID()}`;
    const stale = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 1,
      clientMutationId: staleMutationId,
      doc: staleDoc,
    }));

    expect(stale.res.status).toBe(200);
    expect(findDocWriteFrame(stale.frames, staleMutationId).data).toEqual({
      ok: false,
      clientMutationId: staleMutationId,
      conflict: {
        expectedDocumentSnapshot: 1,
        actualDocumentSnapshot: 2,
      },
    });
    await expect(core.documentRepo.load(sessionId)).resolves.toMatchObject({
      docVersion: 2,
      pmDoc: firstDoc,
    });
    await expect(core.listVersions(sessionId)).resolves.toMatchObject([
      { docVersion: 2, snapshotPm: firstDoc },
    ]);
  });

  it("同版本号但基线正文哈希不同的 updateDoc 被拒绝且不覆盖先写内容", async () => {
    const baselineDoc = baseDoc("bridge-same-version-base");
    const sessionId = await seedRestoredSession("同号异容冲突桥接", baselineDoc);
    const firstDoc = richPmDoc("same-version-first");
    const linkedButStaleDoc = richPmDoc("same-version-stale");

    const firstMutationId = `mutation-${randomUUID()}`;
    const first = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 1,
      baseContentHash: getPmContentHash(baselineDoc),
      clientMutationId: firstMutationId,
      doc: firstDoc,
    }));
    expect(findDocWriteFrame(first.frames, firstMutationId).data).toEqual({
      ok: true,
      clientMutationId: firstMutationId,
      docVersion: 2,
    });

    const staleMutationId = `mutation-${randomUUID()}`;
    const stale = await postStream(updateDocCommand({
      sessionId,
      // 数字恰好接上版本 2，但正文基线仍是版本 1。
      expectedDocumentSnapshot: 2,
      baseContentHash: getPmContentHash(baselineDoc),
      clientMutationId: staleMutationId,
      doc: linkedButStaleDoc,
    }));

    expect(stale.res.status).toBe(200);
    expect(findDocWriteFrame(stale.frames, staleMutationId).data).toEqual({
      ok: false,
      clientMutationId: staleMutationId,
      conflict: {
        expectedDocumentSnapshot: 2,
        actualDocumentSnapshot: 2,
      },
    });
    await expect(core.documentRepo.load(sessionId)).resolves.toMatchObject({
      docVersion: 2,
      pmDoc: firstDoc,
    });
  });

  it("POST /api/v1/stream persists A→B→A undo with distinct mutation ids", async () => {
    const sessionId = await seedRestoredSession("撤销持久化桥接", baseDoc("undo-base"));
    const aDoc = doc([paragraph("undo-paragraph", [text("A")])]);
    const bDoc = doc([paragraph("undo-paragraph", [text("B")])]);
    const writes = [
      { expectedDocumentSnapshot: 1, clientMutationId: `mutation-${randomUUID()}`, doc: aDoc },
      { expectedDocumentSnapshot: 2, clientMutationId: `mutation-${randomUUID()}`, doc: bDoc },
      { expectedDocumentSnapshot: 3, clientMutationId: `mutation-${randomUUID()}`, doc: aDoc },
    ];

    for (const [index, write] of writes.entries()) {
      const { res, frames } = await postStream(updateDocCommand({ sessionId, ...write }));
      expect(res.status).toBe(200);
      expect(findDocWriteFrame(frames, write.clientMutationId).data).toEqual({
        ok: true,
        clientMutationId: write.clientMutationId,
        docVersion: index + 2,
      });
    }

    await expect(core.documentRepo.load(sessionId)).resolves.toMatchObject({
      docVersion: 4,
      pmDoc: aDoc,
    });
    const versions = await core.listVersions(sessionId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ docVersion: 4, snapshotPm: aDoc });
  });

  it("GET /api/v1/export/:sessionId exports rich PM docs as DOCX and PDF binaries", async () => {
    const sessionId = await seedRestoredSession("富格式导出桥接", richPmDoc("export"));

    const docx = await request("GET", `/api/v1/export/${sessionId}?format=docx`);
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(bytesStartWith(await responseBytes(docx), [0x50, 0x4b])).toBe(true);

    const pdf = await request("GET", `/api/v1/export/${sessionId}?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(bytesStartWith(await responseBytes(pdf), [0x25, 0x50, 0x44, 0x46])).toBe(true);
  });

  it("validateCommandKind covers updateDoc doc and legacySections validation branches", () => {
    expect(validateCommandKind(updateDocCommand({
      sessionId: "validate-doc-ok",
      expectedDocumentSnapshot: 1,
      clientMutationId: "validate-mutation-doc-ok",
      doc: richPmDoc("validate"),
    }))).toBeNull();

    expect(validateCommandKind({
      kind: "updateDoc",
      data: {
        sessionId: "validate-legacy-ok",
        expectedDocumentSnapshot: 1,
        clientMutationId: "validate-mutation-legacy-ok",
        legacySections: [{ kind: "p", data: { text: "legacy 正文" } }],
      },
    })).toBeNull();

    const invalidDocError = validateCommandKind(updateDocCommand({
      sessionId: "validate-doc-bad",
      expectedDocumentSnapshot: 1,
      clientMutationId: "validate-mutation-doc-bad",
      doc: doc([
        paragraph("validate-invalid-inline-math", [
          text("坏公式 "),
          { type: "inlineMath" } as unknown as PmInlineNode,
        ]),
      ]),
    }));
    expect(invalidDocError).toContain("updateDoc.data.doc");
    expect(invalidDocError).toContain("attrs");

    const missingDocumentError = validateCommandKind({
      kind: "updateDoc",
      data: {
        sessionId: "validate-missing-doc",
        expectedDocumentSnapshot: 1,
        clientMutationId: "validate-mutation-missing-doc",
      },
    });
    expect(missingDocumentError).toContain("updateDoc.data.legacySections must be an array");
  });
});

async function seedRestoredSession(title: string, pmDoc: PmDoc): Promise<string> {
  const sessionId = `rich-bridge-${randomUUID()}`;
  const now = new Date("2026-06-12T00:00:00.000Z");
  const nowIso = now.toISOString();

  await core.getMemory().saveThread({
    thread: {
      id: sessionId,
      title,
      resourceId: core.QINGAGENT_RESOURCE_ID,
      createdAt: now,
      updatedAt: now,
      metadata: {
        docId: sessionId,
        docState: { kind: "editing" },
        docVersion: 1,
        lastSyncedDocumentSnapshot: 1,
        legacySections: [],
        doc: pmDoc,
        materials: [],
        title,
        runId: null,
        toolCallId: null,
        askUserCompleted: true,
        lastPersistedAt: nowIso,
      },
    },
  });

  await core.documentRepo.save({
    id: sessionId,
    threadId: sessionId,
    resourceId: core.QINGAGENT_RESOURCE_ID,
    title,
    docState: "editing",
    docVersion: 1,
    lastSyncedVersion: 1,
    pmDoc,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const { res, frames, body } = await postStream({
    kind: "startSession",
    data: { mode: { kind: "existing", data: { id: sessionId } } },
  });
  expect(res.status, body).toBe(200);
  expect(frames).toContainEqual({
    kind: "sessionMeta",
    data: { sessionId, title },
  });

  return sessionId;
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

async function postStream(command: Command): Promise<{
  res: Response;
  frames: BridgeFrame[];
  body: string;
}> {
  const res = await request("POST", "/api/v1/stream", command);
  const body = await res.text();
  if (!res.ok) return { res, body, frames: [] };
  const parsed = JSON.parse(body) as unknown;
  if (Array.isArray(parsed)) {
    return { res, body, frames: parsed as BridgeFrame[] };
  }
  if (isAcceptedCommandResponse(parsed)) {
    const frames = parsed.sessionId
      ? await readEventFramesUntil(parsed.sessionId, "sessionMeta", parsed.epoch)
      : [];
    return { res, body, frames };
  }
  return { res, body, frames: [] };
}

function isAcceptedCommandResponse(value: unknown): value is {
  accepted: true;
  sessionId?: string;
  epoch?: number;
} {
  return value !== null && typeof value === "object" && (value as { accepted?: unknown }).accepted === true;
}

async function readEventFramesUntil(
  sessionId: string,
  needle: string,
  epoch?: number,
): Promise<BridgeFrame[]> {
  const controller = new AbortController();
  const query = new URLSearchParams({ sessionId, after: "0" });
  if (epoch !== undefined) query.set("epoch", String(epoch));
  const res = await app.request(`/api/v1/events?${query.toString()}`, {
    method: "GET",
    signal: controller.signal,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("events response has no body");
  const decoder = new TextDecoder();
  const frames: BridgeFrame[] = [];
  let body = "";
  let raw = "";
  const deadline = Date.now() + 2_000;
  while (!raw.includes(needle)) {
    if (Date.now() > deadline) {
      controller.abort();
      throw new Error(`Timed out waiting for event frame: ${needle}`);
    }
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 50);
      }),
    ]);
    if (next.done) break;
    if (next.value.length === 0) continue;
    const chunk = decoder.decode(next.value, { stream: true });
    raw += chunk;
    body += chunk;
    const lines = body.split("\n");
    body = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      frames.push(JSON.parse(line.slice("data: ".length)) as BridgeFrame);
    }
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return frames;
}

function findDocWriteFrame(frames: BridgeFrame[], clientMutationId: string): DocWriteFrame {
  const frame = frames.find(
    (item): item is DocWriteFrame =>
      item.kind === "docWriteResult" && item.data.clientMutationId === clientMutationId,
  );
  if (!frame) {
    throw new Error(`missing docWriteResult for ${clientMutationId}: ${JSON.stringify(frames)}`);
  }
  return frame;
}

function updateDocCommand(input: {
  sessionId: string;
  expectedDocumentSnapshot: number;
  baseContentHash?: string;
  clientMutationId: string;
  doc: PmDoc;
}): Command {
  return {
    kind: "updateDoc",
    data: {
      sessionId: input.sessionId,
      expectedDocumentSnapshot: input.expectedDocumentSnapshot,
      baseContentHash: input.baseContentHash,
      clientMutationId: input.clientMutationId,
      doc: input.doc,
    },
  };
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function bytesStartWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function baseDoc(namespace: string): PmDoc {
  return doc([
    paragraph(`${namespace}-p`, [text("初始正文")]),
  ]);
}

function richPmDoc(namespace: string): PmDoc {
  return doc([
    {
      type: "heading",
      attrs: { blockId: `${namespace}-heading`, level: 2, textAlign: "center" },
      content: [text("富格式 HTTP 桥接验收")],
    },
    paragraph(`${namespace}-inline`, [
      text("行内公式 "),
      inlineMath(String.raw`E=mc^2`),
      text(String.raw` 与路径 C:\drafts\alpha 混排。`),
    ]),
    {
      type: "taskList",
      attrs: { blockId: `${namespace}-tasks` },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: `${namespace}-task-done`, checked: true },
          content: [
            paragraph(`${namespace}-task-done-p`, [
              text("已完成：桥接写入 "),
              inlineMath("a+b"),
            ]),
          ],
        },
        {
          type: "taskItem",
          attrs: { blockId: `${namespace}-task-open`, checked: false },
          content: [
            paragraph(`${namespace}-task-open-p`, [
              text("待处理：导出二进制头校验 | 保留反斜杠"),
            ]),
          ],
        },
      ],
    },
    {
      type: "callout",
      attrs: { blockId: `${namespace}-callout`, tone: "warning", emoji: "!" },
      content: [
        paragraph(`${namespace}-callout-p1`, [
          text("风险提示："),
          inlineMath(String.raw`\Delta v`),
          text(" 需要复核。"),
        ]),
        paragraph(`${namespace}-callout-p2`, [text("第二段提示用于覆盖 callout 多段落。")]),
      ],
    },
    {
      type: "blockMath",
      attrs: {
        blockId: `${namespace}-block-math`,
        latex: String.raw`\int_0^1 x^2 dx = \frac{1}{3}`,
      },
    },
  ]);
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function paragraph(blockId: string, content: PmInlineNode[]): Extract<PmBlockNode, { type: "paragraph" }> {
  return { type: "paragraph", attrs: { blockId }, content };
}

function text(value: string): PmInlineNode {
  return { type: "text", text: value };
}

function inlineMath(latex: string): PmInlineNode {
  return { type: "inlineMath", attrs: { latex } };
}

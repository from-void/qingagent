import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command, LegacySection } from "@qingagent/contract-ts";
import {
  applyEdit,
  carryOverDiagramOverlay,
  dissolveSubgraph,
  moveNodeToSubgraph,
  parseDiagram,
  renameSubgraph,
  wrapNodesInSubgraph,
  type DiagramOverlay,
  type FlowGraph,
  type RewriteResult,
} from "@qingagent/diagram-engine";
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

  it("agent 插入后拒绝持旧空稿基线的 updateDoc，权威正文不被空稿覆盖", async () => {
    const emptyClientDoc = doc([paragraph("empty-client-p", [])]);
    const sessionId = `agent-empty-race-${randomUUID()}`;
    const created = await postStream({
      kind: "startSession",
      data: { mode: { kind: "new", data: { sessionId, template: null } } },
    });
    expect(created.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "sessionMeta",
        data: expect.objectContaining({ sessionId }),
      }),
    ]));
    const agentMutationId = `agent-${randomUUID()}`;
    const agentWrite = await postStream({
      kind: "externalPropose",
      data: {
        sessionId,
        expectedDocVersion: 0,
        clientMutationId: agentMutationId,
        ops: [{
          kind: "fullDraft",
          markdown: "Agent 已插入流程图正文",
        }],
      },
    });
    expect(findDocWriteFrame(agentWrite.frames, agentMutationId).data).toEqual({
      ok: true,
      clientMutationId: agentMutationId,
      docVersion: 1,
    });
    const agentPersisted = await core.documentRepo.load(sessionId);
    expect(agentPersisted?.docVersion).toBe(1);
    expect(JSON.stringify(agentPersisted?.pmDoc)).toContain("Agent 已插入流程图正文");

    const mutationId = `mutation-${randomUUID()}`;
    const stale = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 0,
      clientMutationId: mutationId,
      doc: emptyClientDoc,
    }));

    expect(findDocWriteFrame(stale.frames, mutationId).data).toEqual({
      ok: false,
      clientMutationId: mutationId,
      conflict: {
        expectedDocumentSnapshot: 0,
        actualDocumentSnapshot: 1,
      },
    });
    await expect(core.documentRepo.load(sessionId)).resolves.toMatchObject({
      docVersion: 1,
      pmDoc: agentPersisted?.pmDoc,
    });
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

  it("画布连续语义操作逐步落库 source，嵌套归属/改名/连线/移动/解散/撤销均以服务端为准", async () => {
    const baselineSource = [
      "flowchart TD",
      "  U1[未归属]",
      "  U2[目标]",
    ].join("\n");
    let persistedDoc = canvasDiagramDoc(baselineSource);
    let clientCanonicalDoc = persistedDoc;
    const sessionId = await seedRestoredSession("画布连续写回", persistedDoc);
    let expectedVersion = 1;

    const persistStep = async (
      label: string,
      nextDoc: PmDoc,
    ): Promise<PmDoc> => {
      const clientMutationId = `canvas-${label}-${randomUUID()}`;
      const { res, frames } = await postStream(updateDocCommand({
        sessionId,
        expectedDocumentSnapshot: expectedVersion,
        // 模拟浏览器 ACK 后以“实际发出的内存 PM 文档”推进下一笔基线。
        // 若其中混入 undefined，而 JSON 线传输删除了该键，下一笔就会在同版本撞哈希。
        baseContentHash: getPmContentHash(clientCanonicalDoc),
        clientMutationId,
        doc: nextDoc,
      }));
      expect(res.status, label).toBe(200);
      const result = findDocWriteFrame(frames, clientMutationId);
      expect(result.data.ok, label).toBe(true);
      if (!result.data.ok) throw new Error(`${label} 保存冲突`);
      expectedVersion = result.data.docVersion;
      const stored = await core.documentRepo.load(sessionId);
      expect(stored?.docVersion, label).toBe(expectedVersion);
      expect(stored?.pmDoc, label).toEqual(
        JSON.parse(JSON.stringify(nextDoc)),
      );
      clientCanonicalDoc = nextDoc;
      persistedDoc = stored!.pmDoc!;
      return persistedDoc;
    };

    const outer = mustRewrite(
      wrapNodesInSubgraph(baselineSource, [], "外层"),
      "建外层空分区",
    );
    await persistStep("create-outer", canvasDiagramDoc(outer.source));
    expect(serverDiagramSource(persistedDoc)).toBe(outer.source);

    const movedOuter = mustRewrite(
      moveNodeToSubgraph(serverDiagramSource(persistedDoc), "U1", outer.newSubgraphId!),
      "拖入外层",
    );
    await persistStep("move-outer", canvasDiagramDoc(movedOuter.source));
    expect(serverFlowModel(persistedDoc).nodes.find((node) => node.id === "U1")?.scopePath)
      .toEqual([outer.newSubgraphId]);

    const inner = mustRewrite(
      wrapNodesInSubgraph(
        serverDiagramSource(persistedDoc),
        [],
        "内层",
        outer.newSubgraphId,
      ),
      "建嵌套分区",
    );
    await persistStep("create-inner", canvasDiagramDoc(inner.source));

    const movedInner = mustRewrite(
      moveNodeToSubgraph(serverDiagramSource(persistedDoc), "U1", inner.newSubgraphId!),
      "拖入最深层",
    );
    await persistStep("move-inner", canvasDiagramDoc(movedInner.source));
    expect(serverFlowModel(persistedDoc).nodes.find((node) => node.id === "U1")?.scopePath)
      .toEqual([outer.newSubgraphId, inner.newSubgraphId]);

    const renamed = mustRewrite(
      renameSubgraph(serverDiagramSource(persistedDoc), inner.newSubgraphId!, "发布内层"),
      "双击改名",
    );
    await persistStep("rename-inner", canvasDiagramDoc(renamed.source));
    expect(serverFlowModel(persistedDoc).subgraphs.find((item) => item.id === inner.newSubgraphId)?.label)
      .toBe("发布内层");

    const connected = mustRewrite(
      applyEdit(serverDiagramSource(persistedDoc), {
        kind: "connectEdge",
        source: "U1",
        target: "U2",
      }),
      "把手建边",
    );
    await persistStep("connect-edge", canvasDiagramDoc(connected.source));
    expect(serverFlowModel(persistedDoc).edges.some(
      (edge) => edge.source === "U1" && edge.target === "U2",
    )).toBe(true);

    const movedOverlay = {
      positions: {
        U1: { x: 220, y: 160 },
      },
    };
    await persistStep(
      "move-subgraph",
      canvasDiagramDoc(serverDiagramSource(persistedDoc), movedOverlay),
    );
    expect(serverDiagramOverlay(persistedDoc)).toEqual(movedOverlay);

    const beforeDissolve = persistedDoc;
    const dissolved = mustRewrite(
      dissolveSubgraph(serverDiagramSource(persistedDoc), inner.newSubgraphId!),
      "解散内层",
    );
    const dissolvedOverlay = carryOverDiagramOverlay(
      serverDiagramSource(persistedDoc),
      movedOverlay,
      dissolved.source,
    );
    await persistStep(
      "dissolve-inner",
      canvasDiagramDoc(dissolved.source, dissolvedOverlay),
    );
    expect(serverFlowModel(persistedDoc).subgraphs.some(
      (item) => item.id === inner.newSubgraphId,
    )).toBe(false);
    expect(serverFlowModel(persistedDoc).nodes.find((node) => node.id === "U1")?.scopePath)
      .toEqual([outer.newSubgraphId]);

    await persistStep("undo-dissolve", beforeDissolve);
    expect(serverFlowModel(persistedDoc).subgraphs.find(
      (item) => item.id === inner.newSubgraphId,
    )?.label).toBe("发布内层");
    expect(serverFlowModel(persistedDoc).nodes.find((node) => node.id === "U1")?.scopePath)
      .toEqual([outer.newSubgraphId, inner.newSubgraphId]);
  });

  it("空分区建后解散经真实保存与 Markdown 导出可字节级回到基线", async () => {
    const baselineSource = [
      "flowchart TD",
      "  A[甲]",
      "  %% trailing comment keep",
      "",
    ].join("\n");
    let persistedDoc = canvasDiagramDoc(baselineSource);
    const sessionId = await seedRestoredSession("画布空行 round-trip", persistedDoc);
    const baselineExport = await request(
      "GET",
      `/api/v1/export/${sessionId}?format=markdown`,
    ).then((response) => response.text());

    const wrapped = mustRewrite(
      wrapNodesInSubgraph(baselineSource, [], "临时分区"),
      "建空分区",
    );
    const wrappedMutationId = `canvas-wrap-${randomUUID()}`;
    const wrappedWrite = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: 1,
      baseContentHash: getPmContentHash(persistedDoc),
      clientMutationId: wrappedMutationId,
      doc: canvasDiagramDoc(wrapped.source),
    }));
    const wrappedResult = findDocWriteFrame(wrappedWrite.frames, wrappedMutationId);
    expect(wrappedResult.data.ok).toBe(true);
    if (!wrappedResult.data.ok) throw new Error("建空分区保存冲突");
    persistedDoc = (await core.documentRepo.load(sessionId))!.pmDoc!;
    expect(serverDiagramSource(persistedDoc)).toBe(wrapped.source);

    const dissolved = mustRewrite(
      dissolveSubgraph(serverDiagramSource(persistedDoc), wrapped.newSubgraphId!),
      "解散空分区",
    );
    const dissolvedMutationId = `canvas-dissolve-${randomUUID()}`;
    const dissolvedWrite = await postStream(updateDocCommand({
      sessionId,
      expectedDocumentSnapshot: wrappedResult.data.docVersion,
      baseContentHash: getPmContentHash(persistedDoc),
      clientMutationId: dissolvedMutationId,
      doc: canvasDiagramDoc(dissolved.source),
    }));
    const dissolvedResult = findDocWriteFrame(dissolvedWrite.frames, dissolvedMutationId);
    expect(dissolvedResult.data.ok).toBe(true);
    expect(serverDiagramSource((await core.documentRepo.load(sessionId))!.pmDoc!))
      .toBe(baselineSource);

    const roundTripExport = await request(
      "GET",
      `/api/v1/export/${sessionId}?format=markdown`,
    ).then((response) => response.text());
    expect(roundTripExport).toBe(baselineExport);
  });

  it("luna1-TC2 空分区拖空后经连续保存仍是服务端真值，只有显式解散才消失", async () => {
    const baselineSource = [
      "flowchart LR",
      "  A[自由节点A]",
      "  B[自由节点B]",
      "",
    ].join("\n");
    let persistedDoc = canvasDiagramDoc(baselineSource);
    let clientCanonicalDoc = persistedDoc;
    const sessionId = await seedRestoredSession("luna1-TC2 空分区生命周期", persistedDoc);
    let expectedVersion = 1;

    const persistStep = async (label: string, source: string, overlay?: DiagramOverlay): Promise<void> => {
      const clientMutationId = `empty-lifecycle-${label}-${randomUUID()}`;
      const nextDoc = canvasDiagramDoc(source, overlay);
      const { res, frames } = await postStream(updateDocCommand({
        sessionId,
        expectedDocumentSnapshot: expectedVersion,
        baseContentHash: getPmContentHash(clientCanonicalDoc),
        clientMutationId,
        doc: nextDoc,
      }));
      expect(res.status, label).toBe(200);
      const result = findDocWriteFrame(frames, clientMutationId);
      expect(result.data.ok, label).toBe(true);
      if (!result.data.ok) throw new Error(`${label} 保存冲突`);
      expectedVersion = result.data.docVersion;
      clientCanonicalDoc = nextDoc;
      persistedDoc = (await core.documentRepo.load(sessionId))!.pmDoc!;
      expect(persistedDoc, label).toEqual(JSON.parse(JSON.stringify(nextDoc)));
      expect(serverDiagramSource(persistedDoc), label).toBe(source);
    };

    const created = mustRewrite(
      wrapNodesInSubgraph(baselineSource, [], "Gamma区"),
      "建 Gamma 空分区",
    );
    await persistStep("create", created.source);

    const movedIn = mustRewrite(
      moveNodeToSubgraph(serverDiagramSource(persistedDoc), "A", created.newSubgraphId!),
      "拖入 Gamma",
    );
    await persistStep("move-in", movedIn.source);

    const renamed = mustRewrite(
      renameSubgraph(serverDiagramSource(persistedDoc), created.newSubgraphId!, "Gamma改名"),
      "Gamma 改名",
    );
    await persistStep("rename", renamed.source);

    const movedOut = mustRewrite(
      moveNodeToSubgraph(serverDiagramSource(persistedDoc), "A", null),
      "拖出 Gamma",
    );
    await persistStep("move-out-empty", movedOut.source);
    expect(serverFlowModel(persistedDoc).subgraphs.find((item) => item.id === created.newSubgraphId))
      .toMatchObject({ label: "Gamma改名" });
    expect(serverFlowModel(persistedDoc).nodes.find((node) => node.id === "A")?.scopePath).toEqual([]);

    const added = mustRewrite(
      applyEdit(serverDiagramSource(persistedDoc), { kind: "addNode", label: "连续保存节点" }),
      "空分区后的无关新增",
    );
    await persistStep("save-again-1", added.source);
    expect(serverFlowModel(persistedDoc).subgraphs.map((item) => item.id)).toContain(created.newSubgraphId);

    await persistStep(
      "save-again-2",
      serverDiagramSource(persistedDoc),
      { positions: { A: { x: 700, y: 300 } } },
    );
    expect(serverFlowModel(persistedDoc).subgraphs.map((item) => item.id)).toContain(created.newSubgraphId);
    expect(serverDiagramOverlay(persistedDoc)).toEqual({ positions: { A: { x: 700, y: 300 } } });

    const dissolved = mustRewrite(
      dissolveSubgraph(serverDiagramSource(persistedDoc), created.newSubgraphId!),
      "显式解散 Gamma",
    );
    await persistStep("dissolve", dissolved.source);
    expect(serverFlowModel(persistedDoc).subgraphs).toHaveLength(0);
    expect(serverDiagramSource(persistedDoc)).not.toContain("subgraph ");
    expect(serverDiagramSource(persistedDoc).split("\n").filter((line) => line.trim() === "end"))
      .toHaveLength(0);
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

  it("R20门:D2 显式信任反代时用 forwarded origin 绝对化 Markdown /api/ 媒体链接", async () => {
    const sessionId = await seedRestoredSession("Markdown 离线链接", doc([
      {
        type: "image",
        attrs: { blockId: "export-image", src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/image.svg", alt: "图", title: null, caption: null },
      },
      {
        type: "fileAttachment",
        attrs: { blockId: "export-file", fileId: "550e8400-e29b-41d4-a716-446655440001", filename: "附件.pdf", mimeType: "application/pdf", size: 1 },
      },
    ]));

    const savedTrustProxy = process.env.QINGAGENT_TRUST_PROXY;
    const savedPublicOrigin = process.env.QINGAGENT_PUBLIC_ORIGIN;
    try {
      process.env.QINGAGENT_TRUST_PROXY = "1";
      delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      const response = await app.request(
        `http://internal.local/api/v1/export/${sessionId}?format=markdown`,
        { headers: { "x-forwarded-host": "qing.example.com", "x-forwarded-proto": "https" } },
      );
      expect(response.status).toBe(200);
      const markdown = await response.text();
      expect(markdown).toContain("![图](https://qing.example.com/api/v1/files/550e8400-e29b-41d4-a716-446655440000/image.svg)");
      expect(markdown).toContain("[附件: 附件.pdf](https://qing.example.com/api/v1/files/550e8400-e29b-41d4-a716-446655440001)");
    } finally {
      if (savedTrustProxy === undefined) delete process.env.QINGAGENT_TRUST_PROXY;
      else process.env.QINGAGENT_TRUST_PROXY = savedTrustProxy;
      if (savedPublicOrigin === undefined) delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      else process.env.QINGAGENT_PUBLIC_ORIGIN = savedPublicOrigin;
    }
  });

  it("R20门:D2 未配置信任时忽略伪造 forwarded-host 并使用请求 origin", async () => {
    const sessionId = await seedRestoredSession("Markdown forwarded-host 加固", doc([
      {
        type: "image",
        attrs: { blockId: "export-image-untrusted", src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440002/image.svg", alt: "安全图", title: null, caption: null },
      },
    ]));
    const savedTrustProxy = process.env.QINGAGENT_TRUST_PROXY;
    const savedPublicOrigin = process.env.QINGAGENT_PUBLIC_ORIGIN;
    try {
      delete process.env.QINGAGENT_TRUST_PROXY;
      delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      const response = await app.request(
        `http://internal.local/api/v1/export/${sessionId}?format=markdown`,
        { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } },
      );
      expect(response.status).toBe(200);
      const markdown = await response.text();
      expect(markdown).toContain("![安全图](http://internal.local/api/v1/files/550e8400-e29b-41d4-a716-446655440002/image.svg)");
      expect(markdown).not.toContain("attacker.example");
    } finally {
      if (savedTrustProxy === undefined) delete process.env.QINGAGENT_TRUST_PROXY;
      else process.env.QINGAGENT_TRUST_PROXY = savedTrustProxy;
      if (savedPublicOrigin === undefined) delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      else process.env.QINGAGENT_PUBLIC_ORIGIN = savedPublicOrigin;
    }
  });

  it("R20门:D2 canonical PUBLIC_ORIGIN 优先于 forwarded 与内部请求 origin", async () => {
    const sessionId = await seedRestoredSession("Markdown canonical origin", doc([
      {
        type: "image",
        attrs: { blockId: "export-image-canonical", src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440003/image.svg", alt: "站点图", title: null, caption: null },
      },
    ]));
    const savedTrustProxy = process.env.QINGAGENT_TRUST_PROXY;
    const savedPublicOrigin = process.env.QINGAGENT_PUBLIC_ORIGIN;
    try {
      delete process.env.QINGAGENT_TRUST_PROXY;
      process.env.QINGAGENT_PUBLIC_ORIGIN = "https://canonical.example/deployment-path";
      const response = await app.request(
        `http://internal.local/api/v1/export/${sessionId}?format=markdown`,
        { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" } },
      );
      expect(response.status).toBe(200);
      const markdown = await response.text();
      expect(markdown).toContain("![站点图](https://canonical.example/api/v1/files/550e8400-e29b-41d4-a716-446655440003/image.svg)");
      expect(markdown).not.toContain("attacker.example");
      expect(markdown).not.toContain("internal.local");
    } finally {
      if (savedTrustProxy === undefined) delete process.env.QINGAGENT_TRUST_PROXY;
      else process.env.QINGAGENT_TRUST_PROXY = savedTrustProxy;
      if (savedPublicOrigin === undefined) delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      else process.env.QINGAGENT_PUBLIC_ORIGIN = savedPublicOrigin;
    }
  });

  it("D4-4 非法 PUBLIC_ORIGIN 明确 warn 并保持既有请求 origin 回退", async () => {
    const sessionId = await seedRestoredSession("Markdown 非法 public origin", doc([
      {
        type: "image",
        attrs: { blockId: "export-image-invalid-origin", src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440004/image.svg", alt: "回退图", title: null, caption: null },
      },
    ]));
    const savedTrustProxy = process.env.QINGAGENT_TRUST_PROXY;
    const savedPublicOrigin = process.env.QINGAGENT_PUBLIC_ORIGIN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      delete process.env.QINGAGENT_TRUST_PROXY;
      process.env.QINGAGENT_PUBLIC_ORIGIN = "htps://typo.example";
      const response = await app.request(
        `http://internal.local/api/v1/export/${sessionId}?format=markdown`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        "![回退图](http://internal.local/api/v1/files/550e8400-e29b-41d4-a716-446655440004/image.svg)",
      );
      expect(warn).toHaveBeenCalledWith(
        "Invalid QINGAGENT_PUBLIC_ORIGIN; falling back to request-derived origin",
        {
          config: "QINGAGENT_PUBLIC_ORIGIN",
          value: "htps://typo.example",
          fallback: "request origin (or trusted proxy origin when enabled)",
        },
      );
    } finally {
      warn.mockRestore();
      if (savedTrustProxy === undefined) delete process.env.QINGAGENT_TRUST_PROXY;
      else process.env.QINGAGENT_TRUST_PROXY = savedTrustProxy;
      if (savedPublicOrigin === undefined) delete process.env.QINGAGENT_PUBLIC_ORIGIN;
      else process.env.QINGAGENT_PUBLIC_ORIGIN = savedPublicOrigin;
    }
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

const TEST_COMMAND_TOKEN = "rich-formats-bridge-test-token";

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  // commands/stream mutation 已要求可信 Origin + 确定性 token;测试显式模拟已鉴权请求。
  const previousToken = process.env.QINGAGENT_AUTH_TOKEN;
  process.env.QINGAGENT_AUTH_TOKEN = TEST_COMMAND_TOKEN;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5173",
      Authorization: `Bearer ${TEST_COMMAND_TOKEN}`,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    return await app.request(path, init);
  } finally {
    if (previousToken === undefined) delete process.env.QINGAGENT_AUTH_TOKEN;
    else process.env.QINGAGENT_AUTH_TOKEN = previousToken;
  }
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

function canvasDiagramDoc(
  source: string,
  overlay?: DiagramOverlay,
): PmDoc {
  return doc([{
    type: "diagram",
    attrs: {
      blockId: "canvas-diagram",
      lang: "mermaid",
      source,
      svg: null,
      ...(overlay ? { overlay } : {}),
    },
  }]);
}

function serverDiagramBlock(pmDoc: PmDoc): Extract<PmBlockNode, { type: "diagram" }> {
  const block = pmDoc.content.find(
    (item): item is Extract<PmBlockNode, { type: "diagram" }> =>
      item.type === "diagram",
  );
  if (!block) throw new Error("服务端文档缺 diagram");
  return block;
}

function serverDiagramSource(pmDoc: PmDoc): string {
  return serverDiagramBlock(pmDoc).attrs.source;
}

function serverDiagramOverlay(pmDoc: PmDoc): unknown {
  return serverDiagramBlock(pmDoc).attrs.overlay;
}

function serverFlowModel(pmDoc: PmDoc): FlowGraph {
  const parsed = parseDiagram(serverDiagramSource(pmDoc));
  if (!parsed.ok || parsed.model.type !== "flowchart") {
    throw new Error(parsed.error ?? "服务端 Mermaid 不是 flowchart");
  }
  return parsed.model;
}

function mustRewrite(result: RewriteResult, label: string): RewriteResult & { ok: true } {
  expect(result.ok, label).toBe(true);
  if (!result.ok) throw new Error(`${label}: ${result.error ?? "rewrite failed"}`);
  return result as RewriteResult & { ok: true };
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

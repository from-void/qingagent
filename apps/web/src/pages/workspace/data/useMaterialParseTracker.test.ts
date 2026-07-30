import { describe, expect, it } from "vitest";
import type { Command, Resource } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";
import {
  buildMaterialParseRows,
  buildReparseMaterialCommand,
  initialMaterialParseTrackerState,
  materialRetryFailureReasonFromCommandResult,
  MATERIAL_PARSE_BUSY_REASON,
  MATERIAL_PARSE_INCOMPLETE_REASON,
  reduceMaterialParseTrackerState,
  type MaterialParseTrackerState,
  type UploadedAsset,
} from "./useMaterialParseTracker";

function uploaded(
  fileId: string,
  filename = `${fileId}.pdf`,
  mime = "application/pdf",
): UploadedAsset {
  return {
    fileId,
    filename,
    mime,
    size: 12,
  };
}

function resource(input: {
  id: string;
  displayName: string;
  fileId?: string;
  parseState?: "ready" | "error";
  parseError?: string | null;
  mime?: string | null;
  updatedAt?: string | null;
}): Resource {
  return {
    resourceRef: { id: input.id, domain: { kind: "file" } },
    displayName: input.displayName,
    summary: "摘要",
    mime: input.mime ?? "application/pdf",
    byteLen: 3,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata: {
      fileId: input.fileId ?? null,
      sourceUrl: null,
      pages: null,
      wordCount: 0,
      title: null,
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
      ...(input.parseState ? { parseState: input.parseState } : {}),
      ...(input.parseError !== undefined ? { parseError: input.parseError } : {}),
    },
  };
}

function reduce(
  state: MaterialParseTrackerState,
  action: Parameters<typeof reduceMaterialParseTrackerState>[1],
): MaterialParseTrackerState {
  return reduceMaterialParseTrackerState(state, action);
}

describe("useMaterialParseTracker state machine", () => {
  it("图片上传插入后跳过 material parse tracker，不会在文件条误报失败", () => {
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("image-1", "figure.png", "image/png")],
      agentActive: false,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, { type: "agentActiveChanged", agentActive: true });
    state = reduce(state, { type: "agentActiveChanged", agentActive: false });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [])).toEqual([]);
  });

  it("文档类文件仍进入 parse tracker，解析未完成时正确标记失败", () => {
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("doc-1", "notes.md", "text/markdown")],
      agentActive: false,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, { type: "agentActiveChanged", agentActive: true });
    state = reduce(state, { type: "agentActiveChanged", agentActive: false });

    expect(buildMaterialParseRows(state, [])).toMatchObject([
      {
        fileId: "doc-1",
        filename: "notes.md",
        state: "error",
        parseError: MATERIAL_PARSE_INCOMPLETE_REASON,
        source: "local",
      },
    ]);
  });

  it("markParsing 后 ready resource 到达会清掉本地 parsing", () => {
    const ready = resource({ id: "mat-1", displayName: "server.pdf", fileId: "file-1" });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1", "local.pdf")],
      agentActive: true,
      turnKey: 1,
      resources: [],
    });

    expect(state.entries).toMatchObject([{ fileId: "file-1", state: "parsing" }]);

    state = reduce(state, { type: "resourcesChanged", resources: [ready] });
    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [ready])).toMatchObject([
      {
        id: "mat-1",
        fileId: "file-1",
        filename: "server.pdf",
        state: "ready",
        source: "resource",
      },
    ]);
  });

  it("同 fileId 二次注入已有 ready 素材时仍保持一条且不会翻成 error", () => {
    const ready = resource({
      id: "mat-1",
      displayName: "server.docx",
      fileId: "file-1",
      parseState: "ready",
      updatedAt: "2026-07-30T09:00:00.000Z",
    });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1", "server.docx")],
      agentActive: false,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, { type: "resourcesChanged", resources: [ready] });

    state = reduce(state, {
      type: "markParsing",
      assets: [uploaded("file-1", "server.docx")],
      agentActive: false,
      turnKey: 2,
      resources: [ready],
    });
    state = reduce(state, { type: "agentActiveChanged", agentActive: true });
    state = reduce(state, { type: "agentActiveChanged", agentActive: false });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [ready])).toMatchObject([
      {
        id: "mat-1",
        fileId: "file-1",
        filename: "server.docx",
        state: "ready",
        source: "resource",
      },
    ]);
  });

  it("同 fileId 二次注入后若收到权威 error resource 仍呈现真失败", () => {
    const ready = resource({
      id: "mat-1",
      displayName: "server.docx",
      fileId: "file-1",
      parseState: "ready",
      updatedAt: "2026-07-30T09:00:00.000Z",
    });
    const failed = resource({
      id: "mat-1",
      displayName: "server.docx",
      fileId: "file-1",
      parseState: "error",
      parseError: "解析失败：文件损坏",
      updatedAt: "2026-07-30T09:01:00.000Z",
    });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1", "server.docx")],
      agentActive: false,
      turnKey: 2,
      resources: [ready],
    });

    state = reduce(state, { type: "resourcesChanged", resources: [failed] });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [failed])).toMatchObject([
      {
        id: "mat-1",
        fileId: "file-1",
        state: "error",
        parseError: "解析失败：文件损坏",
        source: "resource",
      },
    ]);
  });

  it("error resource 到达同样清掉本地条，错误由 resource 行呈现", () => {
    const failed = resource({
      id: "mat-err",
      displayName: "bad.pdf",
      fileId: "file-err",
      parseState: "error",
      parseError: "PDF 损坏",
    });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-err", "bad.pdf")],
      agentActive: true,
      turnKey: 1,
      resources: [],
    });

    state = reduce(state, { type: "resourcesChanged", resources: [failed] });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [failed])).toMatchObject([
      {
        fileId: "file-err",
        state: "error",
        parseError: "PDF 损坏",
        source: "resource",
      },
    ]);
  });

  it("本轮见过 active 后结束仍没有 resource，会把本地 parsing 翻成 error", () => {
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1")],
      agentActive: false,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, { type: "agentActiveChanged", agentActive: true });
    state = reduce(state, { type: "agentActiveChanged", agentActive: false });

    expect(state.entries).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        state: "error",
        errorReason: MATERIAL_PARSE_INCOMPLETE_REASON,
      }),
    ]);
    expect(buildMaterialParseRows(state, [])).toMatchObject([
      {
        fileId: "file-1",
        state: "error",
        parseError: MATERIAL_PARSE_INCOMPLETE_REASON,
        source: "local",
      },
    ]);
  });

  it("派发失败只结算匹配 turnKey 的 parsing，不覆盖同文件后发起的重试", () => {
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1")],
      agentActive: false,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, {
      type: "retry",
      fileId: "file-1",
      agentActive: false,
      turnKey: 2,
      resources: [],
    });

    state = reduce(state, {
      type: "markTurnError",
      turnKey: 1,
      reason: "发送失败，请重试",
    });
    expect(state.entries).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        turnKey: 2,
        state: "parsing",
        errorReason: null,
      }),
    ]);

    state = reduce(state, {
      type: "markTurnError",
      turnKey: 2,
      reason: "发送失败，请重试",
    });
    expect(state.entries).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        turnKey: 2,
        state: "error",
        errorReason: "发送失败，请重试",
      }),
    ]);
  });

  it("retry 会把本地 error 翻回 parsing", () => {
    let state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1", "retry.pdf")],
      agentActive: true,
      turnKey: 1,
      resources: [],
    });
    state = reduce(state, { type: "agentActiveChanged", agentActive: false });

    state = reduce(state, {
      type: "retry",
      fileId: "file-1",
      agentActive: false,
      turnKey: 2,
      resources: [],
    });

    expect(state.entries).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        filename: "retry.pdf",
        state: "parsing",
        errorReason: null,
        seenActive: false,
      }),
    ]);
  });

  it("重试已有 error resource 时先显示 parsing，直到新的 resource 帧清除本地覆盖", () => {
    const oldResource = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
      parseState: "error",
      parseError: "旧错误",
    });
    const newResource = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
      parseState: "ready",
    });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "retry",
      fileId: "file-1",
      agentActive: false,
      turnKey: 1,
      resources: [oldResource],
    });

    expect(buildMaterialParseRows(state, [oldResource])).toMatchObject([
      {
        fileId: "file-1",
        state: "parsing",
        source: "resource",
      },
    ]);

    state = reduce(state, { type: "resourcesChanged", resources: [newResource] });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [newResource])).toMatchObject([
      {
        fileId: "file-1",
        state: "ready",
        source: "resource",
      },
    ]);
  });

  it("重放同内容不同对象引用的旧 error resource 时不误清 parsing 覆盖态", () => {
    const oldResource = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
      parseState: "error",
      parseError: "旧错误",
      updatedAt: "2026-07-04T00:00:00.000Z",
    });
    const replayedOldResource: Resource = {
      ...oldResource,
      metadata: {
        ...(oldResource.metadata as Record<string, unknown>),
      },
    };
    let state = reduce(initialMaterialParseTrackerState, {
      type: "retry",
      fileId: "file-1",
      agentActive: false,
      turnKey: 1,
      resources: [oldResource],
    });

    state = reduce(state, { type: "resourcesChanged", resources: [replayedOldResource] });

    expect(state.entries).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        state: "parsing",
      }),
    ]);
    expect(buildMaterialParseRows(state, [replayedOldResource])).toMatchObject([
      {
        fileId: "file-1",
        state: "parsing",
        source: "resource",
      },
    ]);
  });

  it("重试后同错误文案但 updatedAt 推进的新 error resource 会清掉 parsing 覆盖态", () => {
    const oldResource = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
      parseState: "error",
      parseError: "解析失败：PDF 损坏",
      updatedAt: "2026-07-04T00:00:00.000Z",
    });
    const reparsedErrorResource = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
      parseState: "error",
      parseError: "解析失败：PDF 损坏",
      updatedAt: "2026-07-04T00:00:01.000Z",
    });
    let state = reduce(initialMaterialParseTrackerState, {
      type: "retry",
      fileId: "file-1",
      agentActive: false,
      turnKey: 1,
      resources: [oldResource],
    });

    expect(buildMaterialParseRows(state, [oldResource])).toMatchObject([
      {
        fileId: "file-1",
        state: "parsing",
        source: "resource",
      },
    ]);

    state = reduce(state, { type: "resourcesChanged", resources: [reparsedErrorResource] });

    expect(state.entries).toEqual([]);
    expect(buildMaterialParseRows(state, [reparsedErrorResource])).toMatchObject([
      {
        fileId: "file-1",
        state: "error",
        parseError: "解析失败：PDF 损坏",
        source: "resource",
      },
    ]);
  });
});

describe("buildMaterialParseRows", () => {
  it("按 fileId 去重且 resource 优先，metadata.parseState 缺省为 ready", () => {
    const readyWithoutState = resource({
      id: "mat-1",
      displayName: "server.pdf",
      fileId: "file-1",
    });
    const state = reduce(initialMaterialParseTrackerState, {
      type: "markParsing",
      assets: [uploaded("file-1", "local.pdf"), uploaded("file-2", "other.pdf")],
      agentActive: true,
      turnKey: 1,
      resources: [],
    });

    const rows = buildMaterialParseRows(state, [readyWithoutState]);

    expect(rows).toMatchObject([
      {
        id: "mat-1",
        fileId: "file-1",
        filename: "server.pdf",
        state: "ready",
        source: "resource",
      },
      {
        id: "local:file-2",
        fileId: "file-2",
        filename: "other.pdf",
        state: "parsing",
        source: "local",
      },
    ]);
  });

  it("不同 fileId 即使同名也会渲染两条，复核现场双条目来自上传生成了两个 fileId", () => {
    const failed = resource({
      id: "mat-old",
      displayName: "逐宁简历.pdf",
      fileId: "file-old",
      parseState: "error",
      parseError: "解析失败",
    });
    const ready = resource({
      id: "mat-new",
      displayName: "逐宁简历.pdf",
      fileId: "file-new",
      parseState: "ready",
    });

    const rows = buildMaterialParseRows(initialMaterialParseTrackerState, [failed, ready]);

    expect(rows).toMatchObject([
      {
        id: "mat-old",
        fileId: "file-old",
        filename: "逐宁简历.pdf",
        state: "error",
        source: "resource",
      },
      {
        id: "mat-new",
        fileId: "file-new",
        filename: "逐宁简历.pdf",
        state: "ready",
        source: "resource",
      },
    ]);
  });
});

describe("materialRetryFailureReasonFromCommandResult", () => {
  it("识别 reparseMaterial busy 帧并返回明确可 toast 文案", () => {
    expect(
      materialRetryFailureReasonFromCommandResult([
        {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: "active-stream",
              reason: "生成中，请稍后再试",
              retriable: false,
            },
          },
        },
      ]),
    ).toBe(MATERIAL_PARSE_BUSY_REASON);
  });

  it("resourceUpserted 成功回包不被误判为 retry 失败", () => {
    expect(
      materialRetryFailureReasonFromCommandResult([
        {
          kind: "resourceUpserted",
          data: {
            resource: resource({
              id: "mat-1",
              displayName: "逐宁简历.pdf",
              fileId: "file-1",
              parseState: "ready",
            }),
          },
        },
      ]),
    ).toBeNull();
  });
});

describe("buildReparseMaterialCommand", () => {
  it("发出的 reparseMaterial 命令形态通过现有 validator", () => {
    const command: Command = buildReparseMaterialCommand("session-1", "file-1");

    expect(command).toEqual({
      kind: "reparseMaterial",
      data: { sessionId: "session-1", fileId: "file-1" },
    });
    expect(() => validateCommand(command)).not.toThrow();
  });
});

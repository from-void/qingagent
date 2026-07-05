import { describe, expect, it } from "vitest";
import type { Command, Resource } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";
import {
  buildMaterialParseRows,
  buildReparseMaterialCommand,
  initialMaterialParseTrackerState,
  MATERIAL_PARSE_INCOMPLETE_REASON,
  reduceMaterialParseTrackerState,
  type MaterialParseTrackerState,
  type UploadedAsset,
} from "./useMaterialParseTracker";

function uploaded(fileId: string, filename = `${fileId}.pdf`): UploadedAsset {
  return {
    fileId,
    filename,
    mime: "application/pdf",
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

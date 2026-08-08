import { describe, expect, it } from "vitest";
import type {
  AskUserSpec,
  Command,
  BridgeFrame,
  ToolCallBody,
} from "@qingagent/contract-ts";
import { validateAskUserSpec, AskUserSpecValidationError } from "../askUserSpec";
import { validateCommand, CommandValidationError } from "../command";
import { validateBridgeFrame, BridgeFrameValidationError } from "../wireFrame";

const validPmDoc = {
  type: "doc" as const,
  attrs: { schemaVersion: 1 as const },
  content: [{
    type: "paragraph" as const,
    attrs: { blockId: "p-1" },
    content: [{ type: "text" as const, text: "正文" }],
  }],
};

function validAskUserSpec(): AskUserSpec {
  return {
    id: "a",
    mode: { kind: "overlay" },
    purpose: null,
    source: null,
    rationale: null,
    questions: [{
      id: "q",
      header: null,
      label: "Q",
      kind: { kind: "single" },
      options: [
        { value: "a", label: "A", description: null, preview: null },
        { value: "b", label: "B", description: null, preview: null },
      ],
      placeholder: null,
    }],
  };
}

describe("validateAskUserSpec", () => {
  it("rejects a question header longer than 12 Unicode code points", () => {
    const spec = validAskUserSpec();
    spec.questions[0]!.header = "🙂".repeat(13);
    expect(() => validateAskUserSpec(spec)).toThrow(AskUserSpecValidationError);
  });

  it("accepts a 12-code-point question header", () => {
    const spec = validAskUserSpec();
    spec.questions[0]!.header = "🙂".repeat(12);
    expect(() => validateAskUserSpec(spec)).not.toThrow();
  });

  it("rejects a non-string question header without throwing a native TypeError", () => {
    const spec = validAskUserSpec();
    (spec.questions[0] as unknown as { header: unknown }).header = 12;
    expect(() => validateAskUserSpec(spec)).toThrow(AskUserSpecValidationError);
  });

  it("rejects 9 questions", () => {
    const q = {
      id: "q",
      label: "Q",
      kind: { kind: "single" as const },
      options: [],
      placeholder: null,
    };
    const spec: AskUserSpec = {
      id: "a",
      mode: { kind: "overlay" },
      purpose: null,
      source: null,
      rationale: null,
      questions: [q, q, q, q, q, q, q, q, q],
    };
    expect(() => validateAskUserSpec(spec)).toThrow(AskUserSpecValidationError);
  });

  it("rejects 9 options", () => {
    const opt = { value: "a", label: "A", description: null, preview: null };
    const spec: AskUserSpec = {
      id: "a",
      mode: { kind: "overlay" },
      purpose: null,
      source: null,
      rationale: null,
      questions: [
        {
          id: "q",
          label: "Q",
          kind: { kind: "single" },
          options: [opt, opt, opt, opt, opt, opt, opt, opt, opt],
          placeholder: null,
        },
      ],
    };
    expect(() => validateAskUserSpec(spec)).toThrow(AskUserSpecValidationError);
  });

  it("rejects text question with options", () => {
    const spec: AskUserSpec = {
      id: "a",
      mode: { kind: "overlay" },
      purpose: null,
      source: null,
      rationale: null,
      questions: [
        {
          id: "q",
          label: "Q",
          kind: { kind: "text" },
          options: [{ value: "v", label: "V", description: null, preview: null }],
          placeholder: null,
        },
      ],
    };
    expect(() => validateAskUserSpec(spec)).toThrow(AskUserSpecValidationError);
  });

  it("accepts valid spec", () => {
    const spec: AskUserSpec = {
      id: "a",
      mode: { kind: "fullpage" },
      purpose: null,
      source: null,
      rationale: null,
      questions: [],
    };
    expect(() => validateAskUserSpec(spec)).not.toThrow();
  });
});

describe("validateCommand", () => {
  it("rejects sendMessage with selection chip missing ref", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "",
        skills: [],
        chips: [
          {
            kind: { kind: "selection" },
            resourceRef: null,
            prefix: null,
            label: "x",
            suffix: null,
          },
        ],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("rejects empty commitPatches", () => {
    const cmd: Command = { kind: "commitPatches", data: { ids: [] } };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("rejects cancelStream with empty streamId", () => {
    const cmd: Command = { kind: "cancelStream", data: { streamId: "" } };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("accepts planning cancelStream with sessionId before streamId exists", () => {
    const cmd: Command = {
      kind: "cancelStream",
      data: { sessionId: "session-planning" },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("accepts targeted cancelStream with sessionId and streamId", () => {
    const cmd: Command = {
      kind: "cancelStream",
      data: { sessionId: "session-writing", streamId: "stream-writing" },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("resumeAskUser 必须携带非空 toolCallId", () => {
    for (const toolCallId of [undefined, ""]) {
      expect(() => validateCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: "session-ask",
          ...(toolCallId === undefined ? {} : { toolCallId }),
          answers: { q1: { chosen: [], freeText: "答案" } },
        },
      } as Command)).toThrow(CommandValidationError);
    }
    expect(() => validateCommand({
      kind: "resumeAskUser",
      data: {
        sessionId: "session-ask",
        toolCallId: "ask-1",
        answers: { q1: { chosen: [], freeText: "答案" } },
      },
    })).not.toThrow();
  });

  it("accepts current main/derivative targets", () => {
    for (const activeDocument of [
      { kind: "main" as const },
      { kind: "derivative" as const, docId: "derivative-1" },
    ]) {
      const cmd: Command = {
        kind: "sendMessage",
        data: {
          sessionId: "s",
          text: "把第二段改短一点",
          skills: [],
          chips: [],
          fileIds: [],
          activeDocument,
        },
      };
      expect(() => validateCommand(cmd)).not.toThrow();
    }
  });

  it("rejects non-object active document target", () => {
    expect(() =>
      validateCommand({
        kind: "sendMessage",
        data: {
          sessionId: "s",
          text: "改短一点",
          skills: [],
          chips: [],
          fileIds: [],
          activeDocument: null,
        },
      } as unknown as Command),
    ).toThrow(/activeDocument must be an object/);
  });

  it("accepts role review context", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "角色审查",
    skills: [], chips: [], fileIds: [],
        reviewContext: { type: "role", templateId: "review-role-engineer", templateName: "研发工程师" },
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("只接受受控的衍生稿 turnKind", () => {
    const base = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "生成衍生稿",
        skills: [],
        chips: [],
        fileIds: [],
      },
    };
    expect(() => validateCommand({
      ...base,
      data: { ...base.data, turnKind: "generateDerivative" },
    } as Command)).not.toThrow();
    expect(() => validateCommand({
      ...base,
      data: { ...base.data, turnKind: "free-form-site" },
    } as unknown as Command)).toThrow(CommandValidationError);
  });

  it("accepts normalized table selection on selection chip", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "修改",
        skills: [],
        chips: [{
          kind: { kind: "selection" },
          resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
          prefix: null,
          label: "A | B",
          suffix: "表格·第1行",
          tableSelection: { axis: "row", startIndex: 0, endIndex: 1, signature: "fnv1a-deadbeef" },
        }],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it.each([
    ["负数", { axis: "row" as const, startIndex: -1, endIndex: 0 }],
    ["小数", { axis: "row" as const, startIndex: 0.5, endIndex: 1 }],
    ["反向", { axis: "column" as const, startIndex: 2, endIndex: 1 }],
  ])("rejects invalid table selection: %s", (_label, tableSelection) => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "修改",
        skills: [],
        chips: [{
          kind: { kind: "selection" },
          resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
          prefix: null,
          label: "A",
          suffix: null,
          tableSelection,
        }],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("rejects table selection on non-selection chip", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "修改",
        skills: [],
        chips: [{
          kind: { kind: "text" },
          resourceRef: null,
          prefix: null,
          label: "正文",
          suffix: null,
          tableSelection: { axis: "row", startIndex: 0, endIndex: 0 },
        }],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("accepts valid updateDoc", () => {
    const cmd: Command = {
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        baseContentHash: "pmv1-base",
        doc: validPmDoc,
        clientMutationId: "mutation-1",
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("rejects malformed attachFolder and detachFolder commands without TypeError", () => {
    const malformed: unknown[] = [
      { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid" } },
      { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: null } },
      { kind: "attachFolder", data: { sessionId: 123, requestId: "attach-invalid", source: { provider: "desktop-local", selectionToken: "tok" } } },
      { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "desktop-local", selectionToken: 123 } } },
      {
        kind: "attachFolder",
        data: {
          sessionId: "s",
          requestId: "attach-invalid",
          source: { provider: "browser-fs-access", clientSourceId: 1, name: 2, browserHandleKey: 3 },
        },
      },
      { kind: "detachFolder", data: null },
      { kind: "detachFolder", data: { sessionId: "s", folderId: 123 } },
    ];

    for (const payload of malformed) {
      expect(() => validateCommand(payload as Command)).toThrow(CommandValidationError);
    }
  });

  it("accepts valid reparseMaterial and rejects empty fields", () => {
    expect(() =>
      validateCommand({
        kind: "reparseMaterial",
        data: { sessionId: "s", fileId: "file-1" },
      }),
    ).not.toThrow();

    for (const payload of [
      { kind: "reparseMaterial", data: { sessionId: "", fileId: "file-1" } },
      { kind: "reparseMaterial", data: { sessionId: "s", fileId: "" } },
      { kind: "reparseMaterial", data: null },
    ]) {
      expect(() => validateCommand(payload as Command)).toThrow(CommandValidationError);
    }
  });

  it("rejects updateDoc without clientMutationId", () => {
    const cmd: Command = {
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        baseContentHash: "pmv1-base",
        doc: validPmDoc,
        clientMutationId: "",
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });

  it("rejects updateDoc with empty baseContentHash", () => {
    const cmd: Command = {
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        baseContentHash: "",
        doc: validPmDoc,
        clientMutationId: "mutation-1",
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });
});

describe("validateBridgeFrame", () => {
  it("accepts restoreReset and rejects invalid counters", () => {
    expect(() =>
      validateBridgeFrame({ kind: "restoreReset", data: { epoch: 1, snapshotSeq: 2 } }),
    ).not.toThrow();
    expect(() =>
      validateBridgeFrame({ kind: "restoreReset", data: { epoch: -1, snapshotSeq: 2 } }),
    ).toThrow(BridgeFrameValidationError);
  });

  it("accepts sessionRestoreCompleted and rejects an empty session id", () => {
    expect(() =>
      validateBridgeFrame({
        kind: "sessionRestoreCompleted",
        data: { sessionId: "session-1" },
      }),
    ).not.toThrow();
    expect(() =>
      validateBridgeFrame({
        kind: "sessionRestoreCompleted",
        data: { sessionId: "" },
      }),
    ).toThrow(/sessionId/);
  });

  it("accepts chatMessageAdded.appendSeq only when it is a non-negative integer", () => {
    const frame: BridgeFrame = {
      kind: "chatMessageAdded",
      data: {
        message: {
          id: "m",
          role: { kind: "agent" },
          ts: "2026-01-01T00:00:00.000Z",
          parts: [],
          chips: null,
        },
        appendSeq: 47,
      },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
    expect(() =>
      validateBridgeFrame({ ...frame, data: { ...frame.data, appendSeq: -1 } }),
    ).toThrow(BridgeFrameValidationError);
    expect(() =>
      validateBridgeFrame({ ...frame, data: { ...frame.data, appendSeq: 1.5 } }),
    ).toThrow(BridgeFrameValidationError);
  });

  it("rejects contract-external frame kinds", () => {
    expect(() => validateBridgeFrame({ kind: "futureFrame", data: {} } as never))
      .toThrow(BridgeFrameValidationError);
  });

  it("rejects citation with wrong domain", () => {
    const frame: BridgeFrame = {
      kind: "chatMessageAppended",
      data: {
        messageId: "m",
        seq: 1,
        part: {
          kind: "citation",
          data: {
            sourceRef: { id: "r", domain: { kind: "file" } },
            anchor: "p",
          },
        },
      },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects webFetch with non-url ref", () => {
    const frame: BridgeFrame = {
      kind: "toolCallUpdated",
      data: {
        messageId: "m",
        toolCallId: "tc",
        spec: {
          id: "tc",
          name: "webFetch",
          render: { kind: "chatInline" },
          status: { kind: "pending" },
          body: {
            kind: "webFetch",
            data: { urlRef: { id: "u", domain: { kind: "file" } } },
          },
          result: null,
        },
      },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  const qrFrame = (data: {
    content: string;
    expiresAt: number;
    refreshQuery: string;
  }): BridgeFrame => ({
    kind: "toolCallUpdated",
    data: {
      messageId: "m",
      toolCallId: "tc",
      spec: {
        id: "tc",
        name: "show_qr",
        render: { kind: "chatInline" },
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
        body: {
          kind: "qrCard",
          data: {
            presentation: "scan",
            imageDataUri: null,
            content: data.content,
            title: "扫码授权飞书",
            code: "ABCD-1234",
            note: null,
            expiresAt: data.expiresAt,
            refreshQuery: data.refreshQuery,
            confirmQuery: null,
          },
        },
        result: null,
      },
    },
  });
  const FUTURE_EPOCH_MS = 4102444800000;

  const toolBodyFrame = (body: ToolCallBody): BridgeFrame => ({
    kind: "toolCallUpdated",
    data: {
      messageId: "m-card",
      toolCallId: "tc-card",
      spec: {
        id: "tc-card",
        name: "card-tool",
        render: { kind: "chatInline" },
        status: { kind: "done" },
        body,
        result: null,
      },
    },
  });

  it.each([
    {
      kind: "writeDraftCard" as const,
      data: {
        title: "测试稿",
        phase: "done" as const,
        charCount: 120,
        excerpt: null,
        resetExcerpt: true,
        targetLength: 100,
        minLength: 80,
        maxLength: 140,
        revisionCount: 1,
        lengthStatus: "accepted",
      },
    },
    {
      kind: "commandCard" as const,
      data: {
        title: "计算",
        icon: "🧮",
        command: "wc -m draft.md",
        exitCode: 0,
        outputTail: "120",
        phase: "done" as const,
      },
    },
    {
      kind: "researchCard" as const,
      data: {
        query: "宋代点茶",
        phase: "done" as const,
        items: [{
          url: "https://example.com",
          title: "点茶",
          status: "done" as const,
          wordCount: 120,
        }],
        total: 1,
        fetchedCount: 1,
        okCount: 1,
        skippedCount: 0,
      },
    },
  ])("accepts and validates $kind", (body) => {
    expect(() => validateBridgeFrame(toolBodyFrame(body))).not.toThrow();
  });

  it.each([
    [
      "writeDraftCard",
      {
        kind: "writeDraftCard",
        data: {
          title: "测试稿",
          phase: "done",
          charCount: -1,
          excerpt: null,
          targetLength: null,
          minLength: null,
          maxLength: null,
          revisionCount: 0,
          lengthStatus: null,
        },
      },
    ],
    [
      "commandCard",
      {
        kind: "commandCard",
        data: {
          title: "计算",
          icon: "🧮",
          command: "true",
          exitCode: 0.5,
          outputTail: "",
          phase: "done",
        },
      },
    ],
    [
      "researchCard",
      {
        kind: "researchCard",
        data: {
          query: "测试",
          phase: "done",
          items: [{ url: "x", title: "x", status: "done", wordCount: -1 }],
          total: 1,
          fetchedCount: 1,
          okCount: 1,
          skippedCount: 0,
        },
      },
    ],
  ])("rejects malformed %s", (_kind, body) => {
    expect(() =>
      validateBridgeFrame(toolBodyFrame(body as ToolCallBody)),
    ).toThrow(BridgeFrameValidationError);
  });

  it("rejects writeDraftCard with a non-boolean resetExcerpt marker", () => {
    const body: ToolCallBody = {
      kind: "writeDraftCard",
      data: {
        title: "测试稿",
        phase: "writing",
        charCount: 10,
        excerpt: "正文",
        resetExcerpt: "yes",
        targetLength: null,
        minLength: null,
        maxLength: null,
        revisionCount: 0,
        lengthStatus: null,
      },
    } as unknown as ToolCallBody;
    expect(() => validateBridgeFrame(toolBodyFrame(body))).toThrow(BridgeFrameValidationError);
  });

  it("未知 ToolCallBody kind fail-closed", () => {
    const frame = toolBodyFrame({
      kind: "futureCard",
      data: {},
    } as unknown as ToolCallBody);
    expect(() => validateBridgeFrame(frame)).toThrow(
      /Unknown ToolCallBody\.kind/,
    );
  });

  it("accepts a valid qrCard", () => {
    expect(() =>
      validateBridgeFrame(
        qrFrame({ content: "https://example.com/auth", expiresAt: FUTURE_EPOCH_MS, refreshQuery: "刷新" }),
      ),
    ).not.toThrow();
  });

  it("rejects qrCard with empty content", () => {
    expect(() =>
      validateBridgeFrame(qrFrame({ content: "", expiresAt: FUTURE_EPOCH_MS, refreshQuery: "刷新" })),
    ).toThrow(BridgeFrameValidationError);
  });

  it("rejects qrCard with non-positive expiresAt", () => {
    expect(() =>
      validateBridgeFrame(
        qrFrame({ content: "https://example.com/auth", expiresAt: 0, refreshQuery: "刷新" }),
      ),
    ).toThrow(BridgeFrameValidationError);
  });

  it("rejects qrCard with empty refreshQuery", () => {
    expect(() =>
      validateBridgeFrame(
        qrFrame({ content: "https://example.com/auth", expiresAt: FUTURE_EPOCH_MS, refreshQuery: "" }),
      ),
    ).toThrow(BridgeFrameValidationError);
  });

  it.each(["title", "code", "note", "confirmQuery"] as const)(
    "rejects qrCard with non-string/non-null %s",
    (field) => {
      const frame = qrFrame({
        content: "https://example.com/auth",
        expiresAt: FUTURE_EPOCH_MS,
        refreshQuery: "刷新",
      });
      if (frame.kind !== "toolCallUpdated" || frame.data.spec.body.kind !== "qrCard") {
        throw new Error("expected qrCard body");
      }
      (frame.data.spec.body.data as unknown as Record<string, unknown>)[field] = 42;
      expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
    },
  );

  it("qrCard 新 connector 字段全 optional，旧帧与合法新帧均通过", () => {
    const legacy = qrFrame({ content: "https://example.com", expiresAt: FUTURE_EPOCH_MS, refreshQuery: "刷新" });
    expect(() => validateBridgeFrame(legacy)).not.toThrow();
    const modern = structuredClone(legacy);
    if (modern.kind !== "toolCallUpdated" || modern.data.spec.body.kind !== "qrCard") throw new Error("bad fixture");
    Object.assign(modern.data.spec.body.data, {
      presentation: "scan",
      connectorId: "feishu",
      pendingId: "pending_12345678",
      success: { account: "示例用户", message: "已连接" },
    });
    expect(() => validateBridgeFrame(modern)).not.toThrow();
  });

  it.each([
    { presentation: "hologram" },
    { connectorId: "evil" }, { pendingId: "short" }, { pendingId: "x".repeat(129) },
    { success: { account: null, message: "" } },
    { success: { account: "x".repeat(129), message: "ok" } },
  ])("拒绝 qrCard 非法 connector 元数据 %o", (extra) => {
    const frame = qrFrame({ content: "https://example.com", expiresAt: FUTURE_EPOCH_MS, refreshQuery: "刷新" });
    if (frame.kind !== "toolCallUpdated" || frame.data.spec.body.kind !== "qrCard") throw new Error("bad fixture");
    Object.assign(frame.data.spec.body.data, extra);
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects patch-only status on non-patch tool-call", () => {
    const frame: BridgeFrame = {
      kind: "toolCallUpdated",
      data: {
        messageId: "m",
        toolCallId: "tc",
        spec: {
          id: "tc",
          name: "webFetch",
          render: { kind: "chatInline" },
          status: { kind: "reviewing" },
          body: {
            kind: "webFetch",
            data: { urlRef: { id: "u", domain: { kind: "url" } } },
          },
          result: null,
        },
      },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects empty resource id", () => {
    const frame: BridgeFrame = {
      kind: "resourceUpdated",
      data: {
        resourceRef: { id: "", domain: { kind: "file" } },
        summary: null,
        metadata: null,
      },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects toolCallUpdated whose toolCallId differs from spec.id", () => {
    const frame: BridgeFrame = {
      kind: "toolCallUpdated",
      data: {
        messageId: "m",
        toolCallId: "tc-A",
        spec: {
          id: "tc-B",
          name: "x",
          render: { kind: "chatInline" },
          status: { kind: "pending" },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("accepts a valid frame", () => {
    const frame: BridgeFrame = {
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: true },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
  });

  it("validates folderSourcesChanged frames and rejects private or malformed fields", () => {
    const source = {
      id: "fld_valid",
      sessionId: "sess_valid",
      provider: "desktop-local",
      name: "Docs",
      pathLabel: "~/Docs",
      mountName: "source_valid",
      mountPath: "/sources/source_valid",
      readOnly: true,
      fileCount: 1,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    } as const;
    const okFrame: BridgeFrame = {
      kind: "folderSourcesChanged",
      data: { sessionId: "sess_valid", sources: [source] },
    };
    expect(() => validateBridgeFrame(okFrame)).not.toThrow();
    expect(() => validateBridgeFrame({ kind: "folderSourcesChanged" } as BridgeFrame)).toThrow(
      BridgeFrameValidationError,
    );
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourcesChanged",
        data: { sessionId: "sess_valid", sources: [{ ...source, desktopRootPath: "/Users/private" }] },
      } as unknown as BridgeFrame),
    ).toThrow(BridgeFrameValidationError);
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourcesChanged",
        data: { sessionId: "sess_valid", sources: [{ ...source, readOnly: false }] },
      } as unknown as BridgeFrame),
    ).toThrow(BridgeFrameValidationError);
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourcesChanged",
        data: { sessionId: "sess_valid", sources: [{ ...source, fileCount: Number.NaN }] },
      } as BridgeFrame),
    ).toThrow(BridgeFrameValidationError);
  });

  it("validates folderSourceOperationResult frames", () => {
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourceOperationResult",
        data: {
          ok: true,
          op: "attach",
          requestId: "attach-valid",
          clientSourceId: "browser-valid",
          folderId: "fld_valid",
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourceOperationResult",
        data: { ok: true, op: "attach" },
      } as BridgeFrame),
    ).toThrow(BridgeFrameValidationError);
    expect(() =>
      validateBridgeFrame({
        kind: "folderSourceOperationResult",
        data: { ok: false, op: "detach", reason: "prototype_polluted" },
      } as unknown as BridgeFrame),
    ).toThrow(BridgeFrameValidationError);
  });

  it("accepts docWriteResult ok and conflict frames", () => {
    const okFrame: BridgeFrame = {
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
    };
    const conflictFrame: BridgeFrame = {
      kind: "docWriteResult",
      data: {
        ok: false,
        clientMutationId: "mutation-1",
        conflict: { expectedDocumentSnapshot: 1, actualDocumentSnapshot: 2 },
      },
    };
    expect(() => validateBridgeFrame(okFrame)).not.toThrow();
    expect(() => validateBridgeFrame(conflictFrame)).not.toThrow();
  });

  it("accepts valid docDiffReady frames and rejects invalid suggestions", () => {
    const okFrame: BridgeFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        wholeDocument: true,
        editedDoc: {
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [],
        },
        suggestions: [
          {
            id: "h1",
            docId: "doc-1",
            baseVersion: 1,
            baseSchemaVersion: 1,
            status: "reviewing",
            anchor: {
              blockId: "block-1",
              pmFrom: 1,
              pmTo: 2,
              quote: "旧",
              textHash: "test",
            },
            patch: {
              kind: "prosemirror_steps",
              steps: [{ stepType: "replace", from: 1, to: 2 }],
            },
            preview: { deleteText: "旧", insertText: "新" },
            summary: "修改",
          },
        ],
      },
    };
    const badFrame: BridgeFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        suggestions: [
          {
            id: "h1",
            docId: "doc-1",
            baseVersion: 1,
            baseSchemaVersion: 1,
            status: "reviewing",
            anchor: {
              blockId: "",
              pmFrom: 1,
              pmTo: 2,
              quote: "旧",
              textHash: "test",
            },
            patch: {
              kind: "prosemirror_steps",
              steps: [{ stepType: "replace", from: 1, to: 2 }],
            },
            preview: { deleteText: "旧", insertText: "新" },
            summary: "修改",
          },
        ],
      },
    };
    const badEditedDocFrame: BridgeFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        suggestions: [],
        editedDoc: {
          type: "doc",
          attrs: { schemaVersion: 2 },
          content: [],
        } as never,
      },
    };
    const badEditedDocChildFrame: BridgeFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        suggestions: [],
        editedDoc: {
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [{ type: "paragraph", content: [] }],
        } as never,
      },
    };
    const badWholeDocumentFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        suggestions: [],
        wholeDocument: "yes",
      },
    } as unknown as BridgeFrame;

    expect(() => validateBridgeFrame(okFrame)).not.toThrow();
    expect(() => validateBridgeFrame(badFrame)).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame(badEditedDocFrame)).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame(badEditedDocChildFrame)).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame(badWholeDocumentFrame)).toThrow(
      "DocDiffReady.wholeDocument must be a boolean when present",
    );
  });

  it("accepts valid docGenerationEvent frames and rejects malformed PM final docs", () => {
    const okFrame: BridgeFrame = {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "g1",
          seq: 5,
          prevSeq: 4,
          finalVersion: 1,
          contentHash: "pmv1-final",
          doc: {
            type: "doc",
            attrs: { schemaVersion: 1 },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "block-1" },
                content: [{ type: "text", text: "正文", marks: [{ type: "bold" }] }],
              },
            ],
          },
        },
      },
    };
    const badFrame: BridgeFrame = {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "g1",
          seq: 5,
          prevSeq: 4,
          finalVersion: 1,
          contentHash: "pmv1-final",
          doc: { type: "doc", attrs: { schemaVersion: 2 }, content: [] },
        },
      },
    } as unknown as BridgeFrame;

    expect(() => validateBridgeFrame(okFrame)).not.toThrow();
    expect(() => validateBridgeFrame(badFrame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects documentSnapshotWritten frames with malformed PM docs", () => {
    const frame: BridgeFrame = {
      kind: "documentSnapshotWritten",
      data: {
        doc: {
          version: 1,
          ts: "2026-05-08T00:00:00Z",
          doc: {
            type: "doc",
            attrs: { schemaVersion: 1 },
            content: [{ type: "paragraph", content: [] }],
          } as never,
        },
      },
    };

    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("rejects docWriteResult without clientMutationId", () => {
    const frame: BridgeFrame = {
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "", docVersion: 2 },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("accepts valid docCommitted frames", () => {
    const frame: BridgeFrame = {
      kind: "docCommitted",
      data: { sessionId: "s1", version: 2, appliedCount: 1, conflictCount: 1 },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
  });

  it("rejects docCommitted with invalid review result counts", () => {
    const frame: BridgeFrame = {
      kind: "docCommitted",
      data: { sessionId: "s1", version: 2, appliedCount: -1, conflictCount: 0 },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

  it("校验 lexiconEntriesListed 的词库 id 与词条字段", () => {
    const frame: BridgeFrame = {
      kind: "lexiconEntriesListed",
      data: { resourceId: "lex-1", entries: [{ word: "旧称", replacement: "新称", note: null }] },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
    expect(() => validateBridgeFrame({ ...frame, data: { ...frame.data, resourceId: "" } })).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame({ ...frame, data: { ...frame.data, entries: [{ word: "", replacement: null, note: null }] } })).toThrow(BridgeFrameValidationError);
  });

  it("校验词库选择保存帧的 requestId 与 enabled 字段", () => {
    const frame: BridgeFrame = {
      kind: "enabledLexiconsSet",
      data: {
        requestId: "request-1",
        lexicons: [{ id: "lex-1", name: "广告法", entryCount: 2, description: "广告合规", enabled: true }],
      },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
    expect(() => validateBridgeFrame({ ...frame, data: { ...frame.data, requestId: "" } })).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame({
      ...frame,
      data: { ...frame.data, lexicons: [{ ...frame.data.lexicons[0]!, enabled: undefined as never }] },
    })).toThrow(BridgeFrameValidationError);
  });

  it("rejects docCommitted without sessionId", () => {
    const frame: BridgeFrame = {
      kind: "docCommitted",
      data: { sessionId: "", version: 2, appliedCount: 0, conflictCount: 0 },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

});

describe("validateBridgeFrame — annotation severity", () => {
  const frame: BridgeFrame = {
    kind: "annotationGroupsReady",
    data: {
      groups: [{
        id: "g1",
        summary: "数字前后不一",
        note: "两处金额冲突",
        origin: "consistency",
        severity: "error",
        status: "reviewing",
        anchors: [{ blockId: "p1", pmFrom: 1, pmTo: 3, quote: "130", textHash: "hash" }],
      }],
    },
  };

  it("接受 error/warn/info 并拒绝未知严重度", () => {
    expect(() => validateBridgeFrame(frame)).not.toThrow();
    expect(() => validateBridgeFrame({
      ...frame,
      data: { groups: [{ ...frame.data.groups[0]!, severity: "fatal" }] },
    } as unknown as BridgeFrame)).toThrow(BridgeFrameValidationError);
  });
});

describe("validateCommand — sendMessage fileIds", () => {
  it("accepts sendMessage with empty fileIds array", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hello",
        skills: [],
        chips: [],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("accepts sendMessage with valid fileIds", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "check this file",
        skills: [],
        chips: [],
        fileIds: ["abc-123", "def-456"],
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("rejects sendMessage with empty fileId string", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hi",
        skills: [],
        chips: [],
        fileIds: [""],
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });
});

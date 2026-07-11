import { describe, expect, it } from "vitest";
import type {
  AskUserSpec,
  Command,
  BridgeFrame,
} from "@qingagent/contract-ts";
import { validateAskUserSpec, AskUserSpecValidationError } from "../askUserSpec";
import { validateCommand, CommandValidationError } from "../command";
import { validateBridgeFrame, BridgeFrameValidationError } from "../wireFrame";

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
        mentions: [],
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

  it("accepts valid sendMessage", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hi",
        mentions: [{ id: "f", domain: { kind: "file" } }],
        skills: [],
        chips: [],
        fileIds: [],
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("accepts valid updateDoc", () => {
    const cmd: Command = {
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    };
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it("rejects malformed attachFolder and detachFolder commands without TypeError", () => {
    const malformed: unknown[] = [
      { kind: "attachFolder", data: { sessionId: "s" } },
      { kind: "attachFolder", data: { sessionId: "s", source: null } },
      { kind: "attachFolder", data: { sessionId: 123, source: { provider: "desktop-local", selectionToken: "tok" } } },
      { kind: "attachFolder", data: { sessionId: "s", source: { provider: "desktop-local", selectionToken: 123 } } },
      {
        kind: "attachFolder",
        data: {
          sessionId: "s",
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
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "",
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
      data: { state: { kind: "drafting" }, activeOverlay: null, agentBusy: true },
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
        data: { ok: true, op: "attach", folderId: "fld_valid" },
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

    expect(() => validateBridgeFrame(okFrame)).not.toThrow();
    expect(() => validateBridgeFrame(badFrame)).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame(badEditedDocFrame)).toThrow(BridgeFrameValidationError);
    expect(() => validateBridgeFrame(badEditedDocChildFrame)).toThrow(BridgeFrameValidationError);
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
      data: { sessionId: "s1", version: 2 },
    };
    expect(() => validateBridgeFrame(frame)).not.toThrow();
  });

  it("rejects docCommitted without sessionId", () => {
    const frame: BridgeFrame = {
      kind: "docCommitted",
      data: { sessionId: "", version: 2 },
    };
    expect(() => validateBridgeFrame(frame)).toThrow(BridgeFrameValidationError);
  });

});

describe("validateCommand — sendMessage fileIds", () => {
  it("accepts sendMessage with empty fileIds array", () => {
    const cmd: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hello",
        mentions: [],
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
        mentions: [],
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
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [""],
      },
    };
    expect(() => validateCommand(cmd)).toThrow(CommandValidationError);
  });
});

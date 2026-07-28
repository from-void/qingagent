import { describe, expect, it } from "vitest";
import { tableSelectionTextSignature } from "../../TableSelection";
import { commandSchema, COMMAND_KINDS, COMMAND_KIND_SET } from "../command";
import { MAX_COMMAND_ARRAY_LENGTH, MAX_COMMAND_STRING_LENGTH } from "../common";

function sendMessageWithChip(chip: unknown): unknown {
  return {
    kind: "sendMessage",
    data: {
      sessionId: "s",
      text: "修改",
      mentions: [],
      skills: [],
      chips: [chip],
      fileIds: [],
    },
  };
}

function selectionChip(tableSelection: unknown): unknown {
  return {
    kind: { kind: "selection" },
    resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
    prefix: null,
    label: "A | B",
    suffix: "表格·第1行",
    tableSelection,
  };
}

/**
 * 契约包内的 schema 级脏路径测试(与 server 侧等价回归互补)。这里只验 `commandSchema`
 * 本身的接受/拒绝与消毒行为,不依赖 server。
 */
describe("commandSchema", () => {
  it("接受三种衍生稿 dtype，翻译要求目标语言并拒绝未知 dtype", () => {
    const base = { kind: "createDerivative", data: { sessionId: "s", requestId: "request-create", templateId: "xhs-seed", privatePrompt: "" } } as const;
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, dtype: "gzh" } }).success).toBe(true);
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, dtype: "xhs" } }).success).toBe(true);
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, dtype: "translate", targetLang: "英语" } }).success).toBe(true);
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, dtype: "translate" } }).success).toBe(false);
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, dtype: "ppt" } }).success).toBe(false);
  });
  it("封面模板参数只接受五款已知值", () => {
    const base = { kind: "updateDerivativeParams", data: { sessionId: "s", requestId: "request-update", docId: "d" } } as const;
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, coverTemplate: "wenkai" } }).success).toBe(true);
    expect(commandSchema.safeParse({ ...base, data: { ...base.data, coverTemplate: "unknown" } }).success).toBe(false);
  });
  it("generateTranslations 接受 1-5 个唯一稿件 id", () => {
    expect(commandSchema.safeParse({ kind: "generateTranslations", data: { sessionId: "s", docIds: ["en", "ja"] } }).success).toBe(true);
    expect(commandSchema.safeParse({ kind: "generateTranslations", data: { sessionId: "s", docIds: [] } }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: "generateTranslations", data: { sessionId: "s", docIds: ["en", "en"] } }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: "generateTranslations", data: { sessionId: "s", docIds: ["1", "2", "3", "4", "5", "6"] } }).success).toBe(false);
  });

  it("COMMAND_KINDS 覆盖 38 种且与 Set 一致", () => {
    expect(COMMAND_KINDS).toHaveLength(38);
    expect(COMMAND_KIND_SET.size).toBe(38);
    for (const kind of COMMAND_KINDS) expect(COMMAND_KIND_SET.has(kind)).toBe(true);
  });

  it("接受 draftTemplate 的审查与衍生场景并拒绝空场景标签", () => {
    expect(commandSchema.safeParse({
      kind: "draftTemplate",
      data: { sessionId: "s", requestId: "request-draft-1", scene: { kind: "review", type: "role", label: "角色审查" }, intent: { name: "", prompt: "" } },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "draftTemplate",
      data: { sessionId: "s", requestId: "request-draft-2", scene: { kind: "derivative", dtype: "gzh", slot: "layout", label: "公众号排版" }, intent: { name: "卡片式", prompt: "短段落" } },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "draftTemplate",
      data: { sessionId: "s", requestId: "request-draft-3", scene: { kind: "review", type: "role", label: " " }, intent: { name: "", prompt: "" } },
    }).success).toBe(false);
  });

  it("listLexiconEntries 要求会话与词库 id 都非空", () => {
    expect(commandSchema.safeParse({ kind: "listLexiconEntries", data: { sessionId: "s", resourceId: "lex-1" } }).success).toBe(true);
    expect(commandSchema.safeParse({ kind: "listLexiconEntries", data: { sessionId: "s", resourceId: "" } }).success).toBe(false);
  });

  it("renameSession 修剪标题并拒绝空串与超长标题", () => {
    expect(commandSchema.parse({
      kind: "renameSession",
      data: { sessionId: "s", title: "  我的标题  " },
    })).toEqual({ kind: "renameSession", data: { sessionId: "s", title: "我的标题" } });
    expect(commandSchema.safeParse({ kind: "renameSession", data: { sessionId: "s", title: "  " } }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: "renameSession", data: { sessionId: "s", title: "长".repeat(49) } }).success).toBe(false);
  });

  it("接受合法 sendMessage", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: { sessionId: "s", text: "hi", mentions: [], skills: [], chips: [], fileIds: [] },
    });
    expect(r.success).toBe(true);
  });

  it("拒绝已弃用的非空 mentions 并指引改用 chips", () => {
    const result = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hi",
        mentions: [{ id: "mention-1", domain: { kind: "mention" } }],
        skills: [],
        chips: [],
        fileIds: [],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["data", "mentions"],
        message: "mentions is deprecated; use chips instead",
      }),
    ]));
  });

  it("mentions 缺省时补为空数组", () => {
    const result = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hi",
        skills: [],
        chips: [],
        fileIds: [],
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "sendMessage") {
      expect(result.data.data.mentions).toEqual([]);
    }
  });

  it("sendMessage 文本与资源字符串在 64 KiB 边界通过，加一拒绝", () => {
    const baseData = {
      sessionId: "s",
      mentions: [],
      skills: [],
      chips: [],
      fileIds: [],
    };
    expect(commandSchema.safeParse({
      kind: "sendMessage",
      data: { ...baseData, text: "x".repeat(MAX_COMMAND_STRING_LENGTH) },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "sendMessage",
      data: { ...baseData, text: "x".repeat(MAX_COMMAND_STRING_LENGTH + 1) },
    }).success).toBe(false);

    const chipAtLimit = {
      kind: { kind: "selection" },
      resourceRef: {
        id: "x".repeat(MAX_COMMAND_STRING_LENGTH),
        domain: { kind: "docSpan" },
      },
      prefix: null,
      label: "选区",
      suffix: null,
    };
    expect(commandSchema.safeParse(sendMessageWithChip(chipAtLimit)).success).toBe(true);
    expect(commandSchema.safeParse(sendMessageWithChip({
      ...chipAtLimit,
      resourceRef: {
        ...chipAtLimit.resourceRef,
        id: `${chipAtLimit.resourceRef.id}x`,
      },
    })).success).toBe(false);
  });

  it.each([
    ["skills", (): unknown => ({ id: "skill", version: null })],
    ["chips", (): unknown => ({
      kind: { kind: "text" },
      resourceRef: null,
      prefix: null,
      label: "长文本",
      suffix: null,
    })],
    ["fileIds", (): unknown => "00000000-0000-4000-8000-000000000000"],
  ] as const)("sendMessage.%s 数组在 1000 项边界通过，加一拒绝", (field, makeItem) => {
    const makeCommand = (length: number) => ({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "x",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
        [field]: Array.from({ length }, makeItem),
      },
    });

    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH)).success).toBe(true);
    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH + 1)).success).toBe(false);
  });

  it.each([
    ["commitPatches.ids", (ids: string[]) => ({ kind: "commitPatches", data: { ids } })],
    ["commitPatches.reviewBatchIds", (ids: string[]) => ({
      kind: "commitPatches",
      data: { ids: [], reviewBatchIds: ids },
    })],
    ["commitReviewGroups.acceptReviewBatchIds", (ids: string[]) => ({
      kind: "commitReviewGroups",
      data: { acceptReviewBatchIds: ids },
    })],
    ["commitReviewGroups.rejectReviewBatchIds", (ids: string[]) => ({
      kind: "commitReviewGroups",
      data: { acceptReviewBatchIds: [], rejectReviewBatchIds: ids },
    })],
    ["commitReviewGroups.keepPendingReviewBatchIds", (ids: string[]) => ({
      kind: "commitReviewGroups",
      data: { acceptReviewBatchIds: [], keepPendingReviewBatchIds: ids },
    })],
  ] as const)("%s 在 1000 项边界通过，加一拒绝", (_field, makeCommand) => {
    const atLimit = Array.from({ length: MAX_COMMAND_ARRAY_LENGTH }, (_, index) => `id-${index}`);
    const overLimit = [...atLimit, "one-more"];
    expect(commandSchema.safeParse(makeCommand(atLimit)).success).toBe(true);
    expect(commandSchema.safeParse(makeCommand(overLimit)).success).toBe(false);
  });

  it("updateDoc.legacySections 在 1000 项边界通过，加一拒绝", () => {
    const makeCommand = (length: number) => ({
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        legacySections: Array.from({ length }, () => ({ kind: "p", data: { text: "x" } })),
        clientMutationId: "m",
      },
    });
    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH)).success).toBe(true);
    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH + 1)).success).toBe(false);
  });

  it("updateDoc.doc.content 在 1000 个顶层块边界通过，加一拒绝", () => {
    const makeCommand = (length: number) => ({
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        doc: {
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: Array.from({ length }, () => ({ type: "paragraph" })),
        },
        clientMutationId: "m",
      },
    });
    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH)).success).toBe(true);
    expect(commandSchema.safeParse(makeCommand(MAX_COMMAND_ARRAY_LENGTH + 1)).success).toBe(false);
  });

  it("updateDoc.baseContentHash 接受非空哈希并拒绝空串", () => {
    const makeCommand = (baseContentHash: string) => ({
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        baseContentHash,
        legacySections: [],
        clientMutationId: "m",
      },
    });
    expect(commandSchema.safeParse(makeCommand("pmv1-base")).success).toBe(true);
    expect(commandSchema.safeParse(makeCommand("")).success).toBe(false);
  });

  it("保留 selection chip 的 tableSelection 字段", () => {
    const tableSelection = {
      axis: "row",
      startIndex: 0,
      endIndex: 1,
      signature: tableSelectionTextSignature(["A", "B"]),
    } as const;
    const parsed = commandSchema.parse(sendMessageWithChip(selectionChip(tableSelection)));
    expect(parsed.kind).toBe("sendMessage");
    if (parsed.kind === "sendMessage") {
      expect(parsed.data.chips[0]?.tableSelection).toEqual(tableSelection);
    }
  });

  it.each([
    ["负数", { axis: "row", startIndex: -1, endIndex: 0 }],
    ["小数", { axis: "row", startIndex: 0.5, endIndex: 1 }],
    ["反向", { axis: "column", startIndex: 2, endIndex: 1 }],
    ["非法 axis", { axis: "cell", startIndex: 0, endIndex: 1 }],
  ])("拒绝 tableSelection 脏值:%s", (_label, tableSelection) => {
    expect(commandSchema.safeParse(sendMessageWithChip(selectionChip(tableSelection))).success).toBe(false);
  });

  it("拒绝非 selection chip 携带 tableSelection", () => {
    expect(commandSchema.safeParse(sendMessageWithChip({
      kind: { kind: "text" },
      resourceRef: null,
      prefix: null,
      label: "正文",
      suffix: null,
      tableSelection: { axis: "row", startIndex: 0, endIndex: 0 },
    })).success).toBe(false);
  });

  it.each([
    ["selection 缺 ref", { kind: { kind: "selection" }, resourceRef: null }],
    ["selection 域错误", {
      kind: { kind: "selection" },
      resourceRef: { id: "position-1", domain: { kind: "docPosition" } },
    }],
    ["insertion 缺 ref", { kind: { kind: "insertion" }, resourceRef: null }],
    ["insertion 域错误", {
      kind: { kind: "insertion" },
      resourceRef: { id: "span-1", domain: { kind: "docSpan" } },
    }],
    ["attach 缺 ref", { kind: { kind: "attach" }, resourceRef: null }],
    ["attach 域错误", {
      kind: { kind: "attach" },
      resourceRef: { id: "source-1", domain: { kind: "source" } },
    }],
    ["mention 缺 ref", { kind: { kind: "mention" }, resourceRef: null }],
    ["ref id 为空", {
      kind: { kind: "mention" },
      resourceRef: { id: "", domain: { kind: "mention" } },
    }],
    ["skill 携带 ref", {
      kind: { kind: "skill" },
      resourceRef: { id: "skill-1", domain: { kind: "mention" } },
    }],
    ["text 携带 ref", {
      kind: { kind: "text" },
      resourceRef: { id: "text-1", domain: { kind: "mention" } },
    }],
  ])("服务端命令边界拒绝 kind/ref 关系错误:%s", (_label, partialChip) => {
    expect(commandSchema.safeParse(sendMessageWithChip({
      prefix: null,
      label: "引用",
      suffix: null,
      ...partialChip,
    })).success).toBe(false);
  });

  it.each([
    ["selection", "docSpan"],
    ["insertion", "docPosition"],
    ["attach", "file"],
    ["attach", "image"],
    ["attach", "url"],
    ["mention", "source"],
  ])("服务端命令边界接受 %s/%s chip", (kind, domain) => {
    expect(commandSchema.safeParse(sendMessageWithChip({
      kind: { kind },
      resourceRef: { id: "resource-1", domain: { kind: domain } },
      prefix: null,
      label: "引用",
      suffix: null,
    })).success).toBe(true);
  });

  it("表格选区签名按单元格边界和顺序稳定区分", () => {
    expect(tableSelectionTextSignature(["ab", "c"])).not.toBe(tableSelectionTextSignature(["a", "bc"]));
    expect(tableSelectionTextSignature(["A", "B"])).not.toBe(tableSelectionTextSignature(["B", "A"]));
    expect(tableSelectionTextSignature(["A", "B"])).toBe(tableSelectionTextSignature(["A", "B"]));
  });

  it("接受带通用展示动作卡的 sendMessage", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "模型载荷",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
        turnContext: "[系统:用户当前正查看衍生稿(doc_id: d-1)]",
        displayCard: {
          icon: "✦",
          title: "生成公众号稿",
          lines: [{ label: "模板", value: "深度长文" }],
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "sendMessage") {
      expect(r.data.data.displayCard?.title).toBe("生成公众号稿");
      expect(r.data.data.turnContext).toContain("doc_id: d-1");
    }
  });

  it("审查 query 保留结构化类型与模板标识", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "对当前文档做去AI味审查",
        mentions: [], skills: [], chips: [], fileIds: [],
        reviewContext: { type: "deai", templateId: "review-deai-deep", templateName: "深度重写" },
      },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "sendMessage") {
      expect(r.data.data.reviewContext).toEqual({
        type: "deai",
        templateId: "review-deai-deep",
        templateName: "深度重写",
      });
    }
    expect(commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s", text: "审查", mentions: [], skills: [], chips: [], fileIds: [],
        reviewContext: { type: "unknown", templateId: "x", templateName: "x" },
      },
    }).success).toBe(false);
  });

  it("接受 role 审查上下文", () => {
    const result = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s", text: "角色审查", mentions: [], skills: [], chips: [], fileIds: [],
        reviewContext: { type: "role", templateId: "review-role-engineer", templateName: "研发工程师" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("fileIds 缺省时补为空数组", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: { sessionId: "s", text: "hi", mentions: [], skills: [], chips: [] },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "sendMessage") {
      expect(r.data.data.fileIds).toEqual([]);
    }
  });

  it("接受合法 reparseMaterial", () => {
    const r = commandSchema.safeParse({
      kind: "reparseMaterial",
      data: { sessionId: "s", fileId: "file-1" },
    });
    expect(r.success).toBe(true);
  });

  it.each([
    { sessionId: "session-planning" },
    { streamId: "stream-writing" },
    { sessionId: "session-writing", streamId: "stream-writing" },
  ])("接受规划期或写作期 cancelStream 载荷:%j", (data) => {
    expect(commandSchema.safeParse({ kind: "cancelStream", data }).success).toBe(true);
  });

  it("接受 commitReviewGroups 的 accept/reject/keep-pending 原子载荷", () => {
    const r = commandSchema.safeParse({
      kind: "commitReviewGroups",
      data: {
        acceptReviewBatchIds: ["accept-1"],
        rejectReviewBatchIds: ["reject-1"],
        keepPendingReviewBatchIds: ["pending-1"],
      },
    });

    expect(r.success).toBe(true);
  });

  it.each([
    { kind: "listReviewTemplates", data: { sessionId: "s", requestId: "request-list", type: "source" } },
    { kind: "saveReviewTemplate", data: { sessionId: "s", requestId: "request-save", type: "source", name: "我的模板", prompt: "核对金额" } },
    { kind: "deleteReviewTemplate", data: { sessionId: "s", requestId: "request-delete", id: "review-1" } },
    { kind: "selectReviewTemplate", data: { sessionId: "s", requestId: "request-select", type: "source", templateId: "review-1" } },
    { kind: "getReviewSupplement", data: { sessionId: "s", requestId: "request-get", type: "source" } },
    { kind: "upsertReviewSupplement", data: { sessionId: "s", requestId: "request-upsert", type: "source", supplement: "只看金额" } },
  ])("接受审查模板命令:$kind", (body) => {
    expect(commandSchema.safeParse(body).success).toBe(true);
  });

  it("单条忽略可选择沉淀下次不再提示信号", () => {
    expect(commandSchema.safeParse({
      kind: "ignoreAnnotationGroups",
      data: { sessionId: "s", reason: "item_ignored", groupIds: ["g1"], rememberDismissal: true },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "ignoreAnnotationGroups",
      data: { sessionId: "s", reason: "item_ignored", rememberDismissal: true },
    }).success).toBe(false);
  });

  it.each([
    ["未知 kind", { kind: "bogus", data: {} }],
    ["非对象 body", 42],
    ["数组 body", []],
    ["kind 非字符串", { kind: 1, data: {} }],
    ["sendMessage 缺 data", { kind: "sendMessage" }],
    ["sendMessage sessionId 空", { kind: "sendMessage", data: { sessionId: "", text: "x", mentions: [], skills: [], chips: [], fileIds: [] } }],
    ["fileIds 含非 UUID", { kind: "sendMessage", data: { sessionId: "s", text: "x", mentions: [], skills: [], chips: [], fileIds: ["nope"] } }],
    ["fileIds 含非字符串", { kind: "sendMessage", data: { sessionId: "s", text: "x", mentions: [], skills: [], chips: [], fileIds: [1] } }],
    ["cancelStream 缺 sessionId/streamId", { kind: "cancelStream", data: {} }],
    ["cancelStream sessionId 空", { kind: "cancelStream", data: { sessionId: "" } }],
    ["acceptPatch 两者皆空", { kind: "acceptPatch", data: {} }],
    ["commitPatches 空 ids", { kind: "commitPatches", data: { ids: [] } }],
    ["commitReviewGroups accept 含空 id", { kind: "commitReviewGroups", data: { acceptReviewBatchIds: [""] } }],
    ["commitReviewGroups accept/reject 重叠", {
      kind: "commitReviewGroups",
      data: {
        acceptReviewBatchIds: ["batch-1", "batch-2"],
        rejectReviewBatchIds: ["batch-2"],
      },
    }],
    ["commitReviewGroups accept/keep-pending 重叠", {
      kind: "commitReviewGroups",
      data: {
        acceptReviewBatchIds: ["batch-1", "batch-2"],
        keepPendingReviewBatchIds: ["batch-2"],
      },
    }],
    ["commitReviewGroups reject/keep-pending 重叠", {
      kind: "commitReviewGroups",
      data: {
        acceptReviewBatchIds: [],
        rejectReviewBatchIds: ["batch-1", "batch-2"],
        keepPendingReviewBatchIds: ["batch-2"],
      },
    }],
    ["resumeAskUser 缺 toolCallId", { kind: "resumeAskUser", data: { sessionId: "s", answers: { q1: { chosen: [], freeText: "x" } } } }],
    ["resumeAskUser 空 answers", { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "t", answers: {} } }],
    ["resumeAskUser 空 toolCallId", { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "", answers: { q1: { chosen: [], freeText: "x" } } } }],
    ["reparseMaterial sessionId 空", { kind: "reparseMaterial", data: { sessionId: "", fileId: "file-1" } }],
    ["reparseMaterial fileId 空", { kind: "reparseMaterial", data: { sessionId: "s", fileId: "" } }],
    ["attachFolder 未知 provider", { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "ftp" } } }],
    ["attachFolder 超长 token", { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-long-token", source: { provider: "desktop-local", selectionToken: "x".repeat(257) } } }],
  ])("拒绝:%s", (_label, body) => {
    expect(commandSchema.safeParse(body).success).toBe(false);
  });

  it("strip 未知字段(顶层 + data 内)", () => {
    const r = commandSchema.safeParse({
      kind: "cancelStream",
      evil: 1,
      data: { streamId: "x", evil2: 2 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty("evil");
      expect(r.data.data).not.toHaveProperty("evil2");
    }
  });
});

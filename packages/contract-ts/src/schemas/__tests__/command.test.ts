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
  it("externalPropose 接受 setTitle 局部操作，并禁止整稿与任何其它操作混用", () => {
    const base = {
      kind: "externalPropose",
      data: { sessionId: "s", expectedDocVersion: 0, clientMutationId: "m" },
    } as const;
    expect(commandSchema.safeParse({
      ...base,
      data: { ...base.data, ops: [{ kind: "qingmlDraft", qingml: "<p>正文</p>" }] },
    }).success).toBe(true);
    expect(commandSchema.parse({
      ...base,
      data: { ...base.data, ops: [{ kind: "setTitle", title: "  新标题  " }] },
    })).toMatchObject({
      data: { ops: [{ kind: "setTitle", title: "新标题" }] },
    });
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        ops: [
          { kind: "setTitle", title: "新标题" },
          { kind: "appendSection", markdown: "追加" },
        ],
      },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      ...base,
      data: { ...base.data, ops: [{ kind: "setTitle", title: "  " }] },
    }).success).toBe(false);
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        ops: [
          { kind: "setTitle", title: "标题一" },
          { kind: "setTitle", title: "标题二" },
        ],
      },
    }).success).toBe(false);
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        ops: [
          { kind: "qingmlDraft", qingml: "<p>正文</p>" },
          { kind: "appendSection", markdown: "追加" },
        ],
      },
    }).success).toBe(false);
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        ops: [
          { kind: "fullDraft", markdown: "正文" },
          { kind: "qingmlDraft", qingml: "<p>正文</p>" },
        ],
      },
    }).success).toBe(false);
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        ops: [
          { kind: "fullDraft", markdown: "正文" },
          { kind: "setTitle", title: "新标题" },
        ],
      },
    }).success).toBe(false);
  });

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

  it("COMMAND_KINDS 覆盖 39 种且与 Set 一致", () => {
    expect(COMMAND_KINDS).toHaveLength(39);
    expect(COMMAND_KIND_SET.size).toBe(39);
    for (const kind of COMMAND_KINDS) expect(COMMAND_KIND_SET.has(kind)).toBe(true);
  });

  it("接受 askMore 两阶段更新命令并拒绝 completed 阶段的 slider 问题", () => {
    const base = {
      kind: "updateAskMore",
      data: {
        phase: "completed",
        sessionId: "s",
        toolCallId: "plan-draft-1",
        questions: [{
          id: "q-extra-note",
          label: "还有什么要求？",
          kind: { kind: "text" },
          options: [],
          placeholder: "可选",
        }],
      },
    };
    expect(commandSchema.safeParse({
      kind: "updateAskMore",
      data: { phase: "started", sessionId: "s", toolCallId: "plan-draft-1" },
    }).success).toBe(true);
    expect(commandSchema.safeParse(base).success).toBe(true);
    expect(commandSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        questions: [{ ...base.data.questions[0], kind: { kind: "slider" } }],
      },
    }).success).toBe(false);
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

  it("setEnabledLexicons 接受空启用集合并拒绝空词库 id", () => {
    expect(commandSchema.safeParse({
      kind: "setEnabledLexicons",
      data: { sessionId: "s", requestId: "request-1", enabledLexiconIds: [] },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "setEnabledLexicons",
      data: { sessionId: "s", requestId: "request-2", enabledLexiconIds: [""] },
    }).success).toBe(false);
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
      data: { sessionId: "s", text: "hi", skills: [], chips: [], fileIds: [] },
    });
    expect(r.success).toBe(true);
  });

  it("sendMessage 文本与资源字符串在 64 KiB 边界通过，加一拒绝", () => {
    const baseData = {
      sessionId: "s",
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

  it("updateDoc.doc.content 在 1000 个顶层块边界通过，加一拒绝", () => {
    const makeCommand = (length: number) => ({
      kind: "updateDoc",
      data: {
        sessionId: "s",
        expectedDocumentSnapshot: 1,
        baseContentHash: "pmv1-base",
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
        doc: {
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [],
        },
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
        skills: [],
        chips: [],
        fileIds: [],
        turnKind: "generateDerivative",
        displayCard: {
          icon: "✦",
          title: "生成公众号稿",
          lines: [{ label: "模板", value: "深度长文" }],
          status: "done",
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "sendMessage") {
      expect(r.data.data.displayCard?.title).toBe("生成公众号稿");
      expect(r.data.data.turnKind).toBe("generateDerivative");
    }
  });

  it("拒绝把任意字符串伪装成模型调用 site", () => {
    expect(commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "生成衍生稿",
        skills: [],
        chips: [],
        fileIds: [],
        turnKind: "agentReviewSensitive",
      },
    }).success).toBe(false);
  });

  it("接受结构化的当前文档目标并拒绝空衍生稿 id", () => {
    const base = {
      sessionId: "s",
      text: "把第二段改短一点",
      skills: [],
      chips: [],
      fileIds: [],
    };
    const main = commandSchema.safeParse({
      kind: "sendMessage",
      data: { ...base, activeDocument: { kind: "main" } },
    });
    const derivative = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        ...base,
        activeDocument: { kind: "derivative", docId: "derivative-1" },
      },
    });
    const emptyDerivative = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        ...base,
        activeDocument: { kind: "derivative", docId: "" },
      },
    });

    expect(main.success).toBe(true);
    expect(derivative.success).toBe(true);
    expect(emptyDerivative.success).toBe(false);
  });

  it("审查 query 保留结构化类型与模板标识", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "对当前文档做去AI味审查",
    skills: [], chips: [], fileIds: [],
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
        sessionId: "s", text: "审查", skills: [], chips: [], fileIds: [],
        reviewContext: { type: "unknown", templateId: "x", templateName: "x" },
      },
    }).success).toBe(false);
  });

  it("接受 role 审查上下文", () => {
    const result = commandSchema.safeParse({
      kind: "sendMessage",
      data: {
        sessionId: "s", text: "角色审查", skills: [], chips: [], fileIds: [],
        reviewContext: { type: "role", templateId: "review-role-engineer", templateName: "研发工程师" },
      },
    });
    expect(result.success).toBe(true);
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

  it("单条忽略只需指定组，批量清理仍可缺省 groupIds", () => {
    expect(commandSchema.safeParse({
      kind: "ignoreAnnotationGroups",
      data: { sessionId: "s", reason: "item_ignored", groupIds: ["g1"] },
    }).success).toBe(true);
    expect(commandSchema.safeParse({
      kind: "ignoreAnnotationGroups",
      data: { sessionId: "s", reason: "discard_all" },
    }).success).toBe(true);
  });

  it.each([
    ["未知 kind", { kind: "bogus", data: {} }],
    ["非对象 body", 42],
    ["数组 body", []],
    ["kind 非字符串", { kind: 1, data: {} }],
    ["sendMessage 缺 data", { kind: "sendMessage" }],
    ["sendMessage sessionId 空", { kind: "sendMessage", data: { sessionId: "", text: "x", skills: [], chips: [], fileIds: [] } }],
    ["fileIds 含非 UUID", { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [], fileIds: ["nope"] } }],
    ["fileIds 含非字符串", { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [], fileIds: [1] } }],
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

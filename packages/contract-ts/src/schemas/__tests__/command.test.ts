import { describe, expect, it } from "vitest";
import { tableSelectionTextSignature } from "../../TableSelection";
import { commandSchema, COMMAND_KINDS, COMMAND_KIND_SET } from "../command";

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
  it("COMMAND_KINDS 覆盖 17 种且与 Set 一致", () => {
    expect(COMMAND_KINDS).toHaveLength(17);
    expect(COMMAND_KIND_SET.size).toBe(17);
    for (const kind of COMMAND_KINDS) expect(COMMAND_KIND_SET.has(kind)).toBe(true);
  });

  it("接受合法 sendMessage", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: { sessionId: "s", text: "hi", mentions: [], skills: [], chips: [], fileIds: [] },
    });
    expect(r.success).toBe(true);
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

  it("表格选区签名按单元格边界和顺序稳定区分", () => {
    expect(tableSelectionTextSignature(["ab", "c"])).not.toBe(tableSelectionTextSignature(["a", "bc"]));
    expect(tableSelectionTextSignature(["A", "B"])).not.toBe(tableSelectionTextSignature(["B", "A"]));
    expect(tableSelectionTextSignature(["A", "B"])).toBe(tableSelectionTextSignature(["A", "B"]));
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
    ["未知 kind", { kind: "bogus", data: {} }],
    ["非对象 body", 42],
    ["数组 body", []],
    ["kind 非字符串", { kind: 1, data: {} }],
    ["sendMessage 缺 data", { kind: "sendMessage" }],
    ["sendMessage sessionId 空", { kind: "sendMessage", data: { sessionId: "", text: "x", mentions: [], skills: [], chips: [], fileIds: [] } }],
    ["fileIds 含非 UUID", { kind: "sendMessage", data: { sessionId: "s", text: "x", mentions: [], skills: [], chips: [], fileIds: ["nope"] } }],
    ["fileIds 含非字符串", { kind: "sendMessage", data: { sessionId: "s", text: "x", mentions: [], skills: [], chips: [], fileIds: [1] } }],
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
    ["resumeAskUser 空 answers", { kind: "resumeAskUser", data: { sessionId: "s", answers: {} } }],
    ["resumeAskUser 空 toolCallId", { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "", answers: { q1: { chosen: [], freeText: "x" } } } }],
    ["reparseMaterial sessionId 空", { kind: "reparseMaterial", data: { sessionId: "", fileId: "file-1" } }],
    ["reparseMaterial fileId 空", { kind: "reparseMaterial", data: { sessionId: "s", fileId: "" } }],
    ["attachFolder 未知 provider", { kind: "attachFolder", data: { sessionId: "s", source: { provider: "ftp" } } }],
    ["attachFolder 超长 token", { kind: "attachFolder", data: { sessionId: "s", source: { provider: "desktop-local", selectionToken: "x".repeat(257) } } }],
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

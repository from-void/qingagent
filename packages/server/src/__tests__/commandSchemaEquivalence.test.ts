import { describe, expect, it } from "vitest";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import { validateCommandKind } from "../routes/stream";

/**
 * 命令 schema 契约回归矩阵。
 *
 * 逐条 fixture 验证 zod `commandSchema` 对合法输入放行、对畸形输入拒绝；
 * 错误文案不逐字锁定，只断言非空字符串。
 */

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_PM_DOC = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
};

interface CommandFixture {
  name: string;
  body: unknown;
}

// ——— 分区一:应接受的契约有效输入 ———
const sharedAccept: CommandFixture[] = [
  { name: "startSession/new", body: { kind: "startSession", data: { mode: { kind: "new", data: { template: null } } } } },
  { name: "startSession/new+sessionId", body: { kind: "startSession", data: { mode: { kind: "new", data: { template: "blank", sessionId: "sess-1" } } } } },
  { name: "startSession/existing", body: { kind: "startSession", data: { mode: { kind: "existing", data: { id: "sess-2" } } } } },
  { name: "sendMessage/minimal", body: { kind: "sendMessage", data: { sessionId: "s", text: "hi", skills: [], chips: [], fileIds: [] } } },
  {
    name: "sendMessage/rich-elements",
    body: {
      kind: "sendMessage",
      data: {
        sessionId: "s",
        text: "hi @x",
        skills: [{ id: "browser-ops", version: null }],
        chips: [{ kind: { kind: "text" }, resourceRef: null, prefix: null, label: "L", suffix: null }],
        fileIds: [VALID_UUID],
        clientMessageId: "cm-1",
        richText: "hi {{chip:0}}",
      },
    },
  },
  { name: "cancelStream", body: { kind: "cancelStream", data: { streamId: "str-1" } } },
  { name: "acceptPatch/id", body: { kind: "acceptPatch", data: { id: "p1" } } },
  { name: "acceptPatch/reviewBatchId", body: { kind: "acceptPatch", data: { reviewBatchId: "b1" } } },
  { name: "rejectPatch/id", body: { kind: "rejectPatch", data: { id: "p1" } } },
  { name: "commitPatches/ids", body: { kind: "commitPatches", data: { ids: ["p1", "p2"] } } },
  { name: "commitPatches/ids+batches", body: { kind: "commitPatches", data: { ids: ["p1"], reviewBatchIds: ["b1"] } } },
  {
    name: "submitReviewOutcome",
    body: {
      kind: "submitReviewOutcome",
      data: {
        sessionId: "s",
        outcome: {
          acceptedCount: 1,
          rejectedCount: 0,
          hunks: [{ verdict: "accepted", blockSummary: "b", beforeText: "a", afterText: "c" }],
        },
      },
    },
  },
  { name: "resumeAskUser", body: { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "t", answers: { q1: { chosen: ["a"], freeText: null } } } } },
  { name: "resumeAskUser/numeric", body: { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "t", answers: { q1: { chosen: [], freeText: null, numericValue: 3 } } } } },
  { name: "cancelAskUser", body: { kind: "cancelAskUser", data: { sessionId: "s", toolCallId: "t" } } },
  { name: "updateDoc", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1, baseContentHash: "pmv1-base", clientMutationId: "m", doc: VALID_PM_DOC } } },
  { name: "updateMaterialSummary/empty-summary", body: { kind: "updateMaterialSummary", data: { sessionId: "s", materialId: "m", summary: "" } } },
  { name: "removeMaterial", body: { kind: "removeMaterial", data: { sessionId: "s", materialId: "m" } } },
  { name: "attachFolder/desktop", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-desktop", source: { provider: "desktop-local", selectionToken: "tok" } } } },
  { name: "attachFolder/browser", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-browser", source: { provider: "browser-fs-access", clientSourceId: "c", name: "docs", browserHandleKey: "h" } } } },
  { name: "detachFolder", body: { kind: "detachFolder", data: { sessionId: "s", folderId: "f" } } },
];

// ——— 分区二:应拒绝的畸形输入 ———
const sharedReject: CommandFixture[] = [
  { name: "null", body: null },
  { name: "number", body: 42 },
  { name: "string", body: "nope" },
  { name: "array", body: [] },
  { name: "kind-missing", body: { data: {} } },
  { name: "kind-not-string", body: { kind: 1, data: {} } },
  { name: "unknown-kind", body: { kind: "bogus", data: {} } },
  { name: "sendMessage/no-data", body: { kind: "sendMessage" } },
  { name: "sendMessage/missing-sessionId", body: { kind: "sendMessage", data: { text: "x", skills: [], chips: [], fileIds: [] } } },
  { name: "sendMessage/empty-sessionId", body: { kind: "sendMessage", data: { sessionId: "", text: "x", skills: [], chips: [], fileIds: [] } } },
  { name: "sendMessage/text-not-string", body: { kind: "sendMessage", data: { sessionId: "s", text: 1, skills: [], chips: [], fileIds: [] } } },
  { name: "sendMessage/skills-not-array", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: "no", chips: [], fileIds: [] } } },
  { name: "sendMessage/fileIds-not-array", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [], fileIds: "no" } } },
  { name: "sendMessage/fileIds-non-string", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [], fileIds: [123] } } },
  { name: "sendMessage/fileIds-non-uuid", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [], fileIds: ["../secret"] } } },
  { name: "cancelStream/missing", body: { kind: "cancelStream", data: {} } },
  { name: "acceptPatch/empty", body: { kind: "acceptPatch", data: {} } },
  { name: "rejectPatch/empty", body: { kind: "rejectPatch", data: {} } },
  { name: "commitPatches/empty-obj", body: { kind: "commitPatches", data: {} } },
  { name: "commitPatches/empty-ids", body: { kind: "commitPatches", data: { ids: [] } } },
  { name: "commitPatches/blank-id", body: { kind: "commitPatches", data: { ids: [""] } } },
  { name: "submitReviewOutcome/bad-verdict", body: { kind: "submitReviewOutcome", data: { sessionId: "s", outcome: { acceptedCount: 1, rejectedCount: 0, hunks: [{ verdict: "maybe", blockSummary: "b", beforeText: "a", afterText: "c" }] } } } },
  { name: "submitReviewOutcome/negative-count", body: { kind: "submitReviewOutcome", data: { sessionId: "s", outcome: { acceptedCount: -1, rejectedCount: 0, hunks: [] } } } },
  { name: "resumeAskUser/missing-toolCallId", body: { kind: "resumeAskUser", data: { sessionId: "s", answers: { q1: { chosen: [], freeText: "x" } } } } },
  { name: "resumeAskUser/empty-answers", body: { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "t", answers: {} } } },
  { name: "cancelAskUser/missing-toolCallId", body: { kind: "cancelAskUser", data: { sessionId: "s" } } },
  { name: "updateDoc/missing-sessionId", body: { kind: "updateDoc", data: { sessionId: "", expectedDocumentSnapshot: 1, baseContentHash: "pmv1-base", clientMutationId: "m", doc: VALID_PM_DOC } } },
  { name: "updateDoc/non-integer-snapshot", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1.5, baseContentHash: "pmv1-base", clientMutationId: "m", doc: VALID_PM_DOC } } },
  { name: "updateDoc/missing-clientMutationId", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1, baseContentHash: "pmv1-base", doc: VALID_PM_DOC } } },
  { name: "updateDoc/missing-doc", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1, baseContentHash: "pmv1-base", clientMutationId: "m" } } },
  { name: "updateMaterialSummary/summary-not-string", body: { kind: "updateMaterialSummary", data: { sessionId: "s", materialId: "m", summary: 1 } } },
  { name: "removeMaterial/missing-materialId", body: { kind: "removeMaterial", data: { sessionId: "s" } } },
  { name: "attachFolder/unknown-provider", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "ftp" } } } },
  { name: "attachFolder/missing-selectionToken", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "desktop-local" } } } },
  { name: "attachFolder/overlong-selectionToken", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "desktop-local", selectionToken: "x".repeat(257) } } } },
  { name: "attachFolder/overlong-handle", body: { kind: "attachFolder", data: { sessionId: "s", requestId: "attach-invalid", source: { provider: "browser-fs-access", clientSourceId: "c", name: "n", browserHandleKey: "h".repeat(1025) } } } },
  { name: "detachFolder/missing-folderId", body: { kind: "detachFolder", data: { sessionId: "s" } } },
  { name: "detachFolder/overlong-folderId", body: { kind: "detachFolder", data: { sessionId: "s", folderId: "x".repeat(257) } } },
];

// ——— 分区三:契约严格约束的边界输入 ———
const contractReject: CommandFixture[] = [
  { name: "startSession/new-without-template", body: { kind: "startSession", data: { mode: { kind: "new", data: { sessionId: "sess-x" } } } } },
  { name: "sendMessage/skill-missing-fields", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [{}], chips: [], fileIds: [] } } },
  { name: "sendMessage/chip-malformed", body: { kind: "sendMessage", data: { sessionId: "s", text: "x", skills: [], chips: [{ label: "L" }], fileIds: [] } } },
  { name: "acceptPatch/garbage-reviewBatchId", body: { kind: "acceptPatch", data: { id: "p1", reviewBatchId: 42 } } },
  { name: "commitPatches/reviewBatchIds-only", body: { kind: "commitPatches", data: { reviewBatchIds: ["b1"] } } },
  { name: "resumeAskUser/garbage-answer-value", body: { kind: "resumeAskUser", data: { sessionId: "s", toolCallId: "t", answers: { q1: "garbage" } } } },
  { name: "updateDoc/missing-baseContentHash", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1, clientMutationId: "m", doc: VALID_PM_DOC } } },
  { name: "updateDoc/empty-baseContentHash", body: { kind: "updateDoc", data: { sessionId: "s", expectedDocumentSnapshot: 1, baseContentHash: "", clientMutationId: "m", doc: VALID_PM_DOC } } },
];

describe("命令校验契约回归矩阵", () => {
  it.each(sharedAccept)("接受:$name", ({ body }) => {
    expect(validateCommandKind(body)).toBeNull();
  });

  it.each(sharedReject)("拒绝:$name", ({ body }) => {
    const newError = validateCommandKind(body);
    expect(newError).not.toBeNull();
    expect(typeof newError).toBe("string");
    expect((newError as string).length).toBeGreaterThan(0);
  });

  it.each(contractReject)("严格拒绝:$name", ({ body }) => {
    expect(validateCommandKind(body)).not.toBeNull();
  });
});

describe("D6 未知字段消毒(strip)", () => {
  it("sendMessage parse 后保留 tableSelection，避免旧 schema 静默剥离", () => {
    const parsed = commandSchema.parse({
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
          tableSelection: {
            axis: "row",
            startIndex: 0,
            endIndex: 1,
            signature: "fnv1a-deadbeef",
          },
        }],
        fileIds: [],
      },
    });
    expect(parsed.kind).toBe("sendMessage");
    if (parsed.kind === "sendMessage") {
      expect(parsed.data.chips[0]?.tableSelection).toEqual({
        axis: "row",
        startIndex: 0,
        endIndex: 1,
        signature: "fnv1a-deadbeef",
      });
    }
  });

  it("合法 command 携带未知字段仍受理,且未知字段被 strip 不下传", () => {
    const body = {
      kind: "sendMessage",
      evilTop: "x",
      data: { sessionId: "s", text: "hi", skills: [], chips: [], fileIds: [], evilNested: "y" },
    };
    expect(validateCommandKind(body)).toBeNull();
    const parsed = commandSchema.parse(body);
    expect(parsed).not.toHaveProperty("evilTop");
    expect(parsed.data).not.toHaveProperty("evilNested");
  });

  it("经 JSON 传入的 __proto__ 脏键被 strip,不污染原型", () => {
    // JSON.parse 会把 "__proto__" 变成真正的 own 属性(与对象字面量的原型赋值不同),
    // 这才是攻击者从 wire 发来的形态。strip 后不得残留、不得污染原型链。
    const wire = JSON.parse(
      '{"kind":"sendMessage","data":{"sessionId":"s","text":"hi","skills":[],"chips":[],"fileIds":[],"__proto__":{"polluted":true}}}',
    );
    const parsed = commandSchema.parse(wire) as Record<string, unknown> & { data: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(parsed.data, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

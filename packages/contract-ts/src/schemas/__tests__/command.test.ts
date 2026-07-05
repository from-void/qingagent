import { describe, expect, it } from "vitest";
import { commandSchema, COMMAND_KINDS, COMMAND_KIND_SET } from "../command";

/**
 * 契约包内的 schema 级脏路径测试(与 server 侧等价回归互补)。这里只验 `commandSchema`
 * 本身的接受/拒绝与消毒行为,不依赖 server。
 */
describe("commandSchema", () => {
  it("COMMAND_KINDS 覆盖 15 种且与 Set 一致", () => {
    expect(COMMAND_KINDS).toHaveLength(15);
    expect(COMMAND_KIND_SET.size).toBe(15);
    for (const kind of COMMAND_KINDS) expect(COMMAND_KIND_SET.has(kind)).toBe(true);
  });

  it("接受合法 sendMessage", () => {
    const r = commandSchema.safeParse({
      kind: "sendMessage",
      data: { sessionId: "s", text: "hi", mentions: [], skills: [], chips: [], fileIds: [] },
    });
    expect(r.success).toBe(true);
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
    ["resumeAskUser 空 answers", { kind: "resumeAskUser", data: { sessionId: "s", answers: {} } }],
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

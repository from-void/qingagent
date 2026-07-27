import { describe, expect, it } from "vitest";
import { validateCommandKind } from "../routes/stream";

describe("material command stream route validation", () => {
  // 校验已 zod 化(D6):错误文案不再逐字兼容,断言放宽为"通过=null / 拒绝含字段路径"。
  it("accepts updateMaterialSummary and validates payload shape", () => {
    expect(
      validateCommandKind({
        kind: "updateMaterialSummary",
        data: { sessionId: "session-1", materialId: "mat-1", summary: "" },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({
        kind: "updateMaterialSummary",
        data: { materialId: "mat-1", summary: "摘要" },
      }),
    ).toContain("updateMaterialSummary.data.sessionId");
    expect(
      validateCommandKind({
        kind: "updateMaterialSummary",
        data: { sessionId: "session-1", summary: "摘要" },
      }),
    ).toContain("updateMaterialSummary.data.materialId");
    expect(
      validateCommandKind({
        kind: "updateMaterialSummary",
        data: { sessionId: "session-1", materialId: "mat-1", summary: 1 },
      }),
    ).toContain("updateMaterialSummary.data.summary");
  });

  it("accepts removeMaterial and validates payload shape", () => {
    expect(
      validateCommandKind({
        kind: "removeMaterial",
        data: { sessionId: "session-1", materialId: "mat-1" },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({ kind: "removeMaterial", data: { materialId: "mat-1" } }),
    ).toContain("removeMaterial.data.sessionId");
    expect(
      validateCommandKind({ kind: "removeMaterial", data: { sessionId: "session-1" } }),
    ).toContain("removeMaterial.data.materialId");
  });

  it("accepts reparseMaterial and validates payload shape", () => {
    const actual = {
      valid: validateCommandKind({
        kind: "reparseMaterial",
        data: { sessionId: "session-1", fileId: "file-1" },
      }),
      missingSession: validateCommandKind({
        kind: "reparseMaterial",
        data: { fileId: "file-1" },
      }),
      missingFileId: validateCommandKind({
        kind: "reparseMaterial",
        data: { sessionId: "session-1" },
      }),
      emptySession: validateCommandKind({
        kind: "reparseMaterial",
        data: { sessionId: "", fileId: "file-1" },
      }),
      emptyFileId: validateCommandKind({
        kind: "reparseMaterial",
        data: { sessionId: "session-1", fileId: "" },
      }),
    };

    expect(actual.valid).toBeNull();
    expect(actual.missingSession).toContain("reparseMaterial.data.sessionId");
    expect(actual.missingFileId).toContain("reparseMaterial.data.fileId");
    expect(actual.emptySession).toContain("reparseMaterial.data.sessionId");
    expect(actual.emptyFileId).toContain("reparseMaterial.data.fileId");
  });

  it("accepts attachFolder/detachFolder and validates payload shape", () => {
    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: {
          sessionId: "session-1",
          requestId: "attach-desktop",
          source: { provider: "desktop-local", selectionToken: "tok" },
        },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: {
          sessionId: "session-1",
          requestId: "attach-browser",
          source: { provider: "browser-fs-access", clientSourceId: "c1", name: "docs", browserHandleKey: "h1" },
        },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: { sessionId: "session-1", requestId: "attach-invalid", source: { provider: "desktop-local" } },
      }),
    ).toContain("attachFolder.data.source.selectionToken");
    expect(
      validateCommandKind({
        kind: "detachFolder",
        data: { sessionId: "session-1", folderId: "fld_1" },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({
        kind: "detachFolder",
        data: { sessionId: "session-1" },
      }),
    ).toContain("detachFolder.data.folderId");
  });

  it("rejects overlong folder command fields before business handling", () => {
    const longId = "x".repeat(257);
    const longHandle = "h".repeat(1025);

    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: {
          sessionId: "session-1",
          requestId: "attach-long-token",
          source: { provider: "desktop-local", selectionToken: longId },
        },
      }),
    ).toContain("attachFolder.data.source.selectionToken");
    expect(
      validateCommandKind({
        kind: "detachFolder",
        data: { sessionId: "session-1", folderId: longId },
      }),
    ).toContain("detachFolder.data.folderId");
    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: {
          sessionId: "session-1",
          requestId: "attach-long-name",
          source: {
            provider: "browser-fs-access",
            clientSourceId: "client-1",
            name: "n".repeat(257),
            browserHandleKey: "handle",
          },
        },
      }),
    ).toContain("attachFolder.data.source.name");
    expect(
      validateCommandKind({
        kind: "attachFolder",
        data: {
          sessionId: "session-1",
          requestId: "attach-long-handle",
          source: {
            provider: "browser-fs-access",
            clientSourceId: "client-1",
            name: "docs",
            browserHandleKey: longHandle,
          },
        },
      }),
    ).toContain("attachFolder.data.source.browserHandleKey");
  });
});

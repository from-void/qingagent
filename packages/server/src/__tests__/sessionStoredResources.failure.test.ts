import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeSessionDeletion: vi.fn(),
  getSessionDeletion: vi.fn(async () => ({
    sessionId: "asset-delete-failure",
    phase: "database_deleted" as const,
  })),
  listActiveSessionResourceOwners: vi.fn(async () => [] as string[]),
  listSessionResources: vi.fn(async () => [{
    sessionId: "asset-delete-failure",
    resourceId: "11111111-1111-4111-8111-111111111111",
    kind: "generated" as const,
    refCount: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }]),
  markSessionAssetsDeleted: vi.fn(),
  purgeStoredFile: vi.fn(async () => false),
}));

vi.mock("@qingagent/db", () => ({
  completeSessionDeletion: mocks.completeSessionDeletion,
  getSessionDeletion: mocks.getSessionDeletion,
  listActiveSessionResourceOwners: mocks.listActiveSessionResourceOwners,
  listSessionResources: mocks.listSessionResources,
  markSessionAssetsDeleted: mocks.markSessionAssetsDeleted,
  removeSessionResource: vi.fn(),
}));

vi.mock("../lib/uploadStorage", () => ({
  purgeStoredFile: mocks.purgeStoredFile,
}));

import { deleteSessionStoredResources } from "../gateway/sessionStoredResources";

describe("会话文件资源删除失败语义", () => {
  it("敏感原件物理删除失败时阻断完成，保留 database_deleted 阶段供重试", async () => {
    await expect(deleteSessionStoredResources("asset-delete-failure"))
      .rejects.toThrow("Failed to delete session resource");
    expect(mocks.markSessionAssetsDeleted).not.toHaveBeenCalled();
    expect(mocks.completeSessionDeletion).not.toHaveBeenCalled();
  });
});

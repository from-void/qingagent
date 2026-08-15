import { afterEach, describe, expect, it } from "vitest";
import type { AttachCapabilities, AttachIdentity } from "@qingagent/contract-ts";
import {
  ATTACH_SESSION_ABSOLUTE_TTL_MS,
  ATTACH_SESSION_CAPACITY,
  ATTACH_SESSION_IDLE_TTL_MS,
  __attachSessionCountForTest,
  createAttachSession,
  resolveAttachSession,
  revokeAllAttachSessions,
  revokeAttachSession,
} from "../lib/attachSessions";

const identity: AttachIdentity = {
  schemaVersion: 2,
  port: 32123,
  pid: 123,
  version: "test",
  attachProtocolVersion: 1,
  instanceId: "instance-1",
  libraryId: "00000000-0000-4000-8000-000000000001",
  startedAt: "2026-08-16T00:00:00.000Z",
};

const allDesktopCapabilities = Object.fromEntries([
  "folderSelection", "confirmGrant", "diagnosticsExport", "documentExport",
  "credentialProvider", "modelKeys", "skillMutation", "connectors", "updates",
  "templateMutation", "derivativeMutation", "lexiconMutation", "deepLink",
  "docEditing", "review", "assets",
].map((name) => [name, true])) as AttachCapabilities;

afterEach(() => revokeAllAttachSessions());

describe("attach session token", () => {
  it("生成 256bit token，交集只启用四项 must-enable capability", () => {
    const created = createAttachSession({ identity, desktopCapabilities: allDesktopCapabilities, nowMs: 1_000 });
    expect(created.token).toMatch(/^qa_attach_[0-9a-f]{64}$/);
    expect(created.session.effectiveCapabilities).toEqual({
      folderSelection: false, confirmGrant: false, diagnosticsExport: false,
      documentExport: false, credentialProvider: false, modelKeys: false,
      skillMutation: false, connectors: false, updates: false,
      templateMutation: false, derivativeMutation: false, lexiconMutation: false,
      deepLink: true, docEditing: true, review: true, assets: true,
    });
  });

  it("绝对 12h、空闲 2h、吊销都 fail closed", () => {
    const idle = createAttachSession({ identity, desktopCapabilities: allDesktopCapabilities, nowMs: 1_000 });
    expect(resolveAttachSession(idle.token, 1_000 + ATTACH_SESSION_IDLE_TTL_MS - 1)).not.toBeNull();
    expect(resolveAttachSession(idle.token, 1_000 + ATTACH_SESSION_IDLE_TTL_MS * 2 - 2)).not.toBeNull();
    expect(resolveAttachSession(idle.token, 1_000 + ATTACH_SESSION_ABSOLUTE_TTL_MS)).toBeNull();

    const revoked = createAttachSession({ identity, desktopCapabilities: allDesktopCapabilities, nowMs: 2_000 });
    expect(revokeAttachSession(revoked.token)).toBe(true);
    expect(resolveAttachSession(revoked.token, 2_001)).toBeNull();
  });

  it("容量满时回收最久未使用 session", () => {
    let oldest = "";
    for (let index = 0; index <= ATTACH_SESSION_CAPACITY; index += 1) {
      const created = createAttachSession({ identity, desktopCapabilities: allDesktopCapabilities, nowMs: index });
      if (index === 0) oldest = created.token;
    }
    expect(__attachSessionCountForTest()).toBe(ATTACH_SESSION_CAPACITY);
    expect(resolveAttachSession(oldest, ATTACH_SESSION_CAPACITY + 1)).toBeNull();
  });
});

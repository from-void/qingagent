import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConfirmAuditEvents } from "../confirmGrantRepo.js";
import {
  createCredentialGrant,
  listCredentialGrants,
  listGrantedCredentialPaths,
  revokeCredentialGrant,
} from "../credentialGrantRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-credential-grants-"); });
afterEach(() => db.cleanup());

describe("凭证共享授权仓储", () => {
  it("授权落库、幂等、可列出路径", async () => {
    const created = await createCredentialGrant({
      path: "/home/tester/.lark-cli",
      skillName: "feishu",
      declared: "~/.lark-cli",
      source: "card",
      grantId: "grant-lark",
      now: "2026-07-29T01:00:00.000Z",
    });
    expect(created.created).toBe(true);
    expect(created.grant).toEqual({
      path: "/home/tester/.lark-cli",
      grantId: "grant-lark",
      skillName: "feishu",
      declared: "~/.lark-cli",
      createdAt: "2026-07-29T01:00:00.000Z",
      source: "card",
    });

    const duplicate = await createCredentialGrant({
      path: "/home/tester/.lark-cli",
      skillName: "feishu",
      declared: "~/.lark-cli",
      source: "settings",
      grantId: "must-not-replace",
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.grant.grantId).toBe("grant-lark");

    expect(await listGrantedCredentialPaths()).toEqual(["/home/tester/.lark-cli"]);
  });

  it("多条授权按路径排序列出", async () => {
    await createCredentialGrant({
      path: "/home/tester/.yuque",
      skillName: "yuque",
      declared: "~/.yuque",
      source: "card",
    });
    await createCredentialGrant({
      path: "/home/tester/.lark-cli",
      skillName: "feishu",
      declared: "~/.lark-cli",
      source: "preset",
    });
    expect((await listCredentialGrants()).map((grant) => grant.path)).toEqual([
      "/home/tester/.lark-cli",
      "/home/tester/.yuque",
    ]);
  });

  it("回收后不再出现,重复回收返回 null", async () => {
    await createCredentialGrant({
      path: "/home/tester/.yuque",
      skillName: "yuque",
      declared: "~/.yuque",
      source: "card",
    });
    const revoked = await revokeCredentialGrant("/home/tester/.yuque");
    expect(revoked?.path).toBe("/home/tester/.yuque");
    expect(await listGrantedCredentialPaths()).toEqual([]);
    expect(await revokeCredentialGrant("/home/tester/.yuque")).toBeNull();
  });

  it("授权与回收都在审计账本留痕,subject 是规范化路径", async () => {
    await createCredentialGrant({
      path: "/home/tester/.yuque",
      skillName: "yuque",
      declared: "~/.yuque",
      source: "card",
      grantId: "grant-yuque",
      now: "2026-07-29T02:00:00.000Z",
    });
    await revokeCredentialGrant("/home/tester/.yuque", "2026-07-29T03:00:00.000Z");
    const events = (await listConfirmAuditEvents("settings")).filter(
      (event) => event.subjectId === "/home/tester/.yuque",
    );
    expect(events.map((event) => [event.eventType, event.kind, event.grantId, event.result])).toEqual([
      ["grant_created", "connect", "grant-yuque", "grant-created"],
      ["grant_revoked", "connect", "grant-yuque", "grant-revoked"],
    ]);
  });
});

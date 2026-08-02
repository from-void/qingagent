import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocumentsClient,
  getReviewDocSupplement,
  runMigrations,
  upsertReviewDocSupplement,
} from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const mocks = vi.hoisted(() => ({
  branchCall: vi.fn(),
  getSessionSnapshot: vi.fn(),
}));

vi.mock("../llm/modelConfig.js", () => ({
  branchCall: mocks.branchCall,
  getSessionSnapshot: mocks.getSessionSnapshot,
}));

import { rewriteReviewSupplementsForIgnoredGroups } from "../session/reviewSupplement.js";

let db: TempDocumentsDb;

const group = {
  id: "group-1",
  summary: "行动建议空泛",
  note: "缺少负责人和期限。",
  origin: "自定义审查:老板视角挑刺",
  status: "reviewing" as const,
  anchors: [{
    blockId: "p-1",
    pmFrom: 1,
    pmTo: 9,
    quote: "尽快推动项目落地",
    textHash: "hash-1",
  }],
};

beforeEach(async () => {
  vi.clearAllMocks();
  db = prepareTempDocumentsDb("qa-review-supplement-");
  await runMigrations();
  await getDocumentsClient().execute(`INSERT INTO documents(
    id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
  ) VALUES('doc-review-supplement','thread-review-supplement','qingagent-user','补充要求','editing','now','now','main')`);
  mocks.getSessionSnapshot.mockReturnValue({ sessionId: "thread-review-supplement" });
});

afterEach(() => db.cleanup());

describe("忽略批注回填审查补充提示词", () => {
  it("借道旁支让模型合并完整补充提示词并写回对应 custom 类型", async () => {
    const userText = "重点核对金额。\n英文 Product-X 必须逐字保留。";
    const expected = [
      userText,
      "",
      "## 已确认忽略",
      "- 已确认无需处理，不再标记：「尽快推动项目落地」(2026-08-03)",
    ].join("\n");
    await upsertReviewDocSupplement("doc-review-supplement", "custom", userText);
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: expected,
      attempts: 1,
      toolCallRetries: 0,
      finishReason: "stop",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [group],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(await getReviewDocSupplement("doc-review-supplement", "custom")).toBe(expected);
    expect(mocks.branchCall).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "rewriteReviewSupplement",
      steeringTail: expect.stringContaining("自定义审查:老板视角挑刺"),
    }));
  });

  it("模型改动用户手写内容时守卫拒绝，机械追加仍保存本次决定", async () => {
    const userText = "用户手写：保留 Product-X，金额不要四舍五入。";
    await upsertReviewDocSupplement("doc-review-supplement", "custom", userText);
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: [
        "用户手写：保留产品名，金额可取整。",
        "",
        "## 已确认忽略",
        "- 已确认无需处理，不再标记：「尽快推动项目落地」(2026-08-03)",
      ].join("\n"),
      attempts: 1,
      toolCallRetries: 0,
      finishReason: "stop",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [group],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(await getReviewDocSupplement("doc-review-supplement", "custom")).toBe([
      userText,
      "",
      "## 已确认忽略",
      "- 已确认无需处理，不再标记：「尽快推动项目落地」(2026-08-03)",
    ].join("\n"));
  });

  it("会话快照不可用时不发模型请求，直接机械追加", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [{ ...group, origin: "source-check" }],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(mocks.branchCall).not.toHaveBeenCalled();
    expect(await getReviewDocSupplement("doc-review-supplement", "source")).toBe(
      "## 已确认忽略\n- 已确认无需处理，不再标记：「尽快推动项目落地」(2026-08-03)",
    );
  });
});

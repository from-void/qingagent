import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { getDocumentsClient } from "@qingagent/core";
import {
  assertUniquePmBlockIds,
  getPmContentHash,
  pmToMarkdown,
  pmToPlainText,
  qingmlParse,
  type PmDoc,
  type PmTaskItemNode,
  type PmTaskListNode,
} from "@qingagent/pm-schema";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";
import insertAfterBlockW1 from "./fixtures/insert-after-block-w1.json";
import strReplaceAdjacentR8 from "./fixtures/strreplace-adjacent-r8.json";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-propose-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", libraryId: "00000000-0000-4000-8000-000000000001", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external proposals", () => {
  it("qingmlDraft 首稿直落，后续 H1 候选在拒绝前不改标题且拒绝时发纠正帧", async () => {
    const sessionId = await createSession();
    const firstQingml = [
      "<title>正文一级标题</title>",
      "<h1>正文一级标题</h1>",
      "<p>第一段。</p>",
      "<ul><li>父项<ul><li>子项</li></ul></li></ul>",
      "<table><tr><th><p>列名</p></th><th><p>值</p></th></tr><tr><td><p>甲</p></td><td><callout emoji=\"💡\" tone=\"info\">提示</callout></td></tr></table>",
      "<callout emoji=\"✅\" tone=\"success\">独立提示</callout>",
      "<tasks><task checked=\"true\">已完成</task><task>待处理</task></tasks>",
      "<pre lang=\"cpp\">#include &lt;stdio.h&gt;\nint main() { return 0; }</pre>",
    ].join("");

    const committed = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: firstQingml }],
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json() as { status: string; docVersion: number; seq: number };
    expect(committedBody).toMatchObject({ status: "committed", docVersion: 1 });

    const read = await app.request(`/api/v1/external/sessions/${sessionId}/doc?format=qingml`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json() as { title: string | null; qingml: string; markdown: string };
    expect(readBody.title).toBe("正文一级标题");
    expect(readBody.markdown).toContain("正文一级标题");
    const parsedRoundTrip = qingmlParse(readBody.qingml);
    expect(parsedRoundTrip.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsedRoundTrip.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "table",
      "callout",
      "taskList",
      "codeBlock",
    ]);
    expect(readBody.qingml).toContain("<ul><li>父项<ul><li>子项</li></ul></li></ul>");

    const review = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{
        kind: "qingmlDraft",
        qingml: firstQingml
          .replaceAll("正文一级标题", "审阅态新标题")
          .replace("第一段。", "第一段已修改。"),
      }],
    });
    expect(review.status).toBe(200);
    const reviewBody = await review.json() as {
      status: string;
      count: number;
      patchIds: string[];
      seq: number;
    };
    expect(reviewBody.status).toBe("review");
    expect(reviewBody.count).toBeGreaterThan(0);
    expect(reviewBody.patchIds).toHaveLength(reviewBody.count);
    const reviewFrames = sessionManager.frameLog.readFrom(sessionId, committedBody.seq).frames;
    expect(reviewFrames).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ frame: { kind: "sessionMeta", data: { title: "审阅态新标题" } } }),
    ]));

    const readAfterReview = await app.request(`/api/v1/external/sessions/${sessionId}/doc`, {
      headers: authHeaders(),
    });
    expect(await readAfterReview.json()).toMatchObject({
      title: "正文一级标题",
      markdown: expect.stringContaining("# 正文一级标题"),
    });

    const reviewRead = await app.request(`/api/v1/external/sessions/${sessionId}/review`, {
      headers: authHeaders(),
    });
    expect(reviewRead.status).toBe(200);
    const reviewReadBody = await reviewRead.json() as { patches: unknown[] };
    expect(reviewReadBody.patches.length).toBeGreaterThan(0);

    // 兼容修复前已经把候选标题写进会话元数据的存量 pendingReview。
    const contaminated = await getOrRestoreSession(sessionId);
    contaminated!.title = "审阅态新标题";

    const rejected = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      status: "reviewed",
      docVersion: 1,
      acceptedCount: 0,
      rejectedCount: reviewBody.count,
      remainingCount: 0,
    });
    const rejectFrames = sessionManager.frameLog.readFrom(sessionId, reviewBody.seq).frames;
    expect(rejectFrames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        frame: { kind: "sessionMeta", data: { sessionId, title: "正文一级标题" } },
      }),
    ]));
    const settled = await getOrRestoreSession(sessionId);
    expect(settled).toMatchObject({
      title: "正文一级标题",
      titlePinned: false,
      docVersion: 1,
      docState: { kind: "editing" },
    });
    expect(pmToMarkdown(settled!.doc!)).toContain("# 正文一级标题");
    await sessionManager.disposeSession(sessionId);
    expect(await getOrRestoreSession(sessionId)).toMatchObject({
      title: "正文一级标题",
      titlePinned: false,
      docVersion: 1,
    });
  });

  it("接受 H1 候选后才同步标题并发 sessionMeta", async () => {
    const sessionId = await createSession();
    const original = "<title>旧标题</title><h1>旧标题</h1><p>正文。</p>";
    const committed = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: original }],
    });
    const committedBody = await committed.json() as { seq: number };
    const review = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{
        kind: "qingmlDraft",
        qingml: "<title>新标题</title><h1>新标题</h1><p>正文已修改。</p>",
      }],
    });
    const reviewBody = await review.json() as { count: number; seq: number };
    expect((await getOrRestoreSession(sessionId))?.title).toBe("旧标题");
    expect(sessionManager.frameLog.readFrom(sessionId, committedBody.seq).frames).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ frame: { kind: "sessionMeta", data: { title: "新标题" } } }),
      ]),
    );

    const accepted = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "reviewed",
      docVersion: 2,
      acceptedCount: reviewBody.count,
      rejectedCount: 0,
    });
    expect((await getOrRestoreSession(sessionId))?.title).toBe("新标题");
    expect(sessionManager.frameLog.readFrom(sessionId, reviewBody.seq).frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          frame: { kind: "sessionMeta", data: { sessionId, title: "新标题" } },
        }),
      ]),
    );
  });

  it("titlePinned 时接受 H1 候选也不覆盖手动标题", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: "<title>旧标题</title><h1>旧标题</h1><p>正文。</p>" }],
    });
    await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "setTitle", title: "手动标题" }],
    });
    const review = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{
        kind: "qingmlDraft",
        qingml: "<title>候选标题</title><h1>候选标题</h1><p>正文已修改。</p>",
      }],
    });
    const reviewBody = await review.json() as { seq: number };
    const accepted = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });

    expect(accepted.status).toBe(200);
    expect(await getOrRestoreSession(sessionId)).toMatchObject({
      title: "手动标题",
      titlePinned: true,
      docVersion: 2,
    });
    expect(sessionManager.frameLog.readFrom(sessionId, reviewBody.seq).frames).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ frame: { kind: "sessionMeta", data: { title: "候选标题" } } }),
      ]),
    );
  });

  it("拒绝产生有害降级的 qingmlDraft，并返回脱敏诊断", async () => {
    const sessionId = await createSession();
    const rejected = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: "<pre>secret<p>block</p></pre>" }],
    });

    expect(rejected.status).toBe(400);
    const body = await rejected.json() as {
      code: string;
      diagnostic?: { failureKind: string; warningKinds: string[]; tagSkeleton: string };
    };
    expect(body).toMatchObject({
      code: "VALIDATION",
      diagnostic: {
        failureKind: "qingml_bad_block",
        warningKinds: expect.arrayContaining(["raw-text-child-tag"]),
        tagSkeleton: "<pre><p></p></pre>",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret");

    const empty = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: "  \n" }],
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      code: "VALIDATION",
      diagnostic: {
        failureKind: "qingml_empty",
        warningKinds: [],
        tagSkeleton: "",
        errorLocations: [],
      },
    });
  });

  it("覆盖 P1 状态矩阵主路径和 409 家族", async () => {
    const sessionId = await createSession();

    const emptyReplace = await propose(sessionId, { expectedDocVersion: 0, ops: [{ kind: "strReplace", old: "旧", new: "新" }] });
    expect(emptyReplace.status).toBe(400);
    expect(await emptyReplace.json()).toMatchObject({ code: "VALIDATION" });

    const fullDraft = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "# 标题\n\n第一段旧文。" }],
    });
    expect(fullDraft.status).toBe(200);
    const fullDraftBody = await fullDraft.json() as { status: string; docVersion: number; seq: number };
    expect(fullDraftBody).toMatchObject({ status: "committed", docVersion: 1 });
    expect(fullDraftBody.seq).toBeGreaterThan(0);
    const committedSession = await getOrRestoreSession(sessionId);
    const op = await getDocumentsClient().execute({
      sql: "SELECT created_at FROM document_ops WHERE doc_id = ? AND to_version = ?",
      args: [sessionId, 1],
    });
    expect(committedSession?.lastContentEditedAt).toBe(String(op.rows[0]?.created_at));

    const conflict = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "VERSION_CONFLICT", expected: 0, actual: 1, seq: expect.any(Number) });

    const fullDraftAgain = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "fullDraft", markdown: "# 覆写" }],
    });
    expect(fullDraftAgain.status).toBe(400);
    expect(await fullDraftAgain.json()).toMatchObject({ code: "VALIDATION" });

    const tooMany = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: Array.from({ length: 51 }, () => ({ kind: "appendSection", markdown: "x" })),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "VALIDATION" });

    const review = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    });
    expect(review.status).toBe(200);
    const reviewBody = await review.json() as { status: string; count: number; patchIds: string[]; seq: number };
    expect(reviewBody.status).toBe("review");
    expect(reviewBody.count).toBeGreaterThan(0);
    expect(reviewBody.patchIds.length).toBe(reviewBody.count);
    expect(reviewBody.seq).toBeGreaterThan(fullDraftBody.seq);

    const afterProposal = sessionManager.frameLog.readFrom(sessionId, reviewBody.seq).frames;
    expect(afterProposal.some((entry) => entry.frame.kind === "docCommitted")).toBe(false);

    const pending = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "第二段。" }],
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "REVIEW_PENDING", seq: expect.any(Number) });
  });

  it("结算残留候选不得让后续 strReplace 带入已提交正文之外的删除", async () => {
    const sessionId = await createSession();
    const prefix = "每次高温过程结束后，须召开复盘会形成书面记录，逐条核对改进清单的落实情况，";
    const oldText = "未落实事项明确责任与期限，纳入下一轮跟踪。";
    const newText = "未落实事项须明确责任人与完成期限，并纳入下一轮闭环跟踪。";
    const committed = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: `${prefix}${oldText}` }],
    });
    expect(committed.status).toBe(200);

    const session = (await getOrRestoreSession(sessionId))!;
    const staleCandidate = structuredClone(session.doc!);
    const paragraph = staleCandidate.content[0];
    if (paragraph?.type !== "paragraph" || paragraph.content?.[0]?.type !== "text") {
      throw new Error("测试文档未生成预期段落");
    }
    paragraph.content[0].text = oldText;
    session.docDraftBaseDoc = structuredClone(session.doc!);
    session.docDraftBaseVersion = session.docVersion;
    session.docDraftCandidateDoc = staleCandidate;
    session.suggestions.clear();
    session.patchVerdicts.clear();

    const replaced = await propose(sessionId, {
      expectedDocVersion: session.docVersion,
      ops: [{ kind: "strReplace", old: oldText, new: newText }],
    });

    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ status: "review", count: 4 });
    expect(pmToPlainText(session.docDraftCandidateDoc!)).toBe(`${prefix}${newText}`);
    expect([...session.suggestions.values()]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        diffHunk: expect.objectContaining({ op: "delete", beforeText: prefix }),
      }),
    ]));
  });

  it("0822-r8：段落交换并连续提交后 strReplace 不得吞掉相邻正文", async () => {
    type ReplayOp =
      | { kind: "strReplace"; old: string; new: string }
      | { kind: "deleteBlock"; locator: string }
      | { kind: "insertAfterBlock"; locator: string; markdown: string };
    const replay = strReplaceAdjacentR8 as Array<{
      name: string;
      args: { qingml?: string; ops?: ReplayOp[] };
    }>;
    expect(replay).toHaveLength(12);
    const sessionId = await createSession();
    const initial = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: replay[0]!.args.qingml! }],
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ status: "committed", docVersion: 1 });

    const resolveOps = async (ops: ReplayOp[]) => {
      const read = await app.request(
        `/api/v1/external/sessions/${sessionId}/doc?format=pm`,
        { headers: authHeaders() },
      );
      expect(read.status).toBe(200);
      const { pmDoc } = await read.json() as { pmDoc: PmDoc };
      const blockIdAt = (locator: string): string => {
        const line = Number(/^L(\d+)$/.exec(locator)?.[1]);
        const blockId = pmDoc.content[line - 1]?.attrs.blockId;
        if (!blockId) throw new Error(`现场 locator ${locator} 未命中当前块`);
        return blockId;
      };
      return ops.map((op) => {
        if (op.kind === "strReplace") return op;
        if (op.kind === "deleteBlock") {
          return { kind: op.kind, blockId: blockIdAt(op.locator) };
        }
        return {
          kind: op.kind,
          blockId: blockIdAt(op.locator),
          markdown: op.markdown,
        };
      });
    };

    // 现场前两次跨块逐字替换未命中；保留原始失败调用，确认它们不改变版本。
    for (const call of replay.slice(1, 3)) {
      const failed = await propose(sessionId, {
        expectedDocVersion: 1,
        ops: await resolveOps(call.args.ops!),
      });
      expect(failed.status).toBe(400);
      expect(await failed.json()).toMatchObject({ code: "VALIDATION" });
    }

    // 两次段落交换和前五次小改均严格按「读当前稿 → 提案 → commit → 下一轮」执行。
    for (const [offset, call] of replay.slice(3, 10).entries()) {
      const before = (await getOrRestoreSession(sessionId))!;
      const beforeVersion = before.docVersion;
      const ops = await resolveOps(call.args.ops!);
      const proposal = await propose(sessionId, {
        expectedDocVersion: beforeVersion,
        ...(ops.some((op) => op.kind !== "strReplace")
          ? { opId: `0822-r8-structural-${offset + 1}` }
          : {}),
        ops,
      });
      expect(proposal.status).toBe(200);
      expect(await proposal.json()).toMatchObject({ status: "review" });
      const review = await app.request(
        `/api/v1/external/sessions/${sessionId}/review?format=render-model`,
        { headers: authHeaders() },
      );
      expect(review.status).toBe(200);
      const accepted = await app.request(
        `/api/v1/external/sessions/${sessionId}/review/commit`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            expectedDocVersion: beforeVersion,
            action: "commit",
          }),
        },
      );
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        status: "reviewed",
        docVersion: beforeVersion + 1,
        remainingCount: 0,
      });
    }

    const targetCall = replay[10]!;
    const targetOp = targetCall.args.ops![0]!;
    if (targetOp.kind !== "strReplace") throw new Error("现场第 10 次 edit 不是 strReplace");
    expect(targetOp).toEqual({
      kind: "strReplace",
      old: "这周，还去吗？",
      new: "下周末，还来吗？",
    });
    const beforeTarget = (await getOrRestoreSession(sessionId))!;
    const canonicalText = pmToPlainText(beforeTarget.doc!);
    expect(canonicalText).toContain(
      "可我知道，下个周末，还会有人先问一句：这周，还去吗？",
    );

    // 现场竞态窗口压缩：commit 已把完整 canonical 落进 documents，但热 session 的
    // doc 引用发生同版本撕裂，只留下目标 literal。外部读接口会用 DB 权威快照，因此
    // 此刻仍必须读到完整正文；下一次 proposal 也必须从同一份权威快照起算。
    const tornDoc = structuredClone(beforeTarget.doc!);
    const lastParagraph = tornDoc.content.at(-1);
    if (lastParagraph?.type !== "paragraph") {
      throw new Error("现场末段不是预期 paragraph");
    }
    lastParagraph.content = [{ type: "text", text: targetOp.old }];
    beforeTarget.doc = tornDoc;
    expect(pmToPlainText(beforeTarget.doc)).not.toContain("可我知道，下个");

    const authoritativeRead = await app.request(
      `/api/v1/external/sessions/${sessionId}/doc?format=pm`,
      { headers: authHeaders() },
    );
    expect(authoritativeRead.status).toBe(200);
    const authoritativeBody = await authoritativeRead.json() as { pmDoc: PmDoc };
    expect(pmToPlainText(authoritativeBody.pmDoc)).toBe(canonicalText);
    expect(getPmContentHash(beforeTarget.doc)).not.toBe(
      getPmContentHash(authoritativeBody.pmDoc),
    );

    const targetProposal = await propose(sessionId, {
      expectedDocVersion: beforeTarget.docVersion,
      ops: await resolveOps(targetCall.args.ops!),
    });
    expect(targetProposal.status).toBe(200);
    expect(await targetProposal.json()).toMatchObject({ status: "review" });

    const pending = (await getOrRestoreSession(sessionId))!;
    expect(pmToPlainText(pending.docDraftCandidateDoc!)).toBe(
      canonicalText.replace(targetOp.old, targetOp.new),
    );
    expect(pmToPlainText(pending.doc!)).toBe(canonicalText);
    expect(pmToPlainText(pending.docDraftCandidateDoc!)).toContain(
      "可我知道，下个周末，还会有人先问一句：下周末，还来吗？",
    );

    const render = await app.request(
      `/api/v1/external/sessions/${sessionId}/review?format=render-model`,
      { headers: authHeaders() },
    );
    expect(render.status).toBe(200);
    const renderBody = await render.json() as {
      editedDoc: PmDoc;
      suggestions: Array<{ preview: { deleteText: string; insertText: string } }>;
    };
    expect(pmToPlainText(renderBody.editedDoc)).toBe(
      canonicalText.replace(targetOp.old, targetOp.new),
    );
    expect(renderBody.suggestions.map((suggestion) => suggestion.preview)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deleteText: "可我知道，下个" }),
        expect.objectContaining({ deleteText: "会有人先问一句：这周，还去" }),
      ]),
    );
  });

  it("streamId 非空时返回 AGENT_BUSY", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.streamId = "busy-stream";
    const busy = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "第二段。" }],
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "AGENT_BUSY" });
  });

  it("0 hunk validation 失败不残留空 agent 气泡", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });

    const noop = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "strReplace", old: "第一段。", new: "第一段。" }],
    });

    expect(noop.status).toBe(400);
    expect(await noop.json()).toMatchObject({ code: "VALIDATION" });
    const session = await getOrRestoreSession(sessionId);
    expect(session?.chatHistory.filter((message) => message.role.kind === "agent" && message.parts.length === 0)).toHaveLength(0);
  });

  it("markText 走完整 proposal→审阅流并产出 markAdd/markRemove hunk", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "新增标记，**移除标记**。" }],
    });

    const arbitraryColor = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{
        kind: "markText",
        find: "新增标记",
        mark: { type: "highlight", color: "#ff0" },
        op: "add",
      }],
    });
    expect(arbitraryColor.status).toBe(400);
    expect(await arbitraryColor.json()).toMatchObject({ code: "VALIDATION" });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [
        {
          kind: "markText",
          find: "新增标记",
          mark: { type: "highlight", color: "yellow" },
          op: "add",
        },
        {
          kind: "markText",
          find: "移除标记",
          mark: { type: "bold" },
          op: "remove",
        },
      ],
    });

    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ status: "review", count: 2 });
    const session = await getOrRestoreSession(sessionId);
    expect([...session!.suggestions.values()].map((record) => record.diffHunk?.op))
      .toEqual(expect.arrayContaining(["markAdd", "markRemove"]));
    expect(JSON.stringify(session!.docDraftCandidateDoc)).toContain(
      '\"type\":\"highlight\",\"attrs\":{\"color\":\"yellow\"}',
    );
  });

  it("markText 只命中代码块时返回 400 与可自纠文案", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "```ts\nconst 目标 = 1;\n```" }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "markText", find: "目标", mark: { type: "bold" }, op: "add" }],
    });

    expect(proposed.status).toBe(400);
    expect(await proposed.json()).toMatchObject({
      code: "VALIDATION",
      error: "文本未命中或未唯一命中,请缩小 withinRef 或设 all:true；注:代码块内文本不参与行内标记",
    });
  });

  it("markText 含代码块时非 all 多义命中同时返回 all 与代码块自纠说明", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{
        kind: "fullDraft",
        markdown: "```ts\nconst 目标 = 1;\n```\n\n段落目标一\n\n段落目标二",
      }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "markText", find: "目标", mark: { type: "bold" }, op: "add" }],
    });

    expect(proposed.status).toBe(400);
    const body = await proposed.json() as { code: string; error: string };
    expect(body).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("all:true"),
    });
    expect(body.error).toContain("代码块内文本不参与行内标记");
  });

  it("markText 混合命中代码块与段落时正常标记段落", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{
        kind: "fullDraft",
        markdown: "```ts\nconst 目标 = 1;\n```\n\n段落目标",
      }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "markText", find: "目标", mark: { type: "bold" }, op: "add" }],
    });

    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ status: "review" });
    const candidate = (await getOrRestoreSession(sessionId))!.docDraftCandidateDoc!;
    const codeBlock = candidate.content.find((block) => block.type === "codeBlock");
    const paragraph = candidate.content.find((block) => block.type === "paragraph");
    expect(JSON.stringify(codeBlock)).not.toContain('"marks"');
    expect(JSON.stringify(paragraph)).toContain('"type":"bold"');
  });

  it("markText add 已存在的标记时返回可自纠文案", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "**目标**" }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "markText", find: "目标", mark: { type: "bold" }, op: "add" }],
    });

    expect(proposed.status).toBe(400);
    expect(await proposed.json()).toMatchObject({
      code: "VALIDATION",
      error: "标记已存在，无需重复添加；同类型不同属性可直接 add 替换",
    });
  });

  it("markText remove 不存在的标记时返回可自纠文案", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "目标" }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "markText", find: "目标", mark: { type: "bold" }, op: "remove" }],
    });

    expect(proposed.status).toBe(400);
    expect(await proposed.json()).toMatchObject({
      code: "VALIDATION",
      error: "标记不存在，无需重复移除；请检查 mark 后重试",
    });
  });

  it("丢弃仅由块身份重建产生的逐字节相同 hunk，并按空提案拒绝", async () => {
    const sessionId = await createSession();
    const qingml = [
      "<h1>标题</h1>",
      "<ul><li>第一项<ul><li>子项</li></ul></li><li>第二项</li></ul>",
      "<callout emoji=\"💡\" tone=\"info\">提示内容</callout>",
    ].join("");
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml }],
    });

    const noop = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "qingmlDraft", qingml }],
    });

    expect(noop.status).toBe(400);
    expect(await noop.json()).toMatchObject({ code: "VALIDATION" });
    const review = await app.request(`/api/v1/external/sessions/${sessionId}/review`, {
      headers: authHeaders(),
    });
    expect(await review.json()).toMatchObject({ patches: [] });
  });

  it("setTitle 直接更新标题并保持正文、版本与审阅状态不变", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。\n\n第二段。" }],
    });

    const renamed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "setTitle", title: "午夜微光" }],
    });

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ status: "committed", docVersion: 1 });
    const doc = await app.request(`/api/v1/external/sessions/${sessionId}/doc`, {
      headers: authHeaders(),
    });
    expect(await doc.json()).toMatchObject({
      title: "午夜微光",
      docVersion: 1,
      state: "editing",
      markdown: "第一段。\n\n第二段。",
    });
    const session = await getOrRestoreSession(sessionId);
    expect(session).toMatchObject({ title: "午夜微光", titlePinned: true });
    expect(session?.suggestions.size).toBe(0);

    const replayed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "setTitle", title: "午夜微光" }],
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ status: "committed", docVersion: 1 });
  });

  it("空文档允许 title-only，且不创建正文版本或审阅批次", async () => {
    const sessionId = await createSession();

    const renamed = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "setTitle", title: "只有标题" }],
    });

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ status: "committed", docVersion: 0 });
    const session = await getOrRestoreSession(sessionId);
    expect(session).toMatchObject({
      title: "只有标题",
      titlePinned: true,
      docVersion: 0,
      docState: { kind: "empty" },
    });
    expect(session?.suggestions.size).toBe(0);
  });

  it("setTitle 可与局部正文操作同批，标题立即更新且正文仅产生一个待审 hunk", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。\n\n第二段。" }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [
        { kind: "setTitle", title: "午夜微光" },
        { kind: "appendSection", markdown: "第三段。" },
      ],
    });

    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ status: "review", count: 1 });
    const doc = await app.request(`/api/v1/external/sessions/${sessionId}/doc`, {
      headers: authHeaders(),
    });
    expect(await doc.json()).toMatchObject({
      title: "午夜微光",
      docVersion: 1,
      state: "pendingReview",
      markdown: "第一段。\n\n第二段。",
    });
  });

  it("setTitle 与正文 no-op 同批时整批拒绝，标题也不越过 all-or-nothing 落库", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "原正文。" }],
    });

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [
        { kind: "setTitle", title: "独立落库标题" },
        { kind: "strReplace", old: "原正文。", new: "原正文。" },
      ],
    });

    expect(proposed.status).toBe(400);
    expect(await proposed.json()).toMatchObject({ code: "VALIDATION" });
    const session = await getOrRestoreSession(sessionId);
    expect(session).toMatchObject({
      title: "",
      titlePinned: false,
      docVersion: 1,
      docState: { kind: "editing" },
    });
    expect(session?.suggestions.size).toBe(0);
  });

  it("appendSection 重复段落撞 blockId 时收敛为 validation_error", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "重复段落。" }],
    });

    const duplicated = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "重复段落。" }],
    });

    expect(duplicated.status).toBe(400);
    expect(await duplicated.json()).toMatchObject({ code: "VALIDATION" });
    const session = await getOrRestoreSession(sessionId);
    expect(session?.docState).toEqual({ kind: "editing" });
    expect(session?.suggestions.size).toBe(0);
  });

  it("把调用方身份编入外部提案的 agent 消息 id", async () => {
    const claudeSessionId = await createSession();
    await propose(claudeSessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    await propose(claudeSessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "Claude 提案。" }],
    }, { "X-QA-Client": "claudecode" });
    const claudeSession = await getOrRestoreSession(claudeSessionId);
    const claudeMessage = claudeSession?.chatHistory.find((message) => message.role.kind === "agent");
    expect(claudeMessage?.id).toMatch(/^external-claudecode-[0-9a-f-]{36}$/);

    const agentSessionId = await createSession();
    await propose(agentSessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    await propose(agentSessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "默认提案。" }],
    });
    const agentSession = await getOrRestoreSession(agentSessionId);
    const agentMessage = agentSession?.chatHistory.find((message) => message.role.kind === "agent");
    expect(agentMessage?.id).toMatch(/^external-agent-[0-9a-f-]{36}$/);
  });

  it("insertAfterLine 把块间空行归到上一块", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。\n\n第二段。\n\n第三段。" }],
    });

    const inserted = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "insertAfterLine", line: 2, markdown: "插入段。" }],
    });

    expect(inserted.status).toBe(200);
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    expect(session!.docDraftCandidateDoc).toBeTruthy();
    const markdown = session!.docDraftCandidateDoc!.content.map((block) => JSON.stringify(block)).join("\n");
    expect(markdown.indexOf("插入段。")).toBeGreaterThan(markdown.indexOf("第一段。"));
    expect(markdown.indexOf("插入段。")).toBeLessThan(markdown.indexOf("第二段。"));
  });

  it("insertAfterLine 在 ai-block 多块文档中只产生一个 hunk，并保留未触碰块身份", async () => {
    const sessionId = await createSession();
    const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>第 ${index + 1} 段。</p>`).join("");
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: paragraphs }],
    });
    const before = await getOrRestoreSession(sessionId);
    const beforeIds = before!.doc!.content.map((block) => block.attrs.blockId);
    expect(beforeIds.every((blockId) => blockId.startsWith("ai-block-"))).toBe(true);

    const inserted = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "insertAfterLine", line: 2, markdown: "插入段。" }],
    });

    expect(inserted.status).toBe(200);
    expect(await inserted.json()).toMatchObject({ status: "review", count: 1 });
    const session = await getOrRestoreSession(sessionId);
    const candidateIds = session!.docDraftCandidateDoc!.content
      .filter((block) => !JSON.stringify(block).includes("插入段。"))
      .map((block) => block.attrs.blockId);
    expect(candidateIds).toEqual(beforeIds);
    expect([...session!.suggestions.values()].map((record) => record.diffHunk?.afterText))
      .toEqual(["插入段。"]);
  });

  it("insertAfterBlock 纳入 opId digest 幂等，并在接受后拒绝重放", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。\n\n第二段。" }],
    });
    const canonical = await getOrRestoreSession(sessionId);
    const anchorId = canonical!.doc!.content[0]!.attrs.blockId;
    const request = {
      expectedDocVersion: 1,
      opId: "insert-after-block-idempotent",
      ops: [{ kind: "insertAfterBlock" as const, blockId: anchorId, markdown: "插入段。" }],
    };

    const inserted = await propose(sessionId, request);
    expect(inserted.status).toBe(200);
    const firstBody = await inserted.json() as {
      status: string;
      patchIds: string[];
      count: number;
      charCount: number;
      seq: number;
    };
    expect(firstBody).toMatchObject({ status: "review", count: 1 });
    const pending = await getOrRestoreSession(sessionId);
    const candidate = pending!.docDraftCandidateDoc!;
    assertUniquePmBlockIds(candidate);
    expect([...pending!.suggestions.values()].map((record) => record.diffHunk)).toEqual([
      expect.objectContaining({ op: "insert", afterText: "插入段。" }),
    ]);
    const candidateHash = getPmContentHash(candidate);

    const replayed = await propose(sessionId, request);
    expect(replayed.status).toBe(200);
    const replayedBody = await replayed.json() as typeof firstBody;
    expect(replayedBody).toMatchObject({
      status: firstBody.status,
      patchIds: firstBody.patchIds,
      count: firstBody.count,
      charCount: firstBody.charCount,
    });
    expect(getPmContentHash((await getOrRestoreSession(sessionId))!.docDraftCandidateDoc!))
      .toBe(candidateHash);

    const reusedWithDifferentBody = await propose(sessionId, {
      ...request,
      ops: [{ kind: "insertAfterBlock", blockId: anchorId, markdown: "另一段。" }],
    });
    expect(reusedWithDifferentBody.status).toBe(400);
    expect(await reusedWithDifferentBody.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("opId 已用于另一份操作内容"),
    });

    const accepted = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "reviewed",
      docVersion: 2,
      acceptedCount: 1,
      rejectedCount: 0,
      remainingCount: 0,
    });
    const settled = await getOrRestoreSession(sessionId);
    expect(pmToMarkdown(settled!.doc!)).toBe("第一段。\n\n插入段。\n\n第二段。");
    expect(getPmContentHash(settled!.doc!)).toBe(candidateHash);

    const replayedAfterAccept = await propose(sessionId, request);
    expect(replayedAfterAccept.status).toBe(400);
    expect(await replayedAfterAccept.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("已结束审阅，不能重放"),
    });
  });

  it("相邻重复 insertAfterBlock 使含前序删除的整批失败，且不记账 opId", async () => {
    const sessionId = await createSession();
    const initialMarkdown = "段A\n\n段B\n\n段C";
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: initialMarkdown }],
    });
    const before = await getOrRestoreSession(sessionId);
    const beforeHash = getPmContentHash(before!.doc!);
    const anchorId = before!.doc!.content[0]!.attrs.blockId;
    const deleteId = before!.doc!.content[2]!.attrs.blockId;
    const opId = "insert-after-block-adjacent-duplicate";

    const failed = await propose(sessionId, {
      expectedDocVersion: 1,
      opId,
      ops: [
        { kind: "deleteBlock", blockId: deleteId },
        { kind: "insertAfterBlock", blockId: anchorId, markdown: "段B" },
      ],
    });

    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("插入内容与锚点后相邻块重复"),
    });
    const afterFailed = await getOrRestoreSession(sessionId);
    expect(getPmContentHash(afterFailed!.doc!)).toBe(beforeHash);
    expect(pmToMarkdown(afterFailed!.doc!)).toBe(initialMarkdown);
    expect(afterFailed!.docDraftCandidateDoc).toBeNull();
    expect(afterFailed!.suggestions.size).toBe(0);
    expect(afterFailed!.externalStructuralOpDigests.has(opId)).toBe(false);

    const retried = await propose(sessionId, {
      expectedDocVersion: 1,
      opId,
      ops: [
        { kind: "deleteBlock", blockId: deleteId },
        { kind: "insertAfterBlock", blockId: anchorId, markdown: "新段" },
      ],
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: "review", count: 2 });
    const afterRetry = await getOrRestoreSession(sessionId);
    expect(pmToMarkdown(afterRetry!.docDraftCandidateDoc!)).toBe("段A\n\n新段\n\n段B");
    expect(afterRetry!.externalStructuralOpDigests.has(opId)).toBe(true);
  });

  it("insertAfterBlock 拒绝审阅后 canonical 保持不变", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "原段一。\n\n原段二。" }],
    });
    const before = await getOrRestoreSession(sessionId);
    const beforeHash = getPmContentHash(before!.doc!);
    const anchorId = before!.doc!.content[0]!.attrs.blockId;

    const inserted = await propose(sessionId, {
      expectedDocVersion: 1,
      opId: "insert-after-block-reject",
      ops: [{ kind: "insertAfterBlock", blockId: anchorId, markdown: "拒绝此段。" }],
    });
    expect(inserted.status).toBe(200);
    const rejected = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      status: "reviewed",
      docVersion: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      remainingCount: 0,
    });
    const settled = await getOrRestoreSession(sessionId);
    expect(getPmContentHash(settled!.doc!)).toBe(beforeHash);
    expect(pmToMarkdown(settled!.doc!)).toBe("原段一。\n\n原段二。");
    expect(settled!.docDraftCandidateDoc).toBeNull();
  });

  it("w1 固化：单批删二加一拆成 3 个项级 hunk，结算后仍为唯一 7 项非空 taskList", async () => {
    const sessionId = await createSession();
    const initialMarkdown = insertAfterBlockW1.initialItems
      .map((item) => `- [ ] ${item}`)
      .join("\n");
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: initialMarkdown }],
    });
    const canonical = await getOrRestoreSession(sessionId);
    const initialList = getOnlyTaskList(canonical!.doc!);
    const deleteBlockIds = insertAfterBlockW1.deleteIndexes.map(
      (index) => initialList.content[index]!.attrs.blockId,
    );
    const anchorBlockId = initialList.content[insertAfterBlockW1.anchorIndex]!.attrs.blockId;

    const proposed = await propose(sessionId, {
      expectedDocVersion: 1,
      opId: "w1-delete-two-insert-one",
      ops: [
        ...deleteBlockIds.map((blockId) => ({ kind: "deleteListItem" as const, blockId })),
        {
          kind: "insertAfterBlock",
          blockId: anchorBlockId,
          markdown: insertAfterBlockW1.insertMarkdown,
        },
      ],
    });
    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ status: "review", count: 3 });
    const pending = await getOrRestoreSession(sessionId);
    expect([...pending!.suggestions.values()].map((record) => record.diffHunk)).toEqual([
      expect.objectContaining({ op: "delete", blockPath: [0, 2] }),
      expect.objectContaining({ op: "insert", blockPath: [0, 3] }),
      expect.objectContaining({ op: "delete", blockPath: [0, 5] }),
    ]);
    const candidate = pending!.docDraftCandidateDoc!;
    const candidateSnapshot = taskListSnapshot(candidate);
    expect(candidateSnapshot).toEqual({
      taskLists: 1,
      taskItems: 7,
      emptyTaskItems: 0,
      labels: insertAfterBlockW1.expectedLabels,
    });
    assertUniquePmBlockIds(candidate);
    const candidateHash = getPmContentHash(candidate);

    const accepted = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "reviewed",
      docVersion: 2,
      acceptedCount: 3,
      rejectedCount: 0,
      remainingCount: 0,
    });
    const settled = await getOrRestoreSession(sessionId);
    expect(taskListSnapshot(settled!.doc!)).toEqual(candidateSnapshot);
    expect(getPmContentHash(settled!.doc!)).toBe(candidateHash);
    assertUniquePmBlockIds(settled!.doc!);
  });

  it("结构操作失败文案不向外部调用方泄漏内部工具名", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "原正文。" }],
    });

    const response = await propose(sessionId, {
      expectedDocVersion: 1,
      opId: "missing-block",
      ops: [{ kind: "deleteBlock", blockId: "missing-block-id" }],
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("请重新读取文档并使用最新 blockId");
    expect(body.error).not.toContain("readDraft");
  });

  it("RC1/r18c：按 blockId 原子删除整节，不留下空 h2/h3/p，并按 opId 回放原审阅批次", async () => {
    const sessionId = await createSession();
    const sectionMarkdown = [
      "## 第一节", "第一节正文",
      "## 第二节", "第二节正文",
      "## 第三节", "### 第三节甲", "第三节甲正文", "### 第三节乙", "第三节乙正文",
      "## 第四节", "第四节正文",
      "## 第五节", "第五节正文",
    ].join("\n\n");
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: sectionMarkdown }],
    });
    const canonical = await getOrRestoreSession(sessionId);
    const targetIds = canonical!.doc!.content.slice(4, 9).map((block) => block.attrs.blockId);
    const request = {
      expectedDocVersion: 1,
      opId: "r18c-delete-third-section",
      ops: [
        ...targetIds.map((blockId) => ({ kind: "deleteBlock" as const, blockId })),
        { kind: "setTitle" as const, title: "题".repeat(60) },
      ],
    };

    const deleted = await propose(sessionId, request);
    expect(deleted.status).toBe(200);
    const firstBody = await deleted.json() as {
      status: string;
      patchIds: string[];
      count: number;
      charCount: number;
      notices: Array<{ code: string; message: string; maxChars: number }>;
      seq: number;
    };
    expect(firstBody.status).toBe("review");
    expect(firstBody.notices).toEqual([{
      code: "TITLE_TRUNCATED",
      message: "标题超过 48 个字符，已截断",
      maxChars: 48,
    }]);
    const pending = await getOrRestoreSession(sessionId);
    const candidate = pending!.docDraftCandidateDoc!;
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain("第三节");
    expect(candidate.content.some((block) =>
      (block.type === "heading" || block.type === "paragraph") &&
      (!block.content || block.content.length === 0)
    )).toBe(false);

    const replayed = await propose(sessionId, request);
    expect(replayed.status).toBe(200);
    const replayedBody = await replayed.json() as typeof firstBody;
    expect(replayedBody).toEqual({ ...firstBody, seq: replayedBody.seq });
    expect(replayedBody.seq).toBeGreaterThan(firstBody.seq);
    expect((await getOrRestoreSession(sessionId))!.suggestions.size).toBe(firstBody.count);

    const reused = await propose(sessionId, {
      ...request,
      ops: [{ kind: "deleteBlock", blockId: canonical!.doc!.content[0]!.attrs.blockId }],
    });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("opId 已用于另一份操作内容"),
    });

    const rejected = await app.request(`/api/v1/external/sessions/${sessionId}/review/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      status: "reviewed",
      docVersion: 1,
      acceptedCount: 0,
      rejectedCount: firstBody.count,
      remainingCount: 0,
    });

    const settledAfterReject = await getOrRestoreSession(sessionId);
    expect(settledAfterReject?.docState).toEqual({ kind: "editing" });
    expect(settledAfterReject?.suggestions.size).toBe(0);
    expect(settledAfterReject?.docDraftCandidateDoc).toBeNull();
    await sessionManager.disposeSession(sessionId);
    const replayedAfterReject = await propose(sessionId, request);
    expect(replayedAfterReject.status).toBe(400);
    expect(await replayedAfterReject.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("已结束审阅，不能重放"),
    });
  });

  it("P20/P39：QingML 长标题显式告知截断，响应字数使用 canonical 口径", async () => {
    const sessionId = await createSession();
    const response = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{
        kind: "qingmlDraft",
        qingml: `<title>${"长".repeat(60)}</title><tasks><task>甲 乙</task></tasks><p>正文。</p>`,
      }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "committed",
      charCount: 5,
      notices: [{ code: "TITLE_TRUNCATED", maxChars: 48 }],
    });

    const read = await app.request(`/api/v1/external/sessions/${sessionId}/doc`, {
      headers: authHeaders(),
    });
    expect(await read.json()).toMatchObject({ charCount: 5, title: "长".repeat(48) });
  });

  it("P20：setTitle write 通道接受长标题，显式截断并返回 notice", async () => {
    const sessionId = await createSession();
    const response = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "setTitle", title: "题".repeat(60) }],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "committed",
      docVersion: 0,
      notices: [{ code: "TITLE_TRUNCATED", maxChars: 48 }],
    });
    expect((await getOrRestoreSession(sessionId))?.title).toBe("题".repeat(48));
  });
});

async function createSession(): Promise<string> {
  const res = await app.request("/api/v1/external/sessions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title: "测试文档" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

async function propose(sessionId: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return app.request(`/api/v1/external/sessions/${sessionId}/proposals`, {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

function getOnlyTaskList(doc: PmDoc): PmTaskListNode {
  const taskLists = doc.content.filter((block): block is PmTaskListNode => block.type === "taskList");
  expect(taskLists).toHaveLength(1);
  return taskLists[0]!;
}

function taskItemText(item: PmTaskItemNode, schemaVersion: PmDoc["attrs"]["schemaVersion"]): string {
  return pmToPlainText({
    type: "doc",
    attrs: { schemaVersion },
    content: item.content,
  }, { skipTaskMarkers: true }).trim();
}

function taskListSnapshot(doc: PmDoc): {
  taskLists: number;
  taskItems: number;
  emptyTaskItems: number;
  labels: string[];
} {
  const taskList = getOnlyTaskList(doc);
  const texts = taskList.content.map((item) => taskItemText(item, doc.attrs.schemaVersion));
  return {
    taskLists: 1,
    taskItems: taskList.content.length,
    emptyTaskItems: texts.filter((text) => text.length === 0).length,
    labels: texts.map((text) =>
      insertAfterBlockW1.expectedLabels.find((label) => text.includes(label)) ?? text
    ),
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ReviewContext } from "@qingagent/contract-ts";
import {
  createSession,
  createSessionScopedTools,
  getDocumentsClient,
} from "@qingagent/core";
import { runMigrations } from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import type { CommandExecutionContext } from "../commandTypes";
import { handleReviewCommand } from "../reviewCommands";
import { getOrRestoreSession } from "../sessionLifecycle";

vi.mock("../sessionLifecycle", () => ({
  findSessionByPatch: vi.fn(),
  findSessionByReviewBatchId: vi.fn(),
  getOrRestoreSession: vi.fn(),
}));

let db: TempDocumentsDb;

beforeEach(async () => {
  db = prepareTempDocumentsDb("qa-review-dismissal-gateway-flow-");
  await runMigrations();
});

afterEach(() => db.cleanup());

const context: CommandExecutionContext = {
  sessionId: "review-dismissal-gateway-flow",
  clientTraceId: undefined,
  resolvedClientTraceId: undefined,
  origin: "manual",
  modelOverrides: undefined,
  client: undefined,
  commandAbortSignal: undefined,
};

const CUSTOM_REVIEW: ReviewContext = {
  type: "custom",
  templateId: "review-custom-logic-chain",
  templateName: "逻辑链审查",
};

function reviewCtx(reviewContext: ReviewContext) {
  return {
    requestContext: {
      get: (key: string) => key === "reviewContext" ? reviewContext : undefined,
    },
  } as never;
}

async function collectFrames(
  generator: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("下次不再提示 gateway→数据库→审查工具闭环", () => {
  it("生产 gateway 写入真实信号后，同模板重跑抑制边界多一字的同处批注", async () => {
    const state = createSession(context.sessionId!);
    state.doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text: "各部门应尽快推动项目落地，但方案没有负责人。" }],
      }],
    };
    vi.mocked(getOrRestoreSession).mockResolvedValue(state);
    await getDocumentsClient().execute({
      sql: `INSERT INTO documents(
        id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
      ) VALUES(?,?,?,?,?,?,?,?)`,
      args: [
        state.docId,
        state.sessionId,
        state.resourceId,
        "逻辑链审查素材",
        "editing",
        "2026-08-02T10:00:00.000Z",
        "2026-08-02T10:00:00.000Z",
        "main",
      ],
    });

    const tool = createSessionScopedTools(state).createAnnotationGroups;
    const first = await tool.execute!({
      groups: [{
        summary: "行动要求缺少责任人",
        note: "只有动作要求，没有责任主体。",
        origin: "模型错填",
        anchors: [{ find: "尽快推动项目落地" }],
      }],
    }, reviewCtx(CUSTOM_REVIEW));
    expect(first).toMatchObject({ ok: true, groupCount: 1 });
    const remembered = state.annotationGroups[0]!;

    const frames = await collectFrames(handleReviewCommand({
      kind: "ignoreAnnotationGroups",
      data: {
        sessionId: state.sessionId,
        reason: "item_ignored",
        groupIds: [remembered.id],
        rememberDismissal: true,
      },
    }, context));
    expect(frames.at(-1)).toMatchObject({
      kind: "annotationGroupsReady",
      data: { groups: [{ id: remembered.id, status: "ignored" }] },
    });

    const rows = await getDocumentsClient().execute({
      sql: "SELECT doc_id,origin,quote FROM review_dismissal_signals WHERE doc_id=?",
      args: [state.docId],
    });
    expect(rows.rows).toEqual([expect.objectContaining({
      doc_id: state.docId,
      origin: "自定义审查:逻辑链审查",
      quote: "尽快推动项目落地",
    })]);

    state._annotationOriginsReplacedThisTurn = new Set();
    const rerun = await tool.execute!({
      groups: [{
        summary: "责任主体缺失",
        note: "行动要求没有明确由谁负责。",
        origin: "模型再次错填",
        anchors: [{ find: "应尽快推动项目落地" }],
      }],
    }, reviewCtx(CUSTOM_REVIEW));

    expect(rerun).toMatchObject({
      ok: true,
      groupCount: 0,
      rememberedDismissalCount: 1,
      errors: [],
    });
  });
});

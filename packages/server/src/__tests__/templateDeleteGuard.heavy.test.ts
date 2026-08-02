import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  createDerivativeDoc,
  documentRepo,
  saveStyleTemplate,
} from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { handleCommand } from "../gateway/bridgeHandler";

async function collectFrames(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

async function createSession(): Promise<string> {
  const frames = await collectFrames(handleCommand({
    kind: "startSession",
    data: { mode: { kind: "new", data: { template: null } } },
  }));
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("缺少 sessionMeta");
  return meta.data.sessionId;
}

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-template-delete-guard-"); });
afterEach(() => db.cleanup());

describe("模板删除保底 bridge 路径", () => {
  it("bridge 拒绝覆盖内置审查模板，风格模板未传 detail 时保留原值", async () => {
    const sessionId = await createSession();

    await expect(collectFrames(handleCommand({
      kind: "saveReviewTemplate",
      data: {
        sessionId,
        requestId: "request-review-save",
        id: "review-source-default",
        type: "source",
        name: "自定义来源核查",
        prompt: "只核对金额",
      },
    }))).rejects.toThrow("内置审查模板不能修改");

    const beforeFrames = await collectFrames(handleCommand({
      kind: "getStyleTemplate",
      data: { sessionId, requestId: "request-style-load", id: "gzh-tutorial" },
    }));
    const before = beforeFrames.find((frame) => frame.kind === "styleTemplateLoaded");
    if (before?.kind !== "styleTemplateLoaded") throw new Error("缺少风格模板");

    const styleFrames = await collectFrames(handleCommand({
      kind: "saveStyleTemplate",
      data: {
        sessionId,
        requestId: "request-style-save",
        id: "gzh-tutorial",
        dtype: "gzh",
        slot: "writing",
        name: "自定义教程文",
        prompt: "按三步写",
      },
    }));
    expect(styleFrames).toContainEqual({
      kind: "styleTemplateSaved",
      data: {
        requestId: "request-style-save",
        item: expect.objectContaining({
          id: "gzh-tutorial",
          detail: before.data.item.detail,
          builtin: false,
        }),
      },
    });
  });

  it("审查与风格内置模板都返回前端可读错误帧", async () => {
    const sessionId = await createSession();

    const reviewFrames = await collectFrames(handleCommand({
      kind: "deleteReviewTemplate",
      data: { sessionId, requestId: "request-review-delete", id: "review-source-default" },
    }));
    expect(reviewFrames).toContainEqual({
      kind: "reviewTemplateDeleted",
      data: {
        requestId: "request-review-delete",
        id: "review-source-default",
        selectedTemplateId: "review-source-default",
        error: "内置审查模板不能删除",
      },
    });

    const firstStyleDelete = await collectFrames(handleCommand({
      kind: "deleteStyleTemplate",
      data: { sessionId, requestId: "request-style-delete-first", id: "gzh-layout-classic" },
    }));
    expect(firstStyleDelete).toContainEqual({
      kind: "styleTemplateDeleted",
      data: {
        requestId: "request-style-delete-first",
        id: "gzh-layout-classic",
        error: "内置模板不可删除",
      },
    });
  });

  it("删除被衍生稿引用的风格模板时返回明确稿件数", async () => {
    const sessionId = await createSession();
    const template = await saveStyleTemplate({
      dtype: "gzh",
      slot: "writing",
      name: "在用写法",
      prompt: "写作规则",
    });
    await documentRepo.save(documentInput("source", {
      threadId: sessionId,
      docVersion: 1,
    }));
    await createDerivativeDoc({
      threadId: sessionId,
      sourceDocId: "source",
      dtype: "gzh",
      writingStyleId: template.id,
      privatePrompt: "",
    });

    const frames = await collectFrames(handleCommand({
      kind: "deleteStyleTemplate",
      data: {
        sessionId,
        requestId: "request-style-delete-in-use",
        id: template.id,
      },
    }));

    expect(frames).toContainEqual({
      kind: "styleTemplateDeleted",
      data: {
        requestId: "request-style-delete-in-use",
        id: template.id,
        error: "仍有 1 篇稿件使用该模板，无法删除",
      },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
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
  it("bridge 保存内置模板后原 id 降级，风格模板未传 detail 时保留原值", async () => {
    const sessionId = await createSession();

    const reviewFrames = await collectFrames(handleCommand({
      kind: "saveReviewTemplate",
      data: {
        sessionId,
        id: "review-source-default",
        type: "source",
        name: "自定义来源核查",
        prompt: "只核对金额",
      },
    }));
    expect(reviewFrames).toContainEqual({
      kind: "reviewTemplateSaved",
      data: {
        item: expect.objectContaining({
          id: "review-source-default",
          name: "自定义来源核查",
          builtin: false,
        }),
      },
    });

    const beforeFrames = await collectFrames(handleCommand({
      kind: "getStyleTemplate",
      data: { sessionId, id: "gzh-tutorial" },
    }));
    const before = beforeFrames.find((frame) => frame.kind === "styleTemplateLoaded");
    if (before?.kind !== "styleTemplateLoaded") throw new Error("缺少风格模板");

    const styleFrames = await collectFrames(handleCommand({
      kind: "saveStyleTemplate",
      data: {
        sessionId,
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
        item: expect.objectContaining({
          id: "gzh-tutorial",
          detail: before.data.item.detail,
          builtin: false,
        }),
      },
    });
  });

  it("审查与风格最后一个模板都返回前端可读错误帧", async () => {
    const sessionId = await createSession();

    const reviewFrames = await collectFrames(handleCommand({
      kind: "deleteReviewTemplate",
      data: { sessionId, id: "review-source-default" },
    }));
    expect(reviewFrames).toContainEqual({
      kind: "reviewTemplateDeleted",
      data: {
        id: "review-source-default",
        selectedTemplateId: "review-source-default",
        error: "每类至少保留一个模板",
      },
    });

    const firstStyleDelete = await collectFrames(handleCommand({
      kind: "deleteStyleTemplate",
      data: { sessionId, id: "gzh-layout-classic" },
    }));
    expect(firstStyleDelete).toContainEqual({
      kind: "styleTemplateDeleted",
      data: { id: "gzh-layout-classic" },
    });

    const lastStyleDelete = await collectFrames(handleCommand({
      kind: "deleteStyleTemplate",
      data: { sessionId, id: "gzh-layout-minimal" },
    }));
    expect(lastStyleDelete).toContainEqual({
      kind: "styleTemplateDeleted",
      data: { id: "gzh-layout-minimal", error: "每类至少保留一个模板" },
    });
  });
});

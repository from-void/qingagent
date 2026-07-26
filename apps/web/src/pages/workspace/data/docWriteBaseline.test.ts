import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { isEmptyScaffoldConflict, type DocWriteBaseline } from "./docWriteBaseline";

const emptyDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [],
};
const textDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "paragraph",
    attrs: { blockId: "p-1" },
    content: [{ type: "text", text: "用户输入" }],
  }],
};
const emptyBaseline: DocWriteBaseline = {
  expectedDocumentSnapshot: 0,
  baseContentHash: "pmv1-empty",
  baseHasSubstantiveContent: false,
};

describe("isEmptyScaffoldConflict", () => {
  it("空基线的空脚手架冲突可静默拉取权威快照", () => {
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: emptyDoc,
      queuedDoc: null,
    })).toBe(true);
  });

  it("提交或排队中含用户正文时绝不进入静默覆盖路径", () => {
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: textDoc,
      queuedDoc: null,
    })).toBe(false);
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: emptyDoc,
      queuedDoc: textDoc,
    })).toBe(false);
  });

  it("从有正文基线删除到空也保留为用户冲突", () => {
    expect(isEmptyScaffoldConflict({
      baseline: { ...emptyBaseline, baseHasSubstantiveContent: true },
      submittedDoc: emptyDoc,
      queuedDoc: null,
    })).toBe(false);
  });
});

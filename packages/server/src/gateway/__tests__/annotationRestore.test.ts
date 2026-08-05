import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationGroup } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import { insertAnnotationGroups, listActiveAnnotationGroups } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import type { PmDoc } from "@qingagent/pm-schema";
import {
  emitRestoreFrames,
  reconcileSessionAnnotationAnchors,
} from "../restoreFrames";

const baseTextStart = "前文".length + 3;
const insertedPrefix = "ABCDE";

function shiftedDoc(tail: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "before-block" },
        content: [{ type: "text", text: `${insertedPrefix}前文` }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "annotated-block" },
        content: [{ type: "text", text: tail }],
      },
    ],
  };
}

function group(quote: string): AnnotationGroup {
  return {
    id: `group-${quote}`,
    summary: "恢复批注",
    note: "恢复后 hover 与高亮必须一致",
    origin: "consistency",
    status: "reviewing",
    anchors: [{
      blockId: "annotated-block",
      pmFrom: baseTextStart,
      pmTo: baseTextStart + quote.length,
      quote,
      textHash: `hash-${quote}`,
    }],
  };
}

describe("批注恢复重定位", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-annotation-restore-");
  });

  afterEach(() => db.cleanup());

  it("冷恢复把前部插入后遗留的绝对坐标重新锚到原文并写回 DB", async () => {
    const session = createSession("restore-shifted-annotation");
    const annotation = group("超过 3 秒");
    session.doc = shiftedDoc("超过 3 秒后仍有 YYMARK");
    session.annotationGroups = [annotation];
    await insertAnnotationGroups(session.docId, 1, [annotation]);

    await expect(reconcileSessionAnnotationAnchors(session)).resolves.toBe(true);

    expect(session.annotationGroups[0]?.anchors[0]).toMatchObject({
      quote: "超过 3 秒",
      pmFrom: baseTextStart + insertedPrefix.length,
      pmTo: baseTextStart + insertedPrefix.length + "超过 3 秒".length,
    });
    await expect(listActiveAnnotationGroups(session.docId)).resolves.toEqual(
      session.annotationGroups,
    );
  });

  it("原文不存在时持久化失效并在恢复帧提示隐藏高亮", async () => {
    const session = createSession("restore-invalidated-annotation");
    const annotation = group("YYMARK");
    session.doc = shiftedDoc("原标记已不存在");
    session.annotationGroups = [annotation];
    await insertAnnotationGroups(session.docId, 1, [annotation]);

    await expect(reconcileSessionAnnotationAnchors(session)).resolves.toBe(true);

    expect(session.annotationGroups).toEqual([]);
    await expect(listActiveAnnotationGroups(session.docId)).resolves.toEqual([]);
    expect([...emitRestoreFrames(session)]).toContainEqual({
      kind: "annotationGroupsReady",
      data: { groups: [], invalidatedAnchorCount: 1 },
    });
  });
});

import { describe, expect, it } from "vitest";
import { assertPmMigrationRegistryContinuous, migratePmDoc } from "../migrations";
import { legacySectionsToPm, type LegacyLegacySection } from "../legacy/legacySectionsToPm";
import { pmToLegacySections } from "../legacy/pmToLegacySections";
import { pmToPlainText } from "../pmToPlainText";
import type { PmDoc } from "../types";

describe("legacyMigration", () => {
  it("converts legacy sections idempotently with deterministic block ids", () => {
    const sections: LegacyLegacySection[] = [
      { kind: "h1", data: { text: "标题" } },
      { kind: "h3", data: { text: "三级标题" } },
      { kind: "h4", data: { text: "四级标题" } },
      { kind: "h5", data: { text: "五级标题" } },
      { kind: "h6", data: { text: "六级标题" } },
      { kind: "list", data: { ordered: false, items: ["条目一", "条目二"] } },
      { kind: "quote", data: { text: "引用" } },
      { kind: "hr", data: {} },
      { kind: "table", data: { head: ["A", "B"], rows: [["1", "2"]] } },
      { kind: "code", data: { body: "const x = 1;", language: "ts" } },
      { kind: "penNote", data: { text: "手写笔记" } },
      {
        kind: "image",
        data: {
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
          alt: "图片",
          caption: "说明",
        },
      },
    ];

    const first = legacySectionsToPm(sections);
    const second = legacySectionsToPm(sections);

    expect(first).toEqual(second);
    expect(first.content.map((node) => node.attrs.blockId)).toEqual(second.content.map((node) => node.attrs.blockId));
    expect(first.content.flatMap((node) => (node.type === "heading" ? [node.attrs.level] : []))).toEqual([1, 3, 4, 5, 6]);
    expect(first.content.map((node) => node.type)).toContain("bulletList");
    expect(first.content.map((node) => node.type)).toContain("blockquote");
    expect(first.content.map((node) => node.type)).toContain("horizontalRule");
    expect(pmToPlainText(first)).toContain("手写笔记");
  });

  it("keeps plain text compatible with legacy sections", () => {
    const sections: LegacyLegacySection[] = [
      { kind: "p", data: { text: "正文" } },
      { kind: "penNote", data: { text: "批注" } },
    ];

    const pm = legacySectionsToPm(sections);
    const legacy = pmToLegacySections(pm);

    expect(pmToPlainText(pm)).toBe("正文\n批注");
    expect(legacy).toEqual(sections);
  });

  it("legacy 不齐列表格按全表最大列数补空，不让整篇转换失败", () => {
    const pm = legacySectionsToPm([{
      kind: "table",
      data: {
        head: ["A", "B"],
        rows: [["1"], ["x", "y", "z"]],
      },
    }]);
    const table = pm.content[0];

    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.content.map((row) => row.content.length)).toEqual([3, 3, 3]);
  });

  it("legacy 有序列表往返保留非正 start", () => {
    const sections: LegacyLegacySection[] = [{
      kind: "list",
      data: { ordered: true, start: -3, items: ["条目"] },
    }];
    const pm = legacySectionsToPm(sections);

    expect(pmToLegacySections(pm)).toEqual(sections);
  });

  it("documents legacy taskList downgrade: nested task children stay as plain text, not task hierarchy", () => {
    const pm: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-1", checked: false },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "task-1-p" },
                  content: [{ type: "text", text: "父任务" }],
                },
                {
                  type: "taskList",
                  attrs: { blockId: "task-1-children" },
                  content: [
                    {
                      type: "taskItem",
                      attrs: { blockId: "task-1-child", checked: true },
                      content: [
                        {
                          type: "paragraph",
                          attrs: { blockId: "task-1-child-p" },
                          content: [{ type: "text", text: "子任务" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(pmToLegacySections(pm)).toEqual([
      {
        kind: "list",
        data: {
          ordered: false,
          items: ["[ ] 父任务\n[x] 子任务"],
        },
      },
    ]);
  });

  it("keeps h2 anchor, code language, and image alt stable across the legacy PM bridge", () => {
    const sections: LegacyLegacySection[] = [
      { kind: "h2", data: { text: "带锚点的小节", anchor: "sec-anchor" } },
      { kind: "code", data: { body: "const x = 1;", language: "typescript" } },
      {
        kind: "image",
        data: {
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
          alt: "架构图",
	          caption: "图 1",
	          width: 640,
	          height: 360,
	          align: "right",
	        },
	      },
    ];

    expect(pmToLegacySections(legacySectionsToPm(sections))).toEqual(sections);
  });

  it("has a continuous migration registry and v1 idempotent migration", () => {
    const pm = legacySectionsToPm([{ kind: "p", data: { text: "正文" } }]);

    expect(() => assertPmMigrationRegistryContinuous()).not.toThrow();
    expect(migratePmDoc(pm, 1, 1)).toEqual(pm);
  });
});

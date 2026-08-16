import { describe, expect, it } from "vitest";
import type { PmDoc } from "../types";
import { arePmDocsPersistenceEquivalent } from "../persistenceEquivalence";
import { TRAILING_NODE_NOT_AFTER } from "../tiptap/createQingagentExtensions";

function orderedListDoc(options: {
  blockId?: string;
  materializedDefaults?: boolean;
  trailingText?: string | null;
  text?: string;
} = {}): PmDoc {
  const {
    blockId = "list-1",
    materializedDefaults = false,
    trailingText = null,
    text = "第一项",
  } = options;
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "orderedList",
      attrs: {
        blockId,
        start: 1,
        ...(materializedDefaults ? { listStyle: "decimal", type: null } : {}),
      },
      content: [{
        type: "listItem",
        attrs: { blockId: "item-1" },
        content: [{
          type: "paragraph",
          attrs: {
            blockId: "item-1-paragraph",
            ...(materializedDefaults ? { textAlign: null } : {}),
          },
          content: [{ type: "text", text }],
        }],
      }],
    }, ...(
      trailingText === null
        ? []
        : [{
            type: "paragraph" as const,
            attrs: { blockId: "editor-trailing-paragraph", textAlign: null },
            ...(trailingText
              ? { content: [{ type: "text" as const, text: trailingText }] }
              : {}),
          }]
    )],
  } as PmDoc;
}

describe("arePmDocsPersistenceEquivalent", () => {
  it("吸收 TipTap 默认属性和列表后的尾随空段落", () => {
    expect(arePmDocsPersistenceEquivalent(
      orderedListDoc({ materializedDefaults: true, trailingText: "" }),
      orderedListDoc(),
    )).toBe(true);
  });

  it("保留 blockId 差异供块身份自愈落库", () => {
    expect(arePmDocsPersistenceEquivalent(
      orderedListDoc({ blockId: "repaired-list-id" }),
      orderedListDoc(),
    )).toBe(false);
  });

  it("不吸收真实正文差异或非空尾段", () => {
    expect(arePmDocsPersistenceEquivalent(
      orderedListDoc({ text: "第二项" }),
      orderedListDoc(),
    )).toBe(false);
    expect(arePmDocsPersistenceEquivalent(
      orderedListDoc({ trailingText: "真实尾段" }),
      orderedListDoc(),
    )).toBe(false);
  });

  it("不把普通段落后的空段落视为编辑器脚手架", () => {
    const paragraphDoc = (withTrailing: boolean): PmDoc => ({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "paragraph-1" },
        content: [{ type: "text", text: "正文" }],
      }, ...(withTrailing
        ? [{ type: "paragraph" as const, attrs: { blockId: "paragraph-2" } }]
        : [])],
    });
    expect(arePmDocsPersistenceEquivalent(
      paragraphDoc(true),
      paragraphDoc(false),
    )).toBe(false);
  });

  it("物化 schema 抛错时 fail closed 返回 false", () => {
    expect(arePmDocsPersistenceEquivalent(
      orderedListDoc({ materializedDefaults: true, trailingText: "" }),
      orderedListDoc(),
      {
        nodeFromJSON: () => {
          throw new Error("materialize failed");
        },
      },
    )).toBe(false);
  });

  it("固定 trailingNode 自身类型与 notAfter 的持久等价边界", () => {
    expect(TRAILING_NODE_NOT_AFTER).toEqual(["heading", "columnList"]);

    const heading = (withTrailing: boolean): PmDoc => ({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "heading",
        attrs: { blockId: "heading-1", level: 1 },
        content: [{ type: "text", text: "标题" }],
      }, ...(withTrailing
        ? [{ type: "paragraph" as const, attrs: { blockId: "heading-trailing" } }]
        : [])],
    });
    const columnList = (withTrailing: boolean): PmDoc => ({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "columnList",
        attrs: { blockId: "columns-1" },
        content: ["left", "right"].map((side) => ({
          type: "column" as const,
          attrs: { blockId: `column-${side}`, widthRatio: 1 },
          content: [{
            type: "paragraph" as const,
            attrs: { blockId: `column-${side}-paragraph` },
            content: [{ type: "text" as const, text: side }],
          }],
        })),
      }, ...(withTrailing
        ? [{ type: "paragraph" as const, attrs: { blockId: "columns-trailing" } }]
        : [])],
    } as PmDoc);

    expect(arePmDocsPersistenceEquivalent(heading(true), heading(false))).toBe(false);
    expect(arePmDocsPersistenceEquivalent(columnList(true), columnList(false))).toBe(false);
  });
});

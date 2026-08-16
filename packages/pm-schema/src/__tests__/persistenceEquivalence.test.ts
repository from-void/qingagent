import { describe, expect, it } from "vitest";
import type { PmDoc } from "../types";
import { arePmDocsPersistenceEquivalent } from "../persistenceEquivalence";

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
});

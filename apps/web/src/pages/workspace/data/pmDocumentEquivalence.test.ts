import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import type { PmDoc } from "@qingagent/pm-schema";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import {
  comparePmDocumentSemantics,
  type PmDocumentSchemaMaterializer,
} from "./pmDocumentEquivalence";

function paragraphDoc(blockId: string, text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId },
      content: [{ type: "text", text }],
    }],
  };
}

const throwingSchema: PmDocumentSchemaMaterializer = {
  nodeFromJSON() {
    throw new Error("schema materialization failed");
  },
};

const throwingEqSchema: PmDocumentSchemaMaterializer = {
  nodeFromJSON() {
    return {
      eq() {
        throw new Error("schema equality failed");
      },
    };
  },
};

const qingagentSchema = getSchema(createQingagentExtensions());

function orderedListEndingDoc(options: {
  materializedDefaults?: boolean;
  trailingText?: string | null;
} = {}): PmDoc {
  const { materializedDefaults = false, trailingText = null } = options;
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "orderedList",
        attrs: {
          blockId: "list-1",
          start: 1,
          ...(materializedDefaults ? { listStyle: "decimal", type: null } : {}),
        },
        content: [{
          type: "listItem",
          attrs: { blockId: "item-1" },
          content: [{
            type: "paragraph",
            attrs: {
              blockId: "item-1-p",
              ...(materializedDefaults ? { textAlign: null } : {}),
            },
            content: [{ type: "text", text: "第一项" }],
          }],
        }],
      },
      ...(trailingText === null
        ? []
        : [{
            type: "paragraph" as const,
            attrs: { blockId: "block-inserted~1", textAlign: null },
            ...(trailingText ? { content: [{ type: "text" as const, text: trailingText }] } : {}),
          }]),
    ],
  } as PmDoc;
}

describe("comparePmDocumentSemantics", () => {
  it("忽略各层 blockId 差异，物化异常时仍以相同规范正文证明等价", () => {
    expect(comparePmDocumentSemantics(
      throwingSchema,
      paragraphDoc("live-id", "同一正文"),
      paragraphDoc("canonical-id", "同一正文"),
    )).toBe("equivalent");
  });

  it("末尾无身份空段脚手架在两侧对称吸收", () => {
    const live = {
      ...paragraphDoc("live-id", "同一正文"),
      content: [
        ...paragraphDoc("live-id", "同一正文").content,
        { type: "paragraph", attrs: { blockId: null } },
      ],
    };
    expect(comparePmDocumentSemantics(
      throwingSchema,
      live,
      paragraphDoc("canonical-id", "同一正文"),
    )).toBe("equivalent");
    expect(comparePmDocumentSemantics(
      throwingSchema,
      paragraphDoc("canonical-id", "同一正文"),
      live,
    )).toBe("equivalent");
  });

  it("吸收带本地 blockId 的列表尾随空段，并物化 schema 默认属性", () => {
    const canonical = orderedListEndingDoc();
    const live = orderedListEndingDoc({
      materializedDefaults: true,
      trailingText: "",
    });

    expect(comparePmDocumentSemantics(qingagentSchema, live, canonical)).toBe("equivalent");
    expect(comparePmDocumentSemantics(qingagentSchema, canonical, live)).toBe("equivalent");
  });

  it("列表后的正文段落不是脚手架，仍判定为正文不同", () => {
    expect(comparePmDocumentSemantics(
      qingagentSchema,
      orderedListEndingDoc({
        materializedDefaults: true,
        trailingText: "真实尾段",
      }),
      orderedListEndingDoc(),
    )).toBe("different");
  });

  it("物化异常且正文不同返回 unavailable，不伪装成已证明分叉", () => {
    expect(comparePmDocumentSemantics(
      throwingSchema,
      paragraphDoc("live-id", "本地正文"),
      paragraphDoc("canonical-id", "远端正文"),
    )).toBe("unavailable");
    expect(comparePmDocumentSemantics(
      throwingEqSchema,
      paragraphDoc("live-id", "本地正文"),
      paragraphDoc("canonical-id", "远端正文"),
    )).toBe("unavailable");
  });
});

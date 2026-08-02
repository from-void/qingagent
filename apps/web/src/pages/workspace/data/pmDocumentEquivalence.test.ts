import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
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

// @vitest-environment jsdom

import type { PmDoc as ContractPmDoc } from "@qingagent/contract-ts";
import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { pmSchemaSpec } from "../spec";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";
import { safeParsePmDoc } from "../validators";

const diagramDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "diagram",
    attrs: {
      blockId: "diagram-layout",
      lang: "mermaid",
      source: "flowchart TD\n  A --> B\n",
      svg: null,
      height: 360,
      width: 480,
      align: "right",
    },
  }],
} satisfies ContractPmDoc;

describe("diagram layout schema parity", () => {
  it("共享类型、validator、spec 与基础 TipTap schema 都保留 width/align", () => {
    expect(safeParsePmDoc(diagramDoc).success).toBe(true);
    expect(pmSchemaSpec.nodes.diagram.attrs).toEqual([
      "blockId",
      "lang",
      "source",
      "svg",
      "height",
      "width",
      "align",
      "overlay",
    ]);

    const schema = getSchema(createQingagentExtensions());
    const node = ProseMirrorNode.fromJSON(schema, diagramDoc);
    expect(node.toJSON().content?.[0]?.attrs).toMatchObject({
      height: 360,
      width: 480,
      align: "right",
    });

    const host = document.createElement("div");
    host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
    expect(host.querySelector("[data-pm-node='diagram']")?.getAttribute("data-width")).toBe("480");
    expect(host.querySelector("[data-pm-node='diagram']")?.getAttribute("data-align")).toBe("right");
    expect(ProseMirrorDOMParser.fromSchema(schema).parse(host).toJSON().content?.[0]?.attrs).toMatchObject({
      height: 360,
      width: 480,
      align: "right",
    });
  });
});

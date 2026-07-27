import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import { toDocx } from "./toDocx.js";

function paragraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function orderedList(blockId: string, start: number, text: string): PmBlockNode {
  return {
    type: "orderedList",
    attrs: { blockId, start, listStyle: "decimal" },
    content: [{
      type: "listItem",
      attrs: { blockId: `${blockId}-item` },
      content: [paragraph(`${blockId}-paragraph`, text)],
    }],
  };
}

function paragraphNumberId(documentXml: string, text: string): string | null {
  const paragraphXml = documentXml
    .match(/<w:p>[\s\S]*?<\/w:p>/g)
    ?.find((paragraph) => paragraph.includes(`>${text}</w:t>`));
  return paragraphXml?.match(/<w:numId w:val="(\d+)"\/>/)?.[1] ?? null;
}

function startForNumberId(numberingXml: string, numberId: string): string | null {
  const concreteXml = numberingXml.match(
    new RegExp(`<w:num w:numId="${numberId}">[\\s\\S]*?<\\/w:num>`),
  )?.[0];
  const abstractId = concreteXml?.match(/<w:abstractNumId w:val="(\d+)"\/>/)?.[1];
  if (!abstractId) return null;
  const abstractXml = numberingXml.match(
    new RegExp(`<w:abstractNum w:abstractNumId="${abstractId}"[^>]*>[\\s\\S]*?<\\/w:abstractNum>`),
  )?.[0];
  return abstractXml?.match(/<w:lvl w:ilvl="0"[^>]*>[\s\S]*?<w:start w:val="(-?\d+)"\/>/)?.[1] ?? null;
}

describe("DOCX 有序列表编号", () => {
  it("保留 start，并让两个独立列表使用不同编号实例", async () => {
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        orderedList("first-list", 5, "第五项"),
        paragraph("separator", "中间正文"),
        orderedList("second-list", 1, "重新从一开始"),
      ],
    };

    const zip = await JSZip.loadAsync(await toDocx(doc));
    const documentXml = await zip.file("word/document.xml")?.async("string") ?? "";
    const numberingXml = await zip.file("word/numbering.xml")?.async("string") ?? "";
    const firstNumberId = paragraphNumberId(documentXml, "第五项");
    const secondNumberId = paragraphNumberId(documentXml, "重新从一开始");

    expect(firstNumberId).not.toBeNull();
    expect(secondNumberId).not.toBeNull();
    expect(firstNumberId).not.toBe(secondNumberId);
    expect(startForNumberId(numberingXml, firstNumberId!)).toBe("5");
    expect(startForNumberId(numberingXml, secondNumberId!)).toBe("1");
  });

  it.each([0, -3])("OOXML 原样保留 start=%i", async (start) => {
    const text = `起始值 ${start}`;
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [orderedList(`list-${start}`, start, text)],
    };

    const zip = await JSZip.loadAsync(await toDocx(doc));
    const documentXml = await zip.file("word/document.xml")?.async("string") ?? "";
    const numberingXml = await zip.file("word/numbering.xml")?.async("string") ?? "";
    const numberId = paragraphNumberId(documentXml, text);

    expect(numberId).not.toBeNull();
    expect(startForNumberId(numberingXml, numberId!)).toBe(String(start));
  });
});

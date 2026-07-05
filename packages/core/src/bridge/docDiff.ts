import type { LegacySection } from "@qingagent/contract-ts";

export function cloneLegacySections(sections: LegacySection[]): LegacySection[] {
  return sections.map((section): LegacySection => {
    switch (section.kind) {
      case "quote":
        return { kind: "quote", data: { text: section.data.text } };
      case "hr":
        return { kind: "hr", data: {} };
      case "list":
        return {
          kind: "list",
          data: { ordered: section.data.ordered, items: section.data.items.slice() },
        };
      case "h1":
        return { kind: "h1", data: { text: section.data.text } };
      case "h2":
        return {
          kind: "h2",
          data: { text: section.data.text, anchor: section.data.anchor },
        };
      case "p":
        return { kind: "p", data: { text: section.data.text } };
      case "penNote":
        return { kind: "penNote", data: { text: section.data.text } };
      case "code":
        return {
          kind: "code",
          data: {
            body: section.data.body,
            language: section.data.language ?? null,
          },
        };
      case "table":
        return {
          kind: "table",
          data: {
            head: section.data.head.slice(),
            rows: section.data.rows.map((row) => row.slice()),
          },
        };
      case "image":
        return {
          kind: "image",
          data: {
            src: section.data.src,
            alt: section.data.alt,
            caption: section.data.caption,
            width: section.data.width,
            height: section.data.height,
          },
        };
      case "diagram":
        return {
          kind: "diagram",
          data: { lang: section.data.lang, source: section.data.source, svg: section.data.svg },
        };
    }
  });
}

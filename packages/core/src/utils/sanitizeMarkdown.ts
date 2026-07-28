import type { LegacySection } from "@qingagent/contract-ts";

const MAX_INLINE_MARKER_SPAN = 200;

function stripPairedInlineMarkers(segment: string): string {
  const maxMiddle = MAX_INLINE_MARKER_SPAN - 2;
  return segment
    .replace(
      new RegExp(`\\*\\*([^\\s*](?:[^\\n]{0,${maxMiddle}}?[^\\s*])?)\\*\\*`, "g"),
      "$1",
    )
    .replace(
      new RegExp(`__([^\\s_](?:[^\\n]{0,${maxMiddle}}?[^\\s_])?)__`, "g"),
      "$1",
    );
}

function sanitizeInlineOutsideCode(line: string): string {
  let result = "";
  let index = 0;

  while (index < line.length) {
    const tickStart = line.indexOf("`", index);
    if (tickStart === -1) {
      result += stripPairedInlineMarkers(line.slice(index));
      break;
    }

    result += stripPairedInlineMarkers(line.slice(index, tickStart));

    let tickCount = 1;
    while (line[tickStart + tickCount] === "`") tickCount += 1;
    const fence = "`".repeat(tickCount);
    const codeEnd = line.indexOf(fence, tickStart + tickCount);
    if (codeEnd === -1) {
      result += line.slice(tickStart);
      break;
    }

    result += line.slice(tickStart, codeEnd + tickCount);
    index = codeEnd + tickCount;
  }

  return result;
}

function sanitizeMarkdownLine(line: string): string {
  const withoutHeading = line.replace(/^\s{0,3}#{1,6}\s+/, "");
  const withoutList = withoutHeading.replace(/^\s*[-*+]\s+/, "· ");
  return sanitizeInlineOutsideCode(withoutList);
}

export function sanitizeMarkdownInline(text: string): string {
  const parts = text.split(/(\r\n|\n|\r)/);
  let codeFence: { marker: "`" | "~"; length: number } | null = null;

  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      if (codeFence) {
        const closingMatch = part.match(/^\s*(`{3,}|~{3,})\s*$/);
        const closingFence = closingMatch?.[1];
        if (
          closingFence &&
          closingFence[0] === codeFence.marker &&
          closingFence.length >= codeFence.length
        ) {
          codeFence = null;
        }
        return part;
      }
      const openingMatch = part.match(/^\s*(`{3,}|~{3,})/);
      const openingFence = openingMatch?.[1];
      if (openingFence) {
        codeFence = {
          marker: openingFence[0] as "`" | "~",
          length: openingFence.length,
        };
        return part;
      }
      return sanitizeMarkdownLine(part);
    })
    .join("");
}

export function sanitizeSectionMarkdown(section: LegacySection): LegacySection {
  switch (section.kind) {
    case "quote":
      return { kind: "quote", data: { text: sanitizeMarkdownInline(section.data.text) } };
    case "hr":
      return section;
    case "list":
      return {
        kind: "list",
        data: {
          ordered: section.data.ordered,
          items: section.data.items.map(sanitizeMarkdownInline),
        },
      };
    case "h1":
      return { kind: "h1", data: { text: sanitizeMarkdownInline(section.data.text) } };
    case "h2":
      return {
        kind: "h2",
        data: {
          text: sanitizeMarkdownInline(section.data.text),
          anchor: section.data.anchor,
        },
      };
    case "p":
      return { kind: "p", data: { text: sanitizeMarkdownInline(section.data.text) } };
    case "penNote":
      return {
        kind: "penNote",
        data: { text: sanitizeMarkdownInline(section.data.text) },
      };
    case "table":
      return {
        kind: "table",
        data: {
          head: section.data.head.map(sanitizeMarkdownInline),
          rows: section.data.rows.map((row) => row.map(sanitizeMarkdownInline)),
        },
      };
    case "code":
    case "image":
    case "diagram":
      return section;
  }
}

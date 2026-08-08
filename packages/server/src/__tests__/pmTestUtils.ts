import { getDeterministicId, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";

export function pmDocFromText(text: string): PmDoc {
  return pmDocFromBlocks([{ type: "paragraph", text }]);
}

export function pmDocFromBlocks(
  blocks: ReadonlyArray<
    | { type: "paragraph"; text: string }
    | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  >,
): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: blocks.map((block, index): PmBlockNode => {
      const blockId = getDeterministicId("fixture-block", { index, block });
      const content = block.text ? [{ type: "text" as const, text: block.text }] : [];
      return block.type === "heading"
        ? { type: "heading", attrs: { blockId, level: block.level }, content }
        : { type: "paragraph", attrs: { blockId }, content };
    }),
  };
}

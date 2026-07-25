import { describe, expect, it } from "vitest";
import type { PatchMeta } from "../data/patchMeta";
import type { BlockPatchInput, ViewBlock } from "../data/protocol";
import { planRevealTypewriter } from "../data/revealTypewriter";
import {
  diagramBlockPatchIds,
  reviewTextRevealTarget,
} from "./useReviewReveal";

const paragraphBlock: ViewBlock = {
  kind: "p",
  spans: [{ kind: "text", text: "正文" }],
};

function patch(
  patchId: string,
  blocks: ViewBlock[],
): BlockPatchInput {
  return {
    patchId,
    op: "replace",
    blocks,
    blockCount: blocks.length,
  };
}

function meta(before: string, after: string): PatchMeta {
  return { before, after, index: 0 };
}

describe("useReviewReveal 的打字目标", () => {
  it("含 diagram 的 patch 目标为 0，保留入场且不被大源码拖长", () => {
    const largeXml = `<mxGraphModel>${"x".repeat(50_000)}</mxGraphModel>`;
    const diagramBlock: ViewBlock = {
      kind: "diagram",
      source: largeXml,
      lang: "drawio",
      svg: null,
    };
    const diagramPatch = patch("diagram-patch", [
      paragraphBlock,
      diagramBlock,
    ]);
    const diagramIds = diagramBlockPatchIds([diagramPatch]);
    const patchMeta = new Map([
      ["diagram-patch", meta("旧图", largeXml)],
    ]);
    const targetOf = (id: string) =>
      reviewTextRevealTarget(id, diagramIds, patchMeta);

    expect(targetOf("diagram-patch")).toBe(0);

    const frames = planRevealTypewriter(
      ["diagram-patch"],
      targetOf,
      1,
      1,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      revealed: ["diagram-patch"],
      typed: [["diagram-patch", 0]],
      cursors: [],
    });
  });

  it("不含 diagram 的正文 patch 仍按新增正文长度逐字揭示", () => {
    const textPatch = patch("text-patch", [paragraphBlock]);
    const diagramIds = diagramBlockPatchIds([textPatch]);
    const patchMeta = new Map([
      ["text-patch", meta("旧", "全新文案")],
    ]);
    const targetOf = (id: string) =>
      reviewTextRevealTarget(id, diagramIds, patchMeta);

    expect(targetOf("text-patch")).toBe(4);
    expect(
      planRevealTypewriter(["text-patch"], targetOf, 1, 1).map(
        (frame) => new Map(frame.typed).get("text-patch"),
      ),
    ).toEqual([0, 1, 2, 3, 4]);
  });
});

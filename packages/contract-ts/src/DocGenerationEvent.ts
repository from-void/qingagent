import type { PmDoc } from "./PmDoc";
import type { PmBlockNode } from "./PmNode";
import type { AiBlock, AiRun } from "./AiDocument";

export type DocGenerationEvent =
  | {
      kind: "generation_started";
      data: DocGenerationEventSeq & {
        sessionId: string;
        baseVersion: number;
      };
    }
  | {
      kind: "block_started";
      data: DocGenerationEventSeq & {
        blockId: string;
        index: number;
        blockType: AiBlock["type"];
      };
    }
  | {
      kind: "inline_appended";
      data: DocGenerationEventSeq & {
        blockId: string;
        index: number;
        appendOffset: number;
        run: AiRun;
      };
    }
  | {
      kind: "block_finished";
      data: DocGenerationEventSeq & {
        blockId: string;
        index: number;
        block: AiBlock;
        pmNode: PmBlockNode;
        hash: string;
      };
    }
  | {
      /**
       * writeDraft 胜出候选与后续 editDraft 的完整非 canonical 投影。
       * 客户端可立即展示，但不得据此推进 canonical version。
       */
      kind: "candidate_snapshot";
      data: DocGenerationEventSeq & {
        doc: PmDoc;
        baseVersion: number;
        contentHash: string;
      };
    }
  | {
      kind: "generation_finished";
      data: DocGenerationEventSeq & {
        doc: PmDoc;
        finalVersion: number;
        contentHash: string;
      };
    }
  | {
      kind: "generation_failed";
      data: DocGenerationEventSeq & {
        reason: string;
      };
    };

export type DocGenerationEventSeq = {
  generationId: string;
  seq: number;
  prevSeq: number | null;
};

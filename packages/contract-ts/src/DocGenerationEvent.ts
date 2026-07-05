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

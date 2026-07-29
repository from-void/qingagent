import type { BridgeFrame } from "@qingagent/contract-ts";
import { Buffer } from "node:buffer";

export interface TerminalDocumentFrameFields {
  frameSeq: number;
  generationId: string;
  streamId: string | null;
  documentVersion: number;
  contentHash: string;
  frameBytes: number;
}

export function terminalDocumentFrameFields(
  frame: BridgeFrame,
  frameSeq: number,
): TerminalDocumentFrameFields | null {
  const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  if (
    frame.kind === "docGenerationEvent" &&
    frame.data.kind === "generation_finished"
  ) {
    return {
      frameSeq,
      generationId: frame.data.data.generationId,
      streamId: null,
      documentVersion: frame.data.data.finalVersion,
      contentHash: frame.data.data.contentHash,
      frameBytes,
    };
  }
  if (
    frame.kind === "stream" &&
    frame.data.kind === "end" &&
    frame.data.data.finalDocument
  ) {
    return {
      frameSeq,
      generationId: `terminal-${frame.data.data.streamId}`,
      streamId: frame.data.data.streamId,
      documentVersion: frame.data.data.finalDocument.version,
      contentHash: frame.data.data.finalDocument.contentHash,
      frameBytes,
    };
  }
  return null;
}

/** 完整 PM 快照没有 512 KiB 的业务上限，只绕过单帧字节门，不绕过帧数门。 */
export function allowOversizedSseFrame(frame: BridgeFrame): boolean {
  return (
    frame.kind === "documentSnapshotWritten" ||
    (
      frame.kind === "docGenerationEvent" &&
      frame.data.kind === "generation_finished"
    ) ||
    (
      frame.kind === "stream" &&
      frame.data.kind === "end" &&
      frame.data.data.finalDocument !== undefined
    )
  );
}

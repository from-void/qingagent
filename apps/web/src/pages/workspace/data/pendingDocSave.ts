import type { BridgeFrame } from "@qingagent/contract-ts";

type DocWriteResultData = Extract<BridgeFrame, { kind: "docWriteResult" }>["data"];

export interface PendingDocSaveWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PendingDocSaveError extends Error {
  constructor(
    message: string,
    readonly result?: DocWriteResultData,
  ) {
    super(message);
    this.name = "PendingDocSaveError";
  }
}

export function docWriteResultMessage(result: DocWriteResultData): string {
  if (result.ok) return "";
  if ("conflict" in result) {
    return "文档已被更新，请刷新后继续编辑。";
  }
  switch (result.reason) {
    case "agent_busy":
      return "正在写入内容，刚才的手动编辑未保存。";
    case "not_editable":
      return "当前文档状态不可编辑，刚才的手动编辑未保存。";
    case "validation_error":
      return "保存失败，请检查文档内容后重试。";
    case "not_found":
      return "文档不存在，请刷新后重试。";
  }
}

export function docSaveFailureToastMessage(error: unknown): string {
  if (error instanceof PendingDocSaveError) return error.message;
  const detail = error instanceof Error ? error.message : String(error || "");
  return detail ? `文档保存失败 · ${detail}` : "文档保存失败 · 请重试";
}

export function reviewCommitFramesLeavePendingReview(frames: BridgeFrame[]): boolean {
  return frames.some((frame) => {
    if (frame.kind === "documentSnapshotWritten" || frame.kind === "docCommitted") {
      return true;
    }
    return frame.kind === "docStateChanged" && frame.data.state.kind !== "pendingReview";
  });
}

export async function runAfterPendingDocSave<T>(input: {
  flushPendingDocSave: () => Promise<void>;
  run: () => Promise<T>;
  onFlushFailure?: (error: unknown) => void;
}): Promise<T> {
  try {
    await input.flushPendingDocSave();
  } catch (error) {
    input.onFlushFailure?.(error);
    throw error;
  }
  return input.run();
}

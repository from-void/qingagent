export interface RetainedOutputState {
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutDroppedBytes?: number;
  stderrDroppedBytes?: number;
}

function droppedBytesLabel(value: number | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? `${value} bytes`
    : "unknown bytes";
}

export function formatRetainedOutputNotice(state: RetainedOutputState): string {
  const dropped: string[] = [];
  if (state.stdoutTruncated) {
    dropped.push(`stdout: ${droppedBytesLabel(state.stdoutDroppedBytes)}`);
  }
  if (state.stderrTruncated) {
    dropped.push(`stderr: ${droppedBytesLabel(state.stderrDroppedBytes)}`);
  }
  if (dropped.length === 0) return "";
  return `[Earlier process output was permanently dropped by the retention limit (${
    dropped.join("; ")
  }). The output above is incomplete; do not rerun the command to recover it because the command may have side effects.]`;
}

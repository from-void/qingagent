import type { ToolCallSpec } from "@qingagent/contract-ts";

export function isPersistentBackgroundCommand(spec: ToolCallSpec): boolean {
  return (
    spec.body.kind === "commandCard" &&
    spec.body.data.background === true &&
    typeof spec.body.data.pid === "string" &&
    spec.body.data.pid.length > 0 &&
    spec.body.data.ownerToolCallId === spec.id &&
    spec.body.data.terminalKind === undefined &&
    (spec.status.kind === "pending" || spec.status.kind === "running")
  );
}

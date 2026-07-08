export interface ExternalPropose {
  sessionId: string;
  expectedDocVersion: number;
  clientMutationId?: string;
  ops: ExternalProposeOp[];
}

export type ExternalProposeOp =
  | { kind: "fullDraft"; markdown: string }
  | { kind: "strReplace"; old: string; new: string; nth?: number }
  | { kind: "insertAfterLine"; line: number; markdown: string }
  | { kind: "appendSection"; markdown: string };

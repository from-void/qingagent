export const DRAFT_MUTATION_CONFLICT_ERROR =
  "候选已变化，请基于最新草稿重试";

export class DraftMutationConflictError extends Error {
  constructor() {
    super(DRAFT_MUTATION_CONFLICT_ERROR);
    this.name = "DraftMutationConflictError";
  }
}

export interface DraftMutationState {
  _draftMutationRevision: number;
}

export function currentDraftMutationRevision(
  state: DraftMutationState,
): number {
  return Number.isSafeInteger(state._draftMutationRevision)
    ? state._draftMutationRevision
    : 0;
}

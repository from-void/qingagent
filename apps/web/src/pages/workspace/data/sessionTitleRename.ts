export function isCurrentSessionTitleRename(input: {
  currentGeneration: number | undefined;
  currentSessionId: string | null;
  currentTitle: string;
  requestGeneration: number;
  requestSessionId: string;
  requestTitle: string;
}): boolean {
  return (
    input.currentSessionId === input.requestSessionId &&
    input.currentGeneration === input.requestGeneration &&
    input.currentTitle === input.requestTitle
  );
}

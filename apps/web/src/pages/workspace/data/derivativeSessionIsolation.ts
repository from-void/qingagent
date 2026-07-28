export function isCurrentDerivativePrefetch(input: {
  currentRequestId: number;
  currentSessionId: string | null;
  documentDocId: string | null | undefined;
  requestDocId: string;
  requestId: number;
  requestSessionId: string;
}): boolean {
  return (
    input.currentRequestId === input.requestId &&
    input.currentSessionId === input.requestSessionId &&
    input.documentDocId === input.requestDocId
  );
}

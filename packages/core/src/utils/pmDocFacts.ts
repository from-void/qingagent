type CanonicalDocState = {
  doc?: { content: readonly unknown[]; [key: string]: unknown };
};

export function hasCanonicalDoc(state: CanonicalDocState): boolean {
  return (state.doc?.content.length ?? 0) > 0;
}

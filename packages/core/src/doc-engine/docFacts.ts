type CanonicalDocState = {
  doc?: { content: readonly unknown[]; [key: string]: unknown };
};
type SuggestionState = { suggestions: { size: number } };

export function hasCanonicalDoc(state: CanonicalDocState): boolean {
  return (state.doc?.content.length ?? 0) > 0;
}

export function hasApplicableSuggestion(state: SuggestionState): boolean {
  return state.suggestions.size > 0;
}

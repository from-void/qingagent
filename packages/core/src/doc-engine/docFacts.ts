type SuggestionState = { suggestions: { size: number } };

export { hasCanonicalDoc } from "../utils/pmDocFacts.js";

export function hasApplicableSuggestion(state: SuggestionState): boolean {
  return state.suggestions.size > 0;
}

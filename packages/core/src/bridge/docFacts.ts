import type { SessionState } from "./sessionState.js";

type CanonicalDocState = Pick<SessionState, "doc">;
type SuggestionState = Pick<SessionState, "suggestions">;

export function hasCanonicalDoc(state: CanonicalDocState): boolean {
  return (state.doc?.content.length ?? 0) > 0;
}

export function hasApplicableSuggestion(state: SuggestionState): boolean {
  return state.suggestions.size > 0;
}

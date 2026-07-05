import type { DocSuggestion } from "./DocSuggestion";

export type DocSuggestionBody =
  | { "kind": "suggestion", "data": DocSuggestion }


/**
 * The 10 resource domains. Wire-side enforcement of Principle A:
 * every cross-turn-referenceable artifact carries a `ResourceRef`
 * with one of these domains.
 */
export type ResourceDomain = { "kind": "file" } | { "kind": "image" } | { "kind": "url" } | { "kind": "source" } | { "kind": "docSpan" } | { "kind": "docPosition" } | { "kind": "version" } | { "kind": "mention" } | { "kind": "citation" } | { "kind": "webpage" };

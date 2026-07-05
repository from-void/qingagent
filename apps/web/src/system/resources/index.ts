// Public API for the workspace's resource registry (Principle A).
//
// The registry is a projection of wire frames — `resourceUpserted`
// and `resourceUpdated` are the only mutators called from the reducer.
// UI consumers read via `useResource` / `useResourceList` hooks.

export { resources } from "./registry";
export { useResource, useResourceList } from "./hooks";

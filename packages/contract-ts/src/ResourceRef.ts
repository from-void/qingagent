import type { ResourceDomain } from "./ResourceDomain";

/**
 * Universal reference primitive (Principle A). Every UI placeholder
 * chip and every cross-turn reference goes through this.
 */
export type ResourceRef = { id: string, domain: ResourceDomain, };

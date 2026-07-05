import type { ResourceRef } from "./ResourceRef";

export type Citation = { 
/**
 * Reference to the cited resource. Domain MUST be Source or Webpage.
 */
sourceRef: ResourceRef, anchor: string, };

import type { Hunk } from "./Hunk";
import type { ResourceRef } from "./ResourceRef";

export type CodePatch = { 
/**
 * Domain MUST be File.
 */
targetFile: ResourceRef, 
/**
 * Domain MUST be Version.
 */
baseVersion: ResourceRef, hunks: Array<Hunk>, summary: string, };

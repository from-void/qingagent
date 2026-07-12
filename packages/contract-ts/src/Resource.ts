import type { ResourceRef } from "./ResourceRef";

export type Resource = { resourceRef: ResourceRef, displayName: string, 
/**
 * Pre-extracted; agent reads this on subsequent turns.
 */
summary: string, mime: string | null, 
/**
 * Wire 侧语义为 `u64`，TypeScript 侧统一用 `number` 承载。
 */
byteLen: number | null, createdAt: string, 
/**
 * Domain-specific metadata. High-value domains can promote to
 * typed variants in a follow-up capsule.
 */
metadata: unknown, };

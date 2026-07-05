import type { ResourceRef } from "./ResourceRef";

export type Resource = { resourceRef: ResourceRef, displayName: string, 
/**
 * Pre-extracted; agent reads this on subsequent turns.
 */
summary: string, mime: string | null, 
/**
 * `u64` on the wire. ts-rs would default-map to `bigint`, but
 * serde_json emits a plain number. Override the TS type so the
 * generated contract matches the actual JSON.
 */
byteLen: number | null, createdAt: string, 
/**
 * Domain-specific metadata. High-value domains can promote to
 * typed variants in a follow-up capsule.
 */
metadata: unknown, };

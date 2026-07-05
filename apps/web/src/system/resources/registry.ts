// In-memory resource registry. Mutates only via wire frames
// (resourceUpserted / resourceUpdated) — no local mutations bypass the
// wire. The reducer wires the frames into upsert / applyUpdate.

import type {
  Resource,
  ResourceDomain,
  ResourceRef,
} from "@qingagent/contract-ts";

export type ResourceListener = (refs: ResourceRef[]) => void;

/** Composite key combining domain + id so `file:x` and `image:x`
 * cannot collide. The id alone is opaque, not globally unique. */
function compositeKey(ref: ResourceRef): string {
  return `${ref.domain.kind}:${ref.id}`;
}

class InMemoryResourceStore {
  private byKey = new Map<string, Resource>();
  private listeners = new Set<ResourceListener>();

  list(domain?: ResourceDomain): Resource[] {
    const all = Array.from(this.byKey.values());
    if (!domain) return all;
    return all.filter((r) => sameDomain(r.resourceRef.domain, domain));
  }

  get(ref: ResourceRef): Resource | null {
    return this.byKey.get(compositeKey(ref)) ?? null;
  }

  summary(ref: ResourceRef): string | null {
    return this.byKey.get(compositeKey(ref))?.summary ?? null;
  }

  upsert(resource: Resource): void {
    this.byKey.set(compositeKey(resource.resourceRef), resource);
    this.emit();
  }

  applyUpdate(
    ref: ResourceRef,
    summary?: string | null,
    metadata?: unknown,
  ): void {
    const k = compositeKey(ref);
    const existing = this.byKey.get(k);
    if (!existing) return;
    const next: Resource = {
      ...existing,
      summary: summary === undefined ? existing.summary : summary ?? "",
      metadata: metadata === undefined ? existing.metadata : metadata,
    };
    this.byKey.set(k, next);
    this.emit();
  }

  remove(ref: ResourceRef): void {
    if (this.byKey.delete(compositeKey(ref))) this.emit();
  }

  // For tests / mock fixtures only.
  reset(): void {
    this.byKey.clear();
    this.emit();
  }

  subscribe(listener: ResourceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    // Keep mutations synchronous, but notify after the current React render/reducer stack.
    const notify = () => {
      const refs = Array.from(this.byKey.values()).map((r) => r.resourceRef);
      for (const l of this.listeners) l(refs);
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(notify);
      return;
    }
    void Promise.resolve().then(notify);
  }
}

function sameDomain(a: ResourceDomain, b: ResourceDomain): boolean {
  return a.kind === b.kind;
}

export const resources = new InMemoryResourceStore();

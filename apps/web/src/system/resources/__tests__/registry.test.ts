import { afterEach, describe, expect, it } from "vitest";
import type { Resource } from "@qingagent/contract-ts";
import { resources } from "../registry";

function fileResource(id: string, summary: string): Resource {
  return {
    resourceRef: { id, domain: { kind: "file" } },
    displayName: id,
    summary,
    mime: null,
    byteLen: null,
    createdAt: "2026-05-08T00:00:00Z",
    metadata: null,
  };
}

describe("resources registry", () => {
  afterEach(() => resources.reset());

  it("upsert + get + summary round-trip", () => {
    const r = fileResource("f-1", "twelve pages");
    resources.upsert(r);
    expect(resources.get({ id: "f-1", domain: { kind: "file" } })).toEqual(r);
    expect(resources.summary({ id: "f-1", domain: { kind: "file" } })).toBe(
      "twelve pages",
    );
  });

  it("applyUpdate merges summary + metadata", () => {
    resources.upsert(fileResource("f-1", "old summary"));
    resources.applyUpdate(
      { id: "f-1", domain: { kind: "file" } },
      "new summary",
      { pages: 3 },
    );
    const r = resources.get({ id: "f-1", domain: { kind: "file" } });
    expect(r?.summary).toBe("new summary");
    expect(r?.metadata).toEqual({ pages: 3 });
  });

  it("applyUpdate is no-op for unknown ref", () => {
    resources.applyUpdate(
      { id: "missing", domain: { kind: "file" } },
      "anything",
    );
    expect(resources.get({ id: "missing", domain: { kind: "file" } })).toBeNull();
  });

  it("list filters by domain", () => {
    resources.upsert(fileResource("f-1", "a"));
    resources.upsert({
      resourceRef: { id: "img-1", domain: { kind: "image" } },
      displayName: "i",
      summary: "b",
      mime: "image/png",
      byteLen: null,
      createdAt: "2026-05-08T00:00:00Z",
      metadata: null,
    });
    expect(resources.list({ kind: "file" })).toHaveLength(1);
    expect(resources.list({ kind: "image" })).toHaveLength(1);
    expect(resources.list()).toHaveLength(2);
  });

  it("file:x and image:x are distinct (composite key)", () => {
    resources.upsert(fileResource("x", "file-x"));
    resources.upsert({
      resourceRef: { id: "x", domain: { kind: "image" } },
      displayName: "image-x",
      summary: "image-x summary",
      mime: null,
      byteLen: null,
      createdAt: "2026-05-08T00:00:00Z",
      metadata: null,
    });
    expect(resources.summary({ id: "x", domain: { kind: "file" } })).toBe(
      "file-x",
    );
    expect(resources.summary({ id: "x", domain: { kind: "image" } })).toBe(
      "image-x summary",
    );
  });

  it("subscribe fires on upsert / update / remove", async () => {
    let calls = 0;
    const unsub = resources.subscribe(() => (calls += 1));
    resources.upsert(fileResource("f-1", "a"));
    resources.applyUpdate({ id: "f-1", domain: { kind: "file" } }, "b");
    resources.remove({ id: "f-1", domain: { kind: "file" } });
    await Promise.resolve();
    expect(calls).toBe(3);
    unsub();
  });
});

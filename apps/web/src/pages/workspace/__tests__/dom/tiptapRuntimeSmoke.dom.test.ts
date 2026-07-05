import { describe, expect, it } from "vitest";

describe("tiptapRuntimeSmoke", () => {
  it("runs in jsdom rather than the node vitest channel", () => {
    expect(window.document.createElement("article")).toBeInstanceOf(HTMLElement);
  });
});

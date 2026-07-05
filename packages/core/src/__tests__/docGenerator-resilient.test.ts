import { describe, it, expect } from "vitest";
import { parseLegacySections, normalizeLegacySection } from "../bridge/docGenerator.js";

describe("resilient doc generation parsing", () => {
  it("drops malformed or empty sections while keeping useful sections", () => {
    const raw = JSON.stringify([
      { kind: "h1", data: { text: "标题" } },
      { kind: "h2", data: { text: "小标题", anchor: null } },
      { kind: "p", data: { text: "有效正文。" } },
      { kind: "table", data: { rows: [["a", "b"]] } },
      { kind: "code", data: {} },
      { kind: "p", data: { text: "   " } },
    ]);

    expect(parseLegacySections(raw)).toEqual([
      { kind: "h1", data: { text: "标题" } },
      { kind: "h2", data: { text: "小标题", anchor: null } },
      { kind: "p", data: { text: "有效正文。" } },
    ]);
  });

  it("passes fully valid sections through unchanged", () => {
    const sections = [
      { kind: "h1", data: { text: "标题" } },
      { kind: "p", data: { text: "有效正文。" } },
      { kind: "table", data: { head: ["A", "B"], rows: [["1", "2"]] } },
      { kind: "code", data: { body: "const ok = true;" } },
    ];

    expect(parseLegacySections(JSON.stringify(sections))).toEqual(sections);
  });

  it("sanitizes Markdown markers after parsing generated prose", () => {
    const raw = JSON.stringify([
      { kind: "p", data: { text: "## 标题\n- **要点**" } },
      { kind: "code", data: { body: "## keep\nconst value = '**x**';" } },
    ]);

    expect(parseLegacySections(raw)).toEqual([
      { kind: "p", data: { text: "标题\n· 要点" } },
      { kind: "code", data: { body: "## keep\nconst value = '**x**';" } },
    ]);
  });

  it("normalizes complete sections with final parse drop semantics", () => {
    expect(normalizeLegacySection({ kind: "code", data: {} })).toBeNull();
    expect(normalizeLegacySection({ kind: "table", data: { rows: [["x"]] } })).toBeNull();
    expect(normalizeLegacySection({ kind: "p", data: { text: "" } })).toBeNull();
    expect(normalizeLegacySection({ kind: "p", data: { text: "hello" } })).toEqual({
      kind: "p",
      data: { text: "hello" },
    });
  });

  it("throws when no usable sections remain", () => {
    expect(() => parseLegacySections("[]")).toThrow("no usable doc sections");
    expect(() =>
      parseLegacySections(JSON.stringify([
        { kind: "code", data: {} },
        { kind: "p", data: { text: "" } },
      ])),
    ).toThrow("no usable doc sections");
  });

  it("unwraps the legacy { sections: [...] } wrapper and still drops bad sections", () => {
    const raw = JSON.stringify({
      sections: [
        { kind: "h1", data: { text: "标题" } },
        { kind: "code", data: {} }, // body-less code -> dropped
        { kind: "p", data: { text: "有效正文。" } },
      ],
    });

    expect(parseLegacySections(raw)).toEqual([
      { kind: "h1", data: { text: "标题" } },
      { kind: "p", data: { text: "有效正文。" } },
    ]);
  });

  it("still throws on genuinely invalid JSON (a real failure, not a single bad section)", () => {
    expect(() => parseLegacySections("this is not json at all")).toThrow();
    expect(() => parseLegacySections('[{"kind":"p","data":{"text":"x"')).toThrow();
  });
});

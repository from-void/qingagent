import { describe, expect, it } from "vitest";
import {
  getPmContentHash,
  getStablePmJson,
} from "../hash";

describe("稳定 PM JSON", () => {
  it("省略对象中的 undefined 并始终产出合法 JSON", () => {
    const value = {
      overlay: {
        positions: { App: { x: 10, y: 20 } },
        styles: undefined,
        edgeStyles: undefined,
        edgeHandles: undefined,
      },
    };

    const serialized = getStablePmJson(value);

    expect(serialized).not.toContain("undefined");
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toStrictEqual({
      overlay: { positions: { App: { x: 10, y: 20 } } },
    });
  });

  it("数组中的 undefined 按标准 JSON 语义写为 null", () => {
    const sparse = ["before", undefined, "after"];
    sparse.length = 4;
    const serialized = getStablePmJson(sparse);

    expect(serialized).toBe('["before",null,"after",null]');
    expect(JSON.parse(serialized)).toEqual(["before", null, "after", null]);
  });

  it("既有合法 PM 的稳定 JSON 与 content_hash 金丝雀不漂移", () => {
    const value = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p-hash" },
        content: [{ type: "text", text: "既有合法正文" }],
      }],
    };

    expect(getStablePmJson(value)).toBe(
      '{"attrs":{"schemaVersion":1},"content":[{"attrs":{"blockId":"p-hash"},"content":[{"text":"既有合法正文","type":"text"}],"type":"paragraph"}],"type":"doc"}',
    );
    expect(getPmContentHash(value)).toBe(
      "pmv1-389bfaaa3fb06646ea39d064f7667bfa",
    );
  });

});

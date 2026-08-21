import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COMMANDS_MODEL_OVERRIDE_HEADERS } from "../lib/commandRequestHeaders";

function extractModelOverrideHeaderReads(source: string): Set<string> {
  return new Set([...source.matchAll(
    /(?:c\.req\.header\(\s*|headers\[\s*)["'](x-(?:model|vision)-[^"']+)["']/g,
  )].map((match) => match[1]!));
}

describe("commands 敏感模型头审计清单", () => {
  it("与 stream/askMore 源码实际读取的 x-model/x-vision 头逐项一致", async () => {
    const [streamSource, askMoreSource] = await Promise.all([
      readFile(new URL("../routes/stream.ts", import.meta.url), "utf8"),
      readFile(new URL("../routes/askMore.ts", import.meta.url), "utf8"),
    ]);
    const audited = new Set(COMMANDS_MODEL_OVERRIDE_HEADERS);
    expect(extractModelOverrideHeaderReads(streamSource)).toEqual(audited);
    expect(extractModelOverrideHeaderReads(askMoreSource)).toEqual(audited);
    expect(COMMANDS_MODEL_OVERRIDE_HEADERS).toEqual([
      "x-model-provider",
      "x-model-key",
      "x-model-base-url",
      "x-model-flash",
      "x-model-pro",
      "x-model-tier",
      "x-model-protocol",
      "x-vision-source",
      "x-vision-key",
      "x-vision-base-url",
      "x-vision-model",
      "x-vision-protocol",
    ]);
    expect(new Set(COMMANDS_MODEL_OVERRIDE_HEADERS).size).toBe(COMMANDS_MODEL_OVERRIDE_HEADERS.length);
    expect(COMMANDS_MODEL_OVERRIDE_HEADERS.every((name) =>
      name.startsWith("x-model-") || name.startsWith("x-vision-"))).toBe(true);
  });
});

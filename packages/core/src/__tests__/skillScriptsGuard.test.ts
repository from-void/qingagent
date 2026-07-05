import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

describe("skill script CI guard", () => {
  it("拒绝 Python 脚本和未打包第三方依赖", async () => {
    const guard = await import(new URL("../../../../scripts/check-skill-scripts.mjs", import.meta.url).href) as {
      checkSkillScripts: (repoRoot?: string) => string[];
    };
    expect(guard.checkSkillScripts(repoRoot)).toEqual([]);
  });
});

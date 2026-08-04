import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerEnv } from "../evals/liveRunner.js";

const tempDirs: string[] = [];

describe("liveRunner 服务端 .env 加载", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("复用 dotenv 的行尾注释与引号语义，且不覆盖已有环境变量", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qingagent-live-env-"));
    tempDirs.push(dir);
    const envPath = join(dir, ".env");
    await writeFile(envPath, [
      "PLAIN=value # comment",
      'QUOTED="value # kept"',
      "EXISTING=from-file",
    ].join("\n"));
    const target: NodeJS.ProcessEnv = { EXISTING: "from-process" };

    loadServerEnv(envPath, target);

    expect(target).toMatchObject({
      PLAIN: "value",
      QUOTED: "value # kept",
      EXISTING: "from-process",
    });
  });
});

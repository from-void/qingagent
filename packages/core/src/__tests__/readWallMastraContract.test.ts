import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mastraRoot = resolve(fileURLToPath(new URL("../../node_modules/@mastra/core", import.meta.url)));

async function nativeSandboxSource(): Promise<string> {
  const dist = join(mastraRoot, "dist");
  const chunks = (await readdir(dist)).filter((name) => name.startsWith("chunk-") && name.endsWith(".js"));
  for (const chunk of chunks) {
    const source = await readFile(join(dist, chunk), "utf8");
    if (source.includes("function buildBwrapCommand") && source.includes("function generateSeatbeltProfile")) {
      return source;
    }
  }
  throw new Error("Mastra native sandbox source layout changed; security re-audit required");
}

describe("Mastra native sandbox 升级契约锁", () => {
  it("锁定已审计的 @mastra/core 1.49.0", async () => {
    const packageJson = JSON.parse(await readFile(join(mastraRoot, "package.json"), "utf8")) as { version?: string };
    expect(packageJson.version).toBe("1.49.0");
  });

  it("bwrapArgs 仍是全量替换，Mastra 仍负责追加 -- sh -c command", async () => {
    const source = await nativeSandboxSource();
    expect(source).toContain("if (config.bwrapArgs && config.bwrapArgs.length > 0)");
    expect(source).toContain('args: [...config.bwrapArgs, "--", "sh", "-c", command]');
  });

  it("自定义 Seatbelt 路径缺失仍会生成默认 profile，因此 qingagent 必须先验 hash", async () => {
    const source = await nativeSandboxSource();
    expect(source).toContain("this._seatbeltProfile = generateSeatbeltProfile(this.workingDirectory, this._nativeSandboxConfig)");
    expect(source).toContain("await fs.writeFile(userProvidedPath, this._seatbeltProfile, \"utf-8\")");
    expect(source).toContain('lines.push("(allow file-read*)")');
  });

  it("LocalSandbox.mount 仍会重建默认 Seatbelt profile，禁止动态 mount 的锁不可删除", async () => {
    const source = await nativeSandboxSource();
    const mountSection = source.slice(source.indexOf("async mount(filesystem, mountPath)"));
    expect(mountSection).toContain("addMountPathToIsolation(mountPath, hostPath)");
    expect(mountSection).toContain("this._seatbeltProfile = generateSeatbeltProfile(this.workingDirectory, this._nativeSandboxConfig)");
  });
});

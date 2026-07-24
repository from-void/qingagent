import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("draw.io 自托管静态资产", () => {
  it("通过体积、locale、必要文件、CSP 与外联检查", () => {
    const output = execFileSync(process.execPath, ["scripts/check-drawio-vendor.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toMatch(/draw\.io vendor 检查通过：\d+ files，\d+ bytes/);
  });

  it("桌面端打包继续携带完整 Web dist", () => {
    const builderConfig = readFileSync(
      path.resolve(process.cwd(), "../desktop/electron-builder.yml"),
      "utf8",
    );
    expect(builderConfig).toMatch(/extraResources:[\s\S]*from:\s+\.\.\/web\/dist[\s\S]*to:\s+web/);
  });
});

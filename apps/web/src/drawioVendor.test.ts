import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("draw.io 自托管静态资产", () => {
  it("pnpm test 与生产构建前置执行 vendor 守卫", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.pretest).toBe("pnpm check:drawio-vendor");
    expect(packageJson.scripts?.prebuild).toBe("pnpm check:drawio-vendor");
  });

  it("发布构建在 CSP 被移除时 fail-closed", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const sourceVendorRoot = path.resolve(process.cwd(), "public/drawio");
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "qingagent-drawio-vendor-"));
    const fixtureVendorRoot = path.join(fixtureRoot, "drawio");

    try {
      cpSync(sourceVendorRoot, fixtureVendorRoot, { recursive: true });
      const indexPath = path.join(fixtureVendorRoot, "index.html");
      const indexHtml = readFileSync(indexPath, "utf8");
      const withoutConnectSelf = indexHtml.replace("connect-src 'self';", "");
      expect(withoutConnectSelf).not.toBe(indexHtml);
      writeFileSync(indexPath, withoutConnectSelf);

      const result = spawnSync("pnpm", ["build:desktop"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          VITEST: "true",
          QINGAGENT_DRAWIO_VENDOR_ROOT_TEST: fixtureVendorRoot,
          QINGAGENT_BUNDLE_PYODIDE: "0",
          QINGAGENT_BUNDLE_LARK_CLI: "0",
        },
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      expect(result.error).toBeUndefined();
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("index CSP 缺少：connect-src 'self'");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 130_000);

  it("桌面端打包继续携带完整 Web dist", () => {
    const builderConfig = readFileSync(
      path.resolve(process.cwd(), "../desktop/electron-builder.yml"),
      "utf8",
    );
    expect(builderConfig).toMatch(/extraResources:[\s\S]*from:\s+\.\.\/web\/dist[\s\S]*to:\s+web/);
  });

  it("固定 v31 原生 snapshot/export 握手与 offline 按钮行为", () => {
    const app = readFileSync(
      path.resolve(process.cwd(), "public/drawio/js/app.min.js"),
      "utf8",
    );
    expect(app).toContain('if("snapshot"==D.action){this.sendEmbeddedSvgExport(!0);');
    expect(app).toContain('if("export"==D.action){if("png"==D.format||"xmlpng"==D.format)');
    expect(app).toMatch(
      /\{event:"export",\s*point:this\.embedExitPoint,exit:null!=c\?!c:!0,data:Editor\.createSvgDataUri\(r\)\}/,
    );
    expect(app).toContain('"1"!=urlParams.keepmodified');
    expect(app).toContain(
      'this.isStandaloneApp()||"simple"==Editor.currentTheme&&"1"!=urlParams.embed)this.buttonContainer.style.display="none"',
    );
  });
});

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

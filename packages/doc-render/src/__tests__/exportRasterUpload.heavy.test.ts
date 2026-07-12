import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { LegacySection } from "@qingagent/contract-ts";
import { toDocx } from "../export/toDocx.js";
import { toHtml } from "../export/toHtml.js";
import { toPdf } from "../export/toPdf.js";
import { hasChromium } from "./browserTestGate.js";

// round-3 回归:本地上传的栅格图(png/jpeg)导出时必须按图片内嵌,
// 不能被当成 svg 文本读出乱码(toPdf 曾崩/乱、toDocx 曾丢成 [图])。

// 合法 1x1 透明 PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const ID = "12345678-1234-1234-1234-1234567890ab";
const uploadsDir = resolve("./uploads", ID);

function imageDoc(src: string): LegacySection[] {
  return [
    { kind: "p", data: { text: "前言" } },
    { kind: "image", data: { src, alt: "图", caption: null, width: null, height: null } },
  ] as unknown as LegacySection[];
}

describe("本地栅格图上传导出", () => {
  beforeAll(() => {
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(resolve(uploadsDir, "pic.png"), PNG_1x1);
  });
  afterAll(() => {
    try { rmSync(resolve("./uploads", ID), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("docx:本地 png 内嵌(输出比缺图回退大)", async () => {
    const embedded = await toDocx(imageDoc(`/api/v1/files/${ID}/pic.png`), {});
    const fallback = await toDocx(imageDoc(`/api/v1/files/${ID}/missing.png`), {});
    expect(embedded).toBeInstanceOf(Buffer);
    expect(embedded.length).toBeGreaterThan(fallback.length);
  });

  it("html:本地 png 内嵌为 data URI,缺图回退占位文字", () => {
    const embedded = toHtml(imageDoc(`/api/v1/files/${ID}/pic.png`), {});
    expect(embedded).toContain("<img src=\"data:image/png;base64,");
    const fallback = toHtml(imageDoc(`/api/v1/files/${ID}/missing.png`), {});
    expect(fallback).not.toContain("data:image/png;base64,");
    expect(fallback).toContain("[图片：");
  });

  it.skipIf(!hasChromium)("pdf:本地 png 与缺图都能产出 PDF 不崩", async () => {
    await expect(toPdf(imageDoc(`/api/v1/files/${ID}/pic.png`), {})).resolves.toBeInstanceOf(Buffer);
    await expect(toPdf(imageDoc(`/api/v1/files/${ID}/missing.png`), {})).resolves.toBeInstanceOf(Buffer);
  });
});

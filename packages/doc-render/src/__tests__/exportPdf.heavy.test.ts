import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { chromium } from "playwright";
import {
  browserLaunchCandidates,
  resetBrowserCapabilityForTest,
} from "../browser/pool.js";
import { loadPdfParseConstructor } from "../browser/pdfParse.js";
import { toPdf } from "../export/toPdf.js";

const EXECUTABLE_ENV = "QINGAGENT_BROWSER_EXECUTABLE_PATH";
const previousExecutable = process.env[EXECUTABLE_ENV];
let pinnedExecutable = "";

beforeAll(async () => {
  pinnedExecutable = resolvePlaywrightChromiumExecutable();
  process.env[EXECUTABLE_ENV] = pinnedExecutable;
  await resetBrowserCapabilityForTest();
  expect(browserLaunchCandidates()[0]?.label).toBe(`executablePath=${pinnedExecutable}`);
});

afterAll(async () => {
  await resetBrowserCapabilityForTest();
  if (previousExecutable === undefined) delete process.env[EXECUTABLE_ENV];
  else process.env[EXECUTABLE_ENV] = previousExecutable;
});

describe("PDF 导出固定 Playwright Chromium", () => {
  it("ASCII 主用例的文字层与页数固定", async () => {
    const title = "Stable ASCII PDF";
    const paragraphs = Array.from(
      { length: 36 },
      (_, index) => `ASCII paragraph ${String(index + 1).padStart(2, "0")} stable export text.`,
    );
    const document = asciiDocument(title, paragraphs);

    const result = await parsePdf(await toPdf(document, { title }));

    expect(result.total).toBe(2);
    expect(normalizeExtractedText(result.text)).toBe([title, ...paragraphs].join(" "));
  });

  it("CJK 文字层冒烟，不绑定字体布局", async () => {
    const result = await parsePdf(await toPdf({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "cjk-title", level: 1 },
          content: [{ type: "text", text: "中文导出冒烟" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "cjk-body" },
          content: [{ type: "text", text: "青简保留中文文字层。" }],
        },
      ],
    }, { title: "中文导出冒烟" }));

    expect(result.text).toContain("中文导出冒烟");
    expect(result.text).toContain("青简保留中文文字层");
  });
});

function asciiDocument(title: string, paragraphs: readonly string[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "heading",
        attrs: { blockId: "ascii-title", level: 1 },
        content: [{ type: "text", text: title }],
      },
      ...paragraphs.map((text, index) => ({
        type: "paragraph" as const,
        attrs: { blockId: `ascii-${index + 1}` },
        content: [{ type: "text" as const, text }],
      })),
    ],
  };
}

async function parsePdf(pdf: Buffer): Promise<{ text: string; total: number }> {
  const PDFParse = await loadPdfParseConstructor();
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const result = await parser.getText();
    return { text: result.text, total: result.total };
  } finally {
    await parser.destroy();
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/-- \d+ of \d+ --/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePlaywrightChromiumExecutable(): string {
  const regular = chromium.executablePath();
  const revisionDir = dirname(dirname(regular));
  const revision = basename(revisionDir).replace(/^chromium-/, "");
  const cacheRoot = dirname(revisionDir);
  const headlessRoot = join(cacheRoot, `chromium_headless_shell-${revision}`);
  const candidates = [
    regular,
    join(headlessRoot, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(headlessRoot, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
    join(headlessRoot, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    join(headlessRoot, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      `缺少 Playwright Chromium：先运行 pnpm --filter @qingagent/doc-render exec playwright install chromium-headless-shell；探测路径=${candidates.join(",")}`,
    );
  }
  return executable;
}

import { describe, expect, it, vi, beforeEach } from "vitest";
import { hasVisibleSvgContent, sanitizeSvg } from "../browser/svgSanitize.js";
import { lintSvg } from "../browser/svgQualityLint.js";
import { SVG_TEMPLATES } from "../svgTemplates/index.js";
import { generateSvgTool } from "../tools/generateSvg.js";

const streamInnerModelMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/innerModelStream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/innerModelStream.js")>();
  return { ...actual, streamInnerModel: (...args: unknown[]) => streamInnerModelMock(...args) };
});

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

const size = { width: 800, height: 450 };

function assertCleanTemplate(id: keyof typeof SVG_TEMPLATES, params: Record<string, unknown>): string {
  const template = SVG_TEMPLATES[id];
  if (!template) throw new Error(`missing template ${String(id)}`);
  const parsed = template.paramsSchema.safeParse(params);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("params should parse");

  const svg = sanitizeSvg(template.render(parsed.data, size), size);
  expect(svg).toMatch(/^<svg\b/i);
  expect(hasVisibleSvgContent(svg)).toBe(true);
  expect(lintSvg(svg, size)).toEqual([]);
  return svg;
}

function zodText(id: keyof typeof SVG_TEMPLATES, params: Record<string, unknown>): string {
  const template = SVG_TEMPLATES[id];
  if (!template) throw new Error(`missing template ${String(id)}`);
  const parsed = template.paramsSchema.safeParse(params);
  expect(parsed.success).toBe(false);
  if (parsed.success) return "";
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

describe("svgTemplates", () => {
  beforeEach(() => {
    streamInnerModelMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockReset();
  });

  it("compare-card 典型参数产物可消毒、可见且 lint 零违规", () => {
    assertCleanTemplate("compare-card", {
      title: "方案对比",
      left: { title: "旧方案", items: ["人工整理", "反馈慢", "格式不稳定"] },
      right: { title: "新方案", items: ["模板秒出", "版式稳定", "可复用"] },
      accent: "warm",
    });
  });

  it("compare-card 越界参数被 zod 拒绝且错误文本含字段名", () => {
    const text = zodText("compare-card", {
      left: { title: "旧方案", items: ["一", "二", "三", "四", "五", "六", "七"] },
      right: { title: "新方案", items: ["一"] },
    });
    expect(text).toContain("left.items");
  });

  it("points-card 典型参数产物可消毒、可见且 lint 零违规", () => {
    assertCleanTemplate("points-card", {
      title: "执行要点",
      points: [
        { label: "先定位", desc: "用日志确认慢在哪一层" },
        { label: "再修复", desc: "只改真实瓶颈" },
        { label: "后验证", desc: "用测试封住回归" },
      ],
      accent: "cool",
    });
  });

  it("points-card 越界参数被 zod 拒绝且错误文本含字段名", () => {
    const text = zodText("points-card", {
      points: [
        { label: "一" },
        { label: "二" },
        { label: "三" },
        { label: "四" },
        { label: "五" },
        { label: "六" },
        { label: "七" },
      ],
    });
    expect(text).toContain("points");
  });

  it("bar-card 典型参数产物可消毒、可见且 lint 零违规", () => {
    assertCleanTemplate("bar-card", {
      title: "请求量",
      unit: "次",
      bars: [
        { label: "周一", value: 120 },
        { label: "周二", value: 240 },
        { label: "周三", value: 180 },
      ],
      accent: "mono",
    });
  });

  it("bar-card 越界参数被 zod 拒绝且错误文本含字段名", () => {
    const text = zodText("bar-card", {
      bars: [{ label: "超长字段名称超过十字了", value: 1 }],
    });
    expect(text).toContain("bars.0.label");
  });

  it("特殊字符文本会转义，sanitize 后保留文字且不出现裸 script 标签", () => {
    const svg = assertCleanTemplate("compare-card", {
      title: `安全 <script> "检查"`,
      left: { title: "A&B", items: [`<script>alert("x")</script>`, "Tom's item"] },
      right: { title: "C>D", items: ["正常文本"] },
      accent: "warm",
    });

    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("\"检查\"");
    expect(svg).not.toMatch(/<script\b/i);
  });

  it("generateSvg template 路径不调用 DeepSeek 且会落盘", async () => {
    const result = await generateSvgTool.execute!({
      template: "compare-card",
      params: {
        title: "方案对比",
        left: { title: "旧方案", items: ["慢", "不稳"] },
        right: { title: "新方案", items: ["快", "稳定"] },
        accent: "warm",
      },
      aspect: "16:9",
    } as never, undefined as never) as {
      ok: boolean;
      src: string;
      lintIssues: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.src).toMatch(/^\/api\/v1\/files\/.+\/illustration\.svg$/);
    expect(result.lintIssues).toEqual([]);
    expect(streamInnerModelMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAttachmentContext } from "../bridge/sessionTools.js";

// 回归(验收 Agent C 发现):上传附件指引原先对所有文件都说"用 parseFile",
// 图片走 parseFile 会失败。现按 mimeType 分派:图片→readImage(传 fileId),文档→parseFile。

const img = { fileId: "11111111-1111-4111-8111-111111111111", filename: "photo.png", filePath: "/uploads/11111111-1111-4111-8111-111111111111/photo.png", mimeType: "image/png" };
const doc = { fileId: "22222222-2222-4222-8222-222222222222", filename: "report.pdf", filePath: "/uploads/22222222-2222-4222-8222-222222222222/report.pdf", mimeType: "application/pdf" };

// 默认(无 QINGAGENT_RUNTIME)= web 部署。
describe("buildAttachmentContext 按类型分派", () => {
  const prevRuntime = process.env.QINGAGENT_RUNTIME;
  beforeEach(() => {
    delete process.env.QINGAGENT_RUNTIME; // web 模式
  });
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = prevRuntime;
  });

  it("纯图片 → 指引 readImage 且传 fileId(不是 filePath、不是 parseFile)", () => {
    const out = buildAttachmentContext([img]);
    expect(out).toContain("readImage");
    expect(out).toContain(img.fileId);
    expect(out).not.toContain("parseFile");
    // 明确不要让模型把 filePath 传给 readImage(resolver 不认绝对路径)
    expect(out).not.toMatch(/readImage\([^)]*filePath/);
  });

  // CC 脱敏:web 部署文档指引用 fileId,绝不暴露 server 绝对路径。
  it("纯文档(web) → 指引 parseFile 传 fileId、不暴露 filePath", () => {
    const out = buildAttachmentContext([doc]);
    expect(out).toContain("parseFile");
    expect(out).toContain(doc.fileId);
    expect(out).not.toContain(doc.filePath);
    expect(out).not.toContain("readImage");
  });

  it("图片+文档混合(web) → 两段指引都在,文档用 fileId 不暴露 filePath", () => {
    const out = buildAttachmentContext([img, doc]);
    expect(out).toContain("readImage");
    expect(out).toContain("parseFile");
    expect(out).toContain(img.fileId);
    expect(out).toContain(doc.fileId);
    expect(out).not.toContain(doc.filePath);
  });

  it("空数组 → 空串", () => {
    expect(buildAttachmentContext([])).toBe("");
  });

  it("ToolSearch 开启时文档提示先 search_tools 加载 parseFile", () => {
    const out = buildAttachmentContext([doc], { toolSearchEnabled: true });
    expect(out).toContain('search_tools({ query: "parseFile" })');
    expect(out).toContain("parseFile");
    expect(out).toContain(doc.fileId);
    expect(out).not.toContain(doc.filePath);
  });

  it("ToolSearch 开启时图片提示先 search_tools 加载 readImage", () => {
    const out = buildAttachmentContext([img], { toolSearchEnabled: true });
    expect(out).toContain('search_tools({ query: "readImage" })');
    expect(out).toContain("readImage");
    expect(out).toContain(img.fileId);
    expect(out).not.toContain("parseFile");
  });

  // 回归(round-1 发现):webp/gif 此前 MIME_MAP 缺失被当 octet-stream → 误路由到 parseFile。
  // 修复后扩展名映射成 image/webp、image/gif,这里锁定 image/* 一律走 readImage。
  it("webp/gif 图片 → 走 readImage(不走 parseFile)", () => {
    const webp = { fileId: "33333333-3333-4333-8333-333333333333", filename: "a.webp", filePath: "/uploads/x/a.webp", mimeType: "image/webp" };
    const gif = { fileId: "44444444-4444-4444-8444-444444444444", filename: "b.gif", filePath: "/uploads/y/b.gif", mimeType: "image/gif" };
    const out = buildAttachmentContext([webp, gif]);
    expect(out).toContain("readImage");
    expect(out).not.toContain("parseFile");
    expect(out).toContain(webp.fileId);
    expect(out).toContain(gif.fileId);
  });
});

// CC 脱敏:desktop(本机单机)保留原 filePath,方便本地工具直接读盘。
describe("buildAttachmentContext desktop 部署保留 filePath", () => {
  const prevRuntime = process.env.QINGAGENT_RUNTIME;
  beforeEach(() => {
    process.env.QINGAGENT_RUNTIME = "desktop";
  });
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = prevRuntime;
  });

  it("纯文档(desktop) → 指引 parseFile 传 filePath", () => {
    const out = buildAttachmentContext([doc]);
    expect(out).toContain("parseFile");
    expect(out).toContain(doc.filePath);
  });
});

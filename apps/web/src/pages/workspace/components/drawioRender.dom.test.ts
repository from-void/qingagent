import { describe, expect, it } from "vitest";
import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { renderDrawio } from "./drawioRender";

describe("drawio 离线渲染器", () => {
  it("fixture mxGraph XML 渲染为经加固的原生 SVG", async () => {
    const svg = await renderDrawio(DEFAULT_DRAWIO_SOURCE);

    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toMatch(/viewBox=/i);
    expect(svg).toMatch(/<(?:rect|path)\b/i);
    expect(svg).toContain("开始");
    expect(svg).toContain("结束");
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\son\w+=/i);
  });

  it("XML 中的链接和外部图片不会进入渲染 SVG", async () => {
    const source = DEFAULT_DRAWIO_SOURCE.replace(
      'id="start"',
      'id="start" link="javascript:alert(1)"',
    ).replace(
      "rounded=0;whiteSpace=wrap;",
      "rounded=0;image=https://evil.example/a.png;whiteSpace=wrap;",
    );
    const svg = await renderDrawio(source);

    expect(svg).not.toContain("javascript:");
    expect(svg).not.toContain("evil.example");
    expect(svg).not.toMatch(/foreignObject/i);
  });

  it("html=1 中文多行 label 转为原生文本，不渲染字面量 HTML 或可执行内容", async () => {
    const source = DEFAULT_DRAWIO_SOURCE.replace(
      'value="开始" style="rounded=0;whiteSpace=wrap;html=0;',
      'value="用户端&lt;div&gt;API服务&lt;/div&gt;&lt;div&gt;&lt;br&gt;&lt;/div&gt;&lt;img src=&quot;https://evil.example/a.png&quot;&gt;&lt;script&gt;globalThis.pwned=true&lt;/script&gt;" style="rounded=0;whiteSpace=wrap;html=1;',
    );
    const svg = await renderDrawio(source);

    expect(svg).toContain("用户端");
    expect(svg).toContain("API服务");
    expect(svg).not.toMatch(/&lt;\/?(?:div|br|img|script)\b|<\/?(?:div|br|img|script)\b/i);
    expect(svg).not.toContain("evil.example");
    expect(svg).not.toContain("globalThis.pwned");
    expect(svg).not.toMatch(/foreignObject/i);
  });

  it("未知 edgeStyle 表达式不会被执行", async () => {
    const runtime = globalThis as typeof globalThis & { __drawioEvalProbe?: boolean };
    delete runtime.__drawioEvalProbe;
    const source = DEFAULT_DRAWIO_SOURCE.replace(
      "edgeStyle=orthogonalEdgeStyle",
      "edgeStyle=(()=>{globalThis.__drawioEvalProbe=true})()",
    );

    await renderDrawio(source);

    expect(runtime.__drawioEvalProbe).toBeUndefined();
  });
});

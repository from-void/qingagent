import { describe, expect, it } from "vitest";
import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { renderDrawio } from "./drawioRender";

// 同步自线上 document_suggestions/diff-hunk-e15b1cdd0d280391 的完整 source；
// 保留真实三容器、子节点和跨容器连线，禁止用手造形状替代。
const REAL_PERCENT_ENCODED_COLOR_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="zone-wan" value="外网区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23EDF2F7;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-app" value="应用区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23D4E0ED;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="200" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-data" value="数据区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23E8EDF3;strokeColor=%235A7B9A;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="360" width="600" height="120" as="geometry"/></mxCell><mxCell id="client" value="客户端" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%234A6FA5;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-wan"><mxGeometry x="80" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="app-server" value="应用服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%235A7B9A;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-app"><mxGeometry x="220" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="db-server" value="数据库服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%238895A7;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-data"><mxGeometry x="360" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="edge-c2a" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="client" target="app-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell><mxCell id="edge-a2d" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="app-server" target="db-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell></root></mxGraphModel>';

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

  it("真实百分号颜色 payload 渲染出原配色 SVG，而不是纯黑砖块", async () => {
    const svg = await renderDrawio(REAL_PERCENT_ENCODED_COLOR_XML);
    const normalizedSvg = svg.toLowerCase();

    expect(normalizedSvg).toContain("#edf2f7");
    expect(normalizedSvg).toContain("#d4e0ed");
    expect(normalizedSvg).toContain("#e8edf3");
    expect(normalizedSvg).toContain("#4a6fa5");
    expect(normalizedSvg).toContain("#5a7b9a");
    expect(svg).toContain("外网区");
    expect(svg).toContain("应用区");
    expect(svg).toContain("数据区");
  });

  it("多页文档只渲染第一页", async () => {
    const secondPage = `<mxGraphModel><root><mxCell id="cp-0"/><mxCell id="cp-1" parent="cp-0"/><mxCell id="cp-2" value="第二页专属" style="rounded=0;whiteSpace=wrap;html=0;fillColor=#efe3cc;strokeColor=#b08a3e;fontColor=#2f2a22;" vertex="1" parent="cp-1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>`;
    const svg = await renderDrawio(
      `<mxfile pages="2"><diagram id="p1" name="第 1 页">${DEFAULT_DRAWIO_SOURCE}</diagram><diagram id="p2" name="第 1 页 的副本">${secondPage}</diagram></mxfile>`,
    );

    expect(svg).toContain("开始");
    expect(svg).toContain("结束");
    expect(svg).not.toContain("第二页专属");
  });
});

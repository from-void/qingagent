import { deflateSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAWIO_SOURCE,
  normalizeDrawioSource,
  prepareDrawioModelXmlForRender,
  readDrawioModel,
  validateDrawioSource,
} from "../drawio/drawioXml";
import { aiIrToPm } from "../ai-ir/aiIrToPm";
import { normalizePmDoc, safeParsePmDoc } from "../validators";

// 线上真实回归样本：packages/server/qingagent.db / document_suggestions /
// diff-hunk-e15b1cdd0d280391 / steps_json[0].slice.content[0].attrs.source。
// 禁止改写为手造简化图，否则无法覆盖这次三个容器同时变黑的真实故障形态。
const REAL_PERCENT_ENCODED_COLOR_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="zone-wan" value="外网区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23EDF2F7;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-app" value="应用区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23D4E0ED;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="200" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-data" value="数据区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23E8EDF3;strokeColor=%235A7B9A;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="360" width="600" height="120" as="geometry"/></mxCell><mxCell id="client" value="客户端" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%234A6FA5;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-wan"><mxGeometry x="80" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="app-server" value="应用服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%235A7B9A;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-app"><mxGeometry x="220" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="db-server" value="数据库服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%238895A7;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-data"><mxGeometry x="360" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="edge-c2a" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="client" target="app-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell><mxCell id="edge-a2d" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="app-server" target="db-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell></root></mxGraphModel>';

function compressDrawio(xml: string): string {
  const bytes = deflateSync(strToU8(encodeURIComponent(xml)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("drawio XML 明文归一化与安全边界", () => {
  it.each([
    ["截断 XML", '<mxGraphModel><root><mxCell id="0"'],
    ["缺少根图层的非法 XML", '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>'],
  ])("AI-IR diagram 的%s降级为源码代码块而不抛错", (_label, source) => {
    let doc: ReturnType<typeof aiIrToPm> | undefined;

    expect(() => {
      doc = aiIrToPm({
        blocks: [{ type: "diagram", lang: "drawio", source }],
      });
    }).not.toThrow();
    expect(doc?.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "drawio" },
      content: [{ type: "text", text: source }],
    });
  });

  it("AI-IR diagram 的合法 drawio 仍归一化为活图", () => {
    const doc = aiIrToPm({
      blocks: [{ type: "diagram", lang: "drawio", source: DEFAULT_DRAWIO_SOURCE }],
    });

    expect(doc.content[0]).toMatchObject({
      type: "diagram",
      attrs: {
        lang: "drawio",
        source: DEFAULT_DRAWIO_SOURCE,
        svg: null,
      },
    });
  });

  it("默认模板是合法、可读、含节点与边的未压缩 mxGraphModel", () => {
    const parsed = readDrawioModel(DEFAULT_DRAWIO_SOURCE);
    expect(parsed.source).toBe(DEFAULT_DRAWIO_SOURCE);
    expect(parsed.modelXml).toContain("<mxGraphModel");
    expect(parsed.modelXml).toContain('vertex="1"');
    expect(parsed.modelXml).toContain('edge="1"');
    expect(parsed.modelXml).toContain('relative="1"');
  });

  it("把纯 base64+deflate 与压缩 mxfile diagram 展开成明文 XML", () => {
    const compressed = compressDrawio(DEFAULT_DRAWIO_SOURCE);
    expect(normalizeDrawioSource(compressed)).toContain("<mxGraphModel");

    const mxfile = `<mxfile><diagram id="page-1">${compressed}</diagram></mxfile>`;
    const expanded = normalizeDrawioSource(mxfile);
    expect(expanded).toContain('compressed="false"');
    expect(expanded).toContain("<mxGraphModel");
    expect(expanded).not.toContain(compressed);

    const doc = normalizePmDoc({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: { blockId: "drawio-1", lang: "drawio", source: mxfile, svg: "<svg><script/></svg>" },
      }],
    });
    const block = doc.content[0];
    expect(block?.type).toBe("diagram");
    if (block?.type !== "diagram") return;
    expect(block.attrs.source).toContain("<mxGraphModel");
    expect(block.attrs.source).not.toContain(compressed);
    expect(block.attrs.svg).toMatch(/^<svg\b/);
    expect(block.attrs.svg).not.toContain("<script");
  });

  it("mxfile 已含明文模型时把错误的 compressed 声明修正为 false", () => {
    const source = `<mxfile compressed="true"><diagram id="page-1">${DEFAULT_DRAWIO_SOURCE}</diagram></mxfile>`;
    const normalized = normalizeDrawioSource(source);
    expect(normalized).toContain('compressed="false"');
    expect(normalized).toContain("<mxGraphModel");
  });

  it("拒绝实体声明、超深 XML 与缺失根图层的模型", () => {
    expect(validateDrawioSource(
      `<!DOCTYPE mxGraphModel [<!ENTITY bomb "x">]><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`,
    )).toMatchObject({ ok: false });

    const nested = `${"<group>".repeat(70)}${"</group>".repeat(70)}`;
    expect(validateDrawioSource(
      `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${nested}</root></mxGraphModel>`,
    )).toMatchObject({ ok: false });

    const invalid = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "drawio-1",
          lang: "drawio",
          source: "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>",
          svg: null,
        },
      }],
    };
    expect(safeParsePmDoc(invalid).success).toBe(false);
  });

  it("对截断、尾随散文与 markdown fence 失败，但不误伤含括号和转义引号的正文", () => {
    const valid = DEFAULT_DRAWIO_SOURCE.replace(
      'value="开始"',
      'value="正文含 ] } 与 &quot;引号&quot;"',
    );
    expect(validateDrawioSource(valid)).toMatchObject({ ok: true });
    expect(validateDrawioSource("<mxGraphModel><root><mxCell id=\"0\"")).toMatchObject({ ok: false });
    expect(validateDrawioSource(`${DEFAULT_DRAWIO_SOURCE}\n生成完毕。`)).toMatchObject({ ok: false });
    expect(validateDrawioSource(`\`\`\`xml\n${DEFAULT_DRAWIO_SOURCE}\n\`\`\``)).toMatchObject({ ok: false });
  });

  it("deflate bomb 在固定解压缓冲上限处失败，不把巨型结果送进 XML 解析器", () => {
    const oversized = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', `value="${"a".repeat(2_000_000)}"`);
    const result = validateDrawioSource(compressDrawio(oversized));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("超过安全上限");
  });

  it("渲染副本移除链接、外部图片、事件与危险 style，但不污染持久 source", () => {
    const source = DEFAULT_DRAWIO_SOURCE.replace(
      "<mxGraphModel ",
      '<mxGraphModel xmlns:xlink="http://www.w3.org/1999/xlink" ',
    ).replace(
      'id="start"',
      'id="start" link="javascript:alert(1)" xlink:href="https://evil.example/click" onclick="steal()"',
    ).replace(
      "rounded=0;whiteSpace=wrap;",
      "rounded=0;image=https://evil.example/a.png;whiteSpace=wrap;",
    );
    const prepared = prepareDrawioModelXmlForRender(source);
    expect(prepared.source).toContain("javascript:alert(1)");
    expect(prepared.modelXml).not.toContain("javascript:");
    expect(prepared.modelXml).not.toContain("evil.example");
    expect(prepared.modelXml).not.toContain("onclick");
    expect(prepared.modelXml).not.toContain("xlink:href");
    expect(prepared.modelXml).toContain("whiteSpace=wrap");
  });

  it("真实线上 XML 的百分号编码颜色在渲染副本中恢复为三个容器的原始配色", () => {
    const prepared = prepareDrawioModelXmlForRender(REAL_PERCENT_ENCODED_COLOR_XML);

    expect(prepared.source).toBe(REAL_PERCENT_ENCODED_COLOR_XML);
    expect(prepared.modelXml).toContain("fillColor=#EDF2F7");
    expect(prepared.modelXml).toContain("fillColor=#D4E0ED");
    expect(prepared.modelXml).toContain("fillColor=#E8EDF3");
    expect(prepared.modelXml).toContain("strokeColor=#4A6FA5");
    expect(prepared.modelXml).toContain("strokeColor=#5A7B9A");
    expect(prepared.modelXml).not.toContain("%23");
  });

  it("style 值先解码再做安全过滤，编码后的 javascript 不能绕过", () => {
    const source = DEFAULT_DRAWIO_SOURCE.replace(
      "strokeColor=#b08a3e",
      "strokeColor=%6A%61%76%61script%3Aalert(1)",
    );
    const prepared = prepareDrawioModelXmlForRender(source);

    expect(prepared.modelXml).not.toContain("javascript:");
    expect(prepared.modelXml).not.toContain("%6A%61%76%61script");
  });

  it("明文井号颜色保持不变，无法识别的颜色回退到纸墨默认色", () => {
    const source = DEFAULT_DRAWIO_SOURCE
      .replace("fillColor=#efe3cc", "fillColor=不是颜色")
      .replace("strokeColor=#b08a3e", "strokeColor=也不是颜色")
      .replace("fontColor=#2f2a22", "fontColor=仍不是颜色");
    const prepared = prepareDrawioModelXmlForRender(source);

    expect(prepared.modelXml).toContain("fillColor=#f7f1e3");
    expect(prepared.modelXml).toContain("strokeColor=#7f6a45");
    expect(prepared.modelXml).toContain("fontColor=#2f2a22");
    expect(prepareDrawioModelXmlForRender(DEFAULT_DRAWIO_SOURCE).modelXml).toContain(
      "fillColor=#efe3cc;strokeColor=#b08a3e;fontColor=#2f2a22",
    );
  });
});

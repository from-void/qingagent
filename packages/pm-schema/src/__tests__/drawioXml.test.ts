import { deflateSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAWIO_SOURCE,
  normalizeDrawioSource,
  prepareDrawioModelXmlForRender,
  readDrawioModel,
  validateDrawioSource,
} from "../drawio/drawioXml";
import { normalizePmDoc, safeParsePmDoc } from "../validators";

function compressDrawio(xml: string): string {
  const bytes = deflateSync(strToU8(encodeURIComponent(xml)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("drawio XML 明文归一化与安全边界", () => {
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
});

import { DEFAULT_DRAWIO_SOURCE, INLINE_SVG_MAX_BYTES } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import {
  DRAWIO_EMBED_PATH,
  createDrawioLoadAction,
  createDrawioSnapshotRequest,
  createDrawioStatusAction,
  decodeDrawioSvgDataUri,
  encodeDrawioAction,
  finalizeDrawioEdit,
  parseDrawioEmbedMessage,
} from "./drawioEmbedProtocol";

describe("drawio JSON embed 协议", () => {
  it("固定使用自托管离线 JSON 协议入口", () => {
    expect(DRAWIO_EMBED_PATH).toMatch(/^\/drawio\/index\.html\?/);
    expect(DRAWIO_EMBED_PATH).toContain("embed=1");
    expect(DRAWIO_EMBED_PATH).toContain("proto=json");
    expect(DRAWIO_EMBED_PATH).toContain("offline=1");
    expect(DRAWIO_EMBED_PATH).toContain("noSaveBtn=1");
    expect(DRAWIO_EMBED_PATH).toContain("keepmodified=1");
    // 图表缓存必须与查看者主题无关：编辑器钉浅色，导出写字面颜色。
    expect(DRAWIO_EMBED_PATH).toContain("dark=0");
    expect(DRAWIO_EMBED_PATH).toContain("contrast=0");
    expect(DRAWIO_EMBED_PATH).not.toContain("libraries=1");
    expect(DRAWIO_EMBED_PATH).not.toMatch(/^https?:/);
  });

  it("只接收白名单事件与正确字段", () => {
    expect(parseDrawioEmbedMessage('{"event":"init"}')).toEqual({ event: "init" });
    expect(parseDrawioEmbedMessage({ event: "load" })).toEqual({ event: "load" });
    expect(parseDrawioEmbedMessage({
      event: "autosave",
      xml: DEFAULT_DRAWIO_SOURCE,
    })).toEqual({
      event: "autosave",
      xml: DEFAULT_DRAWIO_SOURCE,
    });
    expect(parseDrawioEmbedMessage({ event: "save", xml: DEFAULT_DRAWIO_SOURCE, exit: true })).toEqual({
      event: "save",
      xml: DEFAULT_DRAWIO_SOURCE,
      exit: true,
    });
    expect(parseDrawioEmbedMessage({
      event: "export",
      point: { x: 12, y: 34 },
      exit: false,
      data: "data:image/svg+xml,%3Csvg%2F%3E",
    })).toEqual({
      event: "export",
      exit: false,
      data: "data:image/svg+xml,%3Csvg%2F%3E",
    });
    expect(parseDrawioEmbedMessage({ event: "exit", modified: false })).toEqual({
      event: "exit",
      modified: false,
    });
    expect(parseDrawioEmbedMessage("{broken")).toBeNull();
    expect(parseDrawioEmbedMessage({ event: "save", xml: 7 })).toBeNull();
    expect(parseDrawioEmbedMessage({ event: "unknown", xml: DEFAULT_DRAWIO_SOURCE })).toBeNull();
  });

  it("load/snapshot/status 动作符合 v31，并在 snapshot 前校验 XML", () => {
    expect(createDrawioLoadAction(DEFAULT_DRAWIO_SOURCE, "工程图")).toMatchObject({
      action: "load",
      title: "工程图",
      saveAndExit: true,
      autosave: true,
      xml: DEFAULT_DRAWIO_SOURCE,
    });
    const request = createDrawioSnapshotRequest(DEFAULT_DRAWIO_SOURCE);
    expect(request).toEqual({
      source: DEFAULT_DRAWIO_SOURCE,
      action: { action: "snapshot" },
    });
    expect(JSON.parse(encodeDrawioAction(request.action))).toEqual({ action: "snapshot" });
    expect(JSON.parse(encodeDrawioAction(createDrawioStatusAction(false)))).toEqual({
      action: "status",
      modified: false,
    });
    expect(() => createDrawioSnapshotRequest("<not-drawio/>")).toThrow(/根节点/);
  });

  it("保存时解码并用统一 hardenInlineSvg 清除脚本、事件和外链", () => {
    const source = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', 'value="安全保存"');
    const unsafeSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      '<script>alert(1)</script>',
      '<a href="https://evil.example/"><rect width="10" height="10"/></a>',
      '<text>安全保存</text>',
      "</svg>",
    ].join("");
    const result = finalizeDrawioEdit(
      source,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(unsafeSvg)}`,
    );

    expect(result.source).toContain('value="安全保存"');
    expect(result.svg).toContain("安全保存");
    expect(result.svg).not.toMatch(/script|onload|evil\.example/i);
  });

  it("支持 UTF-8 base64，并拒绝非 SVG、坏编码和超限 data URI", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>';
    const encoded = Buffer.from(svg, "utf8").toString("base64");
    expect(decodeDrawioSvgDataUri(`data:image/svg+xml;base64,${encoded}`)).toBe(svg);
    expect(() => decodeDrawioSvgDataUri("data:text/html,<h1>x</h1>")).toThrow(/SVG data URI/);
    expect(() => decodeDrawioSvgDataUri("data:image/svg+xml,%E0%A4%A")).toThrow(/解码失败/);
    expect(() =>
      decodeDrawioSvgDataUri(`data:image/svg+xml,${"x".repeat(INLINE_SVG_MAX_BYTES * 4 + 257)}`),
    ).toThrow(/过大/);
  });
});

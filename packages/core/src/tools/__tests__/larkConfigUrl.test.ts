import { describe, expect, it } from "vitest";
import { extractLarkConfigInitUrl } from "../larkConfigUrl.js";

// 从 lark-cli config init 混杂输出里挑飞书创建链接。对付不可信 CLI 输出,测脏形态:
// 多 URL 竞争、尾随标点、无 URL、非飞书域、中英文混排。
describe("extractLarkConfigInitUrl", () => {
  it("优先选飞书 console/verification 链接(而非无关参考链接)", () => {
    const output = [
      "参考文档 https://example.com/help",
      "请打开 https://open.feishu.cn/console/app/init?verification=abc123 完成创建。",
    ].join("\n");
    expect(extractLarkConfigInitUrl(output)).toBe(
      "https://open.feishu.cn/console/app/init?verification=abc123",
    );
  });

  it("剥除链接尾随的中英文标点", () => {
    expect(extractLarkConfigInitUrl("打开 https://open.feishu.cn/app/create?token=x。")).toBe(
      "https://open.feishu.cn/app/create?token=x",
    );
    expect(extractLarkConfigInitUrl("see https://open.feishu.cn/app/create?token=y)")).toBe(
      "https://open.feishu.cn/app/create?token=y",
    );
  });

  it("larksuite / larkoffice / 含 lark 的域名也命中", () => {
    expect(extractLarkConfigInitUrl("url: https://open.larksuite.com/console/x")).toBe(
      "https://open.larksuite.com/console/x",
    );
  });

  it("无 URL → null,不抛", () => {
    expect(extractLarkConfigInitUrl("starting...\nno link yet")).toBeNull();
    expect(extractLarkConfigInitUrl("")).toBeNull();
  });

  it("verification 关键词加权:飞书域 + verification 胜过仅飞书域", () => {
    const output = [
      "https://open.feishu.cn/other/page",
      "https://open.feishu.cn/console/init?verification=win",
    ].join("\n");
    expect(extractLarkConfigInitUrl(output)).toBe(
      "https://open.feishu.cn/console/init?verification=win",
    );
  });

  it("只有非飞书域时仍返回得分最高(>=0)的那条", () => {
    // 非飞书域 score=0(>=0 保留),仍可能是有效创建链接的兜底
    expect(extractLarkConfigInitUrl("go https://example.com/create")).toBe(
      "https://example.com/create",
    );
  });
});

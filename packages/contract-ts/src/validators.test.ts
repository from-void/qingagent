import { describe, expect, it } from "vitest";
import { isAllowedLinkHref } from "./validators";

describe("isAllowedLinkHref", () => {
  it.each([
    String.raw`/\evil.example.com`,
    String.raw`/\\evil.example.com`,
    String.raw`/\/evil.example.com`,
    String.raw`//\evil.example.com`,
  ])("拒绝可被浏览器解释为站外 authority 的斜杠混合变体: %s", (href) => {
    expect(isAllowedLinkHref(href)).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "JaVaScRiPt:alert(1)",
    "&#106;avascript:alert(1)",
    " javascript:alert(1)",
    "//evil.example.com",
    String.raw`https:\evil.example.com`,
    String.raw`https:/\evil.example.com`,
  ])("继续拒绝已有危险链接变体: %s", (href) => {
    expect(isAllowedLinkHref(href)).toBe(false);
  });

  it.each([
    "/docs/x",
    "/a?b=1#c",
    "#x",
    "http://example.com/docs",
    "https://example.com/docs",
    "HTTPS://example.com/docs",
  ])("继续允许白名单内链接: %s", (href) => {
    expect(isAllowedLinkHref(href)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  isTableToolbarCommandEnabled,
  isToolbarCommandEnabled,
  normalizeToolbarHighlightColor,
  normalizeToolbarTextColor,
  resolveToolbarUnlockConfig,
  sanitizeToolbarLinkHref,
} from "../data/toolbarUnlock";

describe("toolbarUnlock", () => {
  it("默认解禁 Phase E 目标命令执行层", () => {
    const config = resolveToolbarUnlockConfig();
    const commands: Array<[string, string | null | undefined]> = [
      ["bold", undefined],
      ["italic", undefined],
      ["underline", undefined],
      ["strikeThrough", undefined],
      ["code", undefined],
      ["createLink", undefined],
      ["textColor", "red"],
      ["hiliteColor", "yellow"],
      ["justifyLeft", undefined],
      ["justifyCenter", undefined],
      ["justifyRight", undefined],
      ["formatBlock", "H3"],
      ["formatBlock", "H4"],
      ["formatBlock", "H5"],
      ["formatBlock", "H6"],
      ["bulletList", undefined],
      ["orderedList", undefined],
      ["blockquote", undefined],
      ["insertColumns", undefined],
    ];

    expect(commands.every(([cmd, val]) => isToolbarCommandEnabled(cmd, val, config))).toBe(true);
    expect([
      "bold", "italic", "underline", "strike", "code", "textColor", "highlight",
      "cellBackground", "alignLeft", "alignCenter", "alignRight", "link",
    ].every((cmd) => isTableToolbarCommandEnabled(cmd, config))).toBe(true);
  });

  it("sanitize link href 并把旧 hex 高亮值规范到 PM 白名单", () => {
    expect(sanitizeToolbarLinkHref(" https://example.com/a ")).toBe("https://example.com/a");
    expect(sanitizeToolbarLinkHref("/api/v1/files/x")).toBe("/api/v1/files/x");
    expect(sanitizeToolbarLinkHref("#section-1")).toBe("#section-1");
    expect(sanitizeToolbarLinkHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeToolbarLinkHref("//example.com")).toBeNull();
    expect(sanitizeToolbarLinkHref("https://example.com>")).toBeNull();
    expect(sanitizeToolbarLinkHref("https://example.com/a\"")).toBeNull();
    expect(sanitizeToolbarLinkHref("https://example.com/a`")).toBeNull();
    expect(sanitizeToolbarLinkHref("https://example.com/<x>")).toBeNull();

    expect(normalizeToolbarHighlightColor("yellow")).toBe("yellow");
    expect(normalizeToolbarHighlightColor("#fff3a3")).toBe("yellow");
    expect(normalizeToolbarHighlightColor("#d4edd4")).toBe("green");
    expect(normalizeToolbarHighlightColor("rose")).toBe("rose");
    expect(normalizeToolbarHighlightColor("#f3d3d9")).toBe("rose");
    expect(normalizeToolbarTextColor("red")).toBe("red");
    expect(normalizeToolbarTextColor("#a33a2a")).toBe("red");
    expect(normalizeToolbarHighlightColor("transparent")).toBeNull();
    expect(normalizeToolbarTextColor("transparent")).toBeNull();
  });
});

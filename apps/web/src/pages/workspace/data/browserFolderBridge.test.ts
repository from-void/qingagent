import { describe, expect, it } from "vitest";
import { splitBrowserBridgeRelPath } from "./browserFolderBridge";

describe("splitBrowserBridgeRelPath", () => {
  it("接受安全 POSIX 相对路径和根目录", () => {
    expect(splitBrowserBridgeRelPath("", true)).toEqual([]);
    expect(splitBrowserBridgeRelPath("docs/a.md", false)).toEqual(["docs", "a.md"]);
    expect(splitBrowserBridgeRelPath("中文/资料 1.csv", false)).toEqual(["中文", "资料 1.csv"]);
  });

  it("拒绝穿越、绝对路径、反斜杠、空段和 NUL", () => {
    const dirty = [
      "",
      "/abs.md",
      "C:/Users/name/a.md",
      "docs\\a.md",
      "docs/../secret.md",
      "../secret.md",
      "docs/./a.md",
      "docs//a.md",
      "docs/\0a.md",
    ];
    for (const relPath of dirty) {
      expect(() => splitBrowserBridgeRelPath(relPath, false)).toThrow(/invalid_path/);
    }
  });
});

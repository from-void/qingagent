import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ENTRYPOINT_FILES = [
  new URL("../../App.tsx", import.meta.url),
  new URL("../../pages/workspace/components/ChatInput.tsx", import.meta.url),
];
const REMOVED_PLATFORM_RE = new RegExp(`\\u8bed\\u96c0|${["yu", "que"].join("")}`, "i");

describe("平台入口不再暴露下线平台", () => {
  it("发布/导入/凭据 UI 入口不暴露语雀", () => {
    for (const fileUrl of ENTRYPOINT_FILES) {
      const source = readFileSync(fileUrl, "utf8");
      expect(source, fileUrl.pathname).not.toMatch(REMOVED_PLATFORM_RE);
    }
  });
});

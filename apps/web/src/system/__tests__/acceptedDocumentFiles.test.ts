import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DOCUMENT_ACCEPT_ATTR,
  isAcceptedDocumentFile,
} from "../acceptedDocumentFiles";

function file(name: string, type = ""): Pick<File, "name" | "type"> {
  return { name, type };
}

describe("acceptedDocumentFiles", () => {
  it("starter 与 workspace 上传都接受 Markdown 文件", () => {
    expect(isAcceptedDocumentFile(file("note.md"))).toBe(true);
    expect(isAcceptedDocumentFile(file("note.markdown"))).toBe(true);
    expect(ACCEPTED_DOCUMENT_ACCEPT_ATTR).toContain(".md");
    expect(ACCEPTED_DOCUMENT_ACCEPT_ATTR).toContain(".markdown");
  });

  it("拒绝未知扩展,避免白名单漂移", () => {
    expect(isAcceptedDocumentFile(file("setup.exe"))).toBe(false);
  });
});

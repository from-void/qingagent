import { describe, expect, it } from "vitest";
import { classifyDocSaveError, TRANSIENT_DOC_SAVE_TOAST } from "./docSaveError";

describe("classifyDocSaveError —— 保存失败:瞬态抖动 vs 硬失败", () => {
  it("复现 Bug B:Chrome 的 fetch 网络失败(TypeError: Failed to fetch)判瞬态", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyDocSaveError(err)).toBe("transient");
  });

  it("Firefox/Safari 的网络失败文案也判瞬态", () => {
    expect(
      classifyDocSaveError(
        new TypeError("NetworkError when attempting to fetch resource."),
      ),
    ).toBe("transient");
    expect(classifyDocSaveError(new TypeError("Load failed"))).toBe("transient");
  });

  it("AbortError(请求被取消:停止/卸载/被取代)判瞬态,不当硬失败", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(classifyDocSaveError(abort)).toBe("transient");
    // 退化环境(无 DOMException 时用普通 Error 模拟 name)
    const fake = new Error("aborted");
    fake.name = "AbortError";
    expect(classifyDocSaveError(fake)).toBe("transient");
  });

  it("服务端确认失败 / 校验失败 / 冲突等业务文案判硬失败(应如实提示)", () => {
    expect(classifyDocSaveError(new Error("保存校验失败，请检查文档内容后重试。"))).toBe(
      "fatal",
    );
    expect(
      classifyDocSaveError(new Error("Stream request failed: 409")),
    ).toBe("fatal");
    expect(classifyDocSaveError(new Error("文档已被更新，请重载后继续编辑。"))).toBe(
      "fatal",
    );
  });

  it("温和文案明确告知内容未丢失(不吓用户)", () => {
    expect(TRANSIENT_DOC_SAVE_TOAST).toContain("内容仍在");
  });
});

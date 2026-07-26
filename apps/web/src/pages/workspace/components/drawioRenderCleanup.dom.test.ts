// @vitest-environment jsdom

import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { describe, expect, it, vi } from "vitest";
import { renderDrawio } from "./drawioRender";

vi.mock("@maxgraph/core", () => ({
  Graph: class {
    constructor() {
      throw new Error("Graph 构造失败");
    }
  },
  ImageExport: class {},
  ModelXmlSerializer: class {},
  SvgCanvas2D: class {},
}));

describe("drawio 离线渲染器清理", () => {
  it("Graph 构造抛错时移除离屏容器", async () => {
    const before = Array.from(document.body.children);

    await expect(renderDrawio(DEFAULT_DRAWIO_SOURCE)).rejects.toThrow("Graph 构造失败");

    expect(Array.from(document.body.children)).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 真流式历史上死过两次(07-11 迁入 branchCall、07-19「验真后回放」),都是重构时被顺手改回
// 回放式。本合同钉住:三个面向逐字展示的调用点必须显式开 liveTextDeltas,且透传链路完整。
// 若要合法移除,先确认对应前端(选项逐个蹦出/草稿逐字吐/SVG 一点点画)已不再依赖增量帧。

const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("真流式调用点合同", () => {
  it("writeDraft 借道时开 liveTextDeltas", () => {
    expect(src("tools/writeDraft.ts")).toMatch(/liveTextDeltas:\s*true/);
  });

  it("generateSvg 借道时开 liveTextDeltas", () => {
    expect(src("tools/generateSvg.ts")).toMatch(/liveTextDeltas:\s*true/);
  });

  it("出题侧信道开 liveTextDeltas", () => {
    expect(src("services/genService.ts")).toMatch(/liveTextDeltas:\s*true/);
  });

  it("streamInnerModel 把 liveTextDeltas 透传给 branchCall", () => {
    const inner = src("llm/innerModelStream.ts");
    expect(inner).toMatch(/liveTextDeltas\?:\s*boolean/);
    expect(inner).toMatch(/liveTextDeltas:\s*input\.liveTextDeltas/);
  });
});

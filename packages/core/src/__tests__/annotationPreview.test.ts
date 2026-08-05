import { describe, expect, it } from "vitest";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import {
  AnnotationPreviewAccumulator,
  IncrementalAnnotationGroupScanner,
  MAX_ANNOTATION_PREVIEW_ARGS_BYTES,
  buildAnnotationPreviewData,
} from "../agent-run/annotationPreview.js";

describe("批注参数增量组扫描器", () => {
  it("跳过字符串里的大括号与转义引号，只在顶层组对象闭合时产出", () => {
    const scanner = new IncrementalAnnotationGroupScanner();
    const input = JSON.stringify({
      groups: [{
        summary: "括号测试",
        note: "字符串含 } 与 {，以及转义引号 \"仍在字符串中\"",
        anchors: [{ find: "甲句" }],
      }],
    });
    const midpoint = input.indexOf("仍在字符串中");
    expect(scanner.feed(input.slice(0, midpoint))).toEqual([]);
    expect(scanner.feed(input.slice(midpoint))).toEqual([
      expect.objectContaining({ summary: "括号测试", anchors: [{ find: "甲句" }] }),
    ]);
  });

  it("半截 JSON 静默等待，后续一次吐出多组", () => {
    const scanner = new IncrementalAnnotationGroupScanner();
    expect(scanner.feed('{"groups":[{"summary":"第一组","anchors":[{"find":"甲')).toEqual([]);
    expect(scanner.feed('句"}]},{"summary":"第二组","anchors":[{"find":"乙句"}]}]}')).toEqual([
      expect.objectContaining({ summary: "第一组" }),
      expect.objectContaining({ summary: "第二组" }),
    ]);
  });

  it("两次工具调用的预览在 clear 前累积且 previewId 唯一", () => {
    const accumulator = new AnnotationPreviewAccumulator();
    accumulator.start("tc-1");
    accumulator.start("tc-2");
    const first = accumulator.feed("tc-1", '{"groups":[{"summary":"甲","anchors":[{"find":"甲句"}]}]}');
    const second = accumulator.feed("tc-2", '{"groups":[{"summary":"乙","anchors":[{"find":"乙句"}]}]}');
    expect([...first, ...second].map((group) => group.previewId)).toEqual([
      "annotation-preview-tc-1-1",
      "annotation-preview-tc-2-2",
    ]);
    accumulator.clear();
    expect(accumulator.feed("tc-1", "{}")).toEqual([]);
  });

  it("组数超限与 512KB 参数超限后停止扫描", () => {
    const limited = new IncrementalAnnotationGroupScanner(2);
    const groups = Array.from({ length: 3 }, (_, index) => ({
      summary: `组${index}`,
      anchors: [{ find: `${index}` }],
    }));
    expect(limited.feed(JSON.stringify({ groups }))).toHaveLength(2);
    expect(limited.isStopped).toBe(true);
    expect(limited.feed(JSON.stringify({ groups: [groups[0]] }))).toEqual([]);

    const oversized = new IncrementalAnnotationGroupScanner(64, MAX_ANNOTATION_PREVIEW_ARGS_BYTES);
    expect(oversized.feed("x".repeat(MAX_ANNOTATION_PREVIEW_ARGS_BYTES + 1))).toEqual([]);
    expect(oversized.isStopped).toBe(true);
  });

  it("clear 后同回合的多次工具调用仍共享 64 组总额度", () => {
    const accumulator = new AnnotationPreviewAccumulator();
    accumulator.start("tc-first");
    const firstBatch = Array.from({ length: 64 }, (_, index) => ({
      summary: `首批${index}`,
      anchors: [{ find: "甲句" }],
    }));
    expect(accumulator.feed("tc-first", JSON.stringify({ groups: firstBatch }))).toHaveLength(64);
    accumulator.clear();
    accumulator.start("tc-second");
    expect(accumulator.feed("tc-second", '{"groups":[{"summary":"越限","anchors":[{"find":"乙句"}]}]}')).toEqual([]);
  });

  it("预览锚点复用正式工具的 literal/all 语义", () => {
    const doc = legacySectionsToPm([
      { kind: "p", data: { text: "重复原句" } },
      { kind: "p", data: { text: "重复原句" } },
    ] as never);
    expect(buildAnnotationPreviewData(doc, "p-single", {
      summary: "歧义",
      anchors: [{ find: "重复原句" }],
    })).toBeNull();
    expect(buildAnnotationPreviewData(doc, "p-all", {
      summary: "全部",
      anchors: [{ find: "重复原句", all: true }],
    })?.anchors).toHaveLength(2);
  });

  it("流式预览摘要先脱敏再截断，不展示 15 字边界切出的 8 位手机号残片", () => {
    const phone = "13912345678";
    const doc = legacySectionsToPm([
      { kind: "p", data: { text: `联系电话 ${phone}` } },
    ] as never);

    const preview = buildAnnotationPreviewData(doc, "p-private", {
      summary: `摘要含手机号：${phone}`,
      anchors: [{ find: phone }],
    });

    expect(preview?.summary).toBe("摘要含手机号：139****5");
    expect(preview?.summary).not.toMatch(/1[3-9]\d{3,}/u);
    expect(preview?.summary).not.toContain("13912345");
  });
});

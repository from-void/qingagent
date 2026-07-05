import { describe, expect, it } from "vitest";
import {
  BOOK_CURL_DEFAULTS,
  advanceBookCurlProgress,
  resolveBookCurlSegments,
} from "./BookCurlShelf";

describe("BookCurlShelf 运行时性能控制", () => {
  it("high 档几何段数保持不变", () => {
    expect(resolveBookCurlSegments("high", false)).toEqual({ width: 64, height: 72 });
  });

  it("只在 low 档或 reduced-motion 降低几何段数", () => {
    expect(resolveBookCurlSegments("low", false)).toEqual({ width: 32, height: 36 });
    expect(resolveBookCurlSegments("high", true)).toEqual({ width: 32, height: 36 });
  });

  it("progress 未吸附到目标前持续报告需要 RAF", () => {
    expect(advanceBookCurlProgress(0, 1, { ...BOOK_CURL_DEFAULTS, speed: 0.5, snap: 0.01 })).toEqual({
      progress: 0.5,
      settled: false,
    });

    expect(advanceBookCurlProgress(0.995, 1, { ...BOOK_CURL_DEFAULTS, speed: 0.5, snap: 0.01 })).toEqual({
      progress: 1,
      settled: true,
    });

    expect(advanceBookCurlProgress(1, 1, BOOK_CURL_DEFAULTS)).toEqual({
      progress: 1,
      settled: true,
    });
  });
});

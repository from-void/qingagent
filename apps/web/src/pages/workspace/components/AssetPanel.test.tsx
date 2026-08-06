import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileIcon, fileKind } from "./AssetPanel";

describe("AssetPanel 文件类型徽标", () => {
  it("CSV 扩展名和 MIME 都显示 CSV，而不是 XLS", () => {
    expect(fileKind("统计.csv")).toBe("csv");
    expect(fileKind("统计", "text/csv")).toBe("csv");

    const markup = renderToStaticMarkup(<FileIcon kind={fileKind("统计.csv")} />);
    expect(markup).toContain('aria-label="CSV"');
    expect(markup).toContain(">CSV</text>");
    expect(markup).not.toContain('aria-label="XLS"');
  });
});

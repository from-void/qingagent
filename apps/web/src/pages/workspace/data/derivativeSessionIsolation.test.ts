import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentDerivativePrefetch } from "./derivativeSessionIsolation";

describe("衍生稿会话隔离", () => {
  it("旧会话预取即使请求序号和 docId 匹配也不能生效", () => {
    expect(
      isCurrentDerivativePrefetch({
        currentRequestId: 2,
        currentSessionId: "session-b",
        documentDocId: "derivative-a",
        requestDocId: "derivative-a",
        requestId: 2,
        requestSessionId: "session-a",
      }),
    ).toBe(false);
  });

  it("会话切换同时复位衍生 Tab、译文选择和预取代际", () => {
    const controller = readFileSync(
      resolve(
        process.cwd(),
        "src/pages/workspace/hooks/useWorkspacePageController.tsx",
      ),
      "utf8",
    );
    const pane = readFileSync(
      resolve(
        process.cwd(),
        "src/pages/workspace/components/WorkspaceDocumentPane.tsx",
      ),
      "utf8",
    );

    expect(controller).toMatch(
      /useEffect\(\(\) => \{\s*setDerivatives\(\[\]\);\s*setActiveTab\("main"\);\s*setActiveTranslationDocId\(null\);/,
    );
    expect(pane).toContain(
      "derivativeTabRequestRef.current += 1;",
    );
    expect(pane).toContain("isCurrentDerivativePrefetch({");
    expect(pane).toMatch(
      /derivativeTabRequestRef\.current !== requestId \|\|\s*currentSessionIdRef\.current !== requestSessionId/,
    );
  });
});

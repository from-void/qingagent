import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentSessionTitleRename } from "./sessionTitleRename";

describe("会话标题并发重命名", () => {
  it("后一次重命名成功后忽略前一次请求的迟到失败", () => {
    expect(
      isCurrentSessionTitleRename({
        currentGeneration: 2,
        currentSessionId: "session-1",
        currentTitle: "标题 T2",
        requestGeneration: 1,
        requestSessionId: "session-1",
        requestTitle: "标题 T1",
      }),
    ).toBe(false);
  });

  it("只有当前会话、最新代际且仍显示本次乐观值时允许回滚", () => {
    expect(
      isCurrentSessionTitleRename({
        currentGeneration: 2,
        currentSessionId: "session-1",
        currentTitle: "标题 T2",
        requestGeneration: 2,
        requestSessionId: "session-1",
        requestTitle: "标题 T2",
      }),
    ).toBe(true);
    expect(
      isCurrentSessionTitleRename({
        currentGeneration: 2,
        currentSessionId: "session-2",
        currentTitle: "标题 T2",
        requestGeneration: 2,
        requestSessionId: "session-1",
        requestTitle: "标题 T2",
      }),
    ).toBe(false);
  });

  it("标题提交链路接入会话级代际和条件回滚", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/pages/workspace/components/WorkspaceDocumentPane.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("isCurrentSessionTitleRename({");
    expect(source).toContain("renameGenerationBySessionRef.current");
    expect(source).toContain(
      "currentTitle === nextTitle ? previousTitle : currentTitle",
    );
  });
});

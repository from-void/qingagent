// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { openDrawioEditor } from "./drawioEditorLauncher";

afterEach(async () => {
  const complete = document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__complete");
  if (complete) {
    await act(async () => complete.click());
  }
  await act(async () => undefined);
  document.querySelectorAll("[data-drawio-editor-host]").forEach((host) => host.remove());
});

describe("drawio 编辑器 launcher", () => {
  it("连续打开并完成三次，每轮都创建新 iframe 且完整清理 host", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      let resultPromise!: Promise<unknown>;
      await act(async () => {
        resultPromise = openDrawioEditor(DEFAULT_DRAWIO_SOURCE, `第 ${cycle + 1} 轮`);
      });
      expect(document.querySelectorAll("[data-drawio-editor-host]")).toHaveLength(1);
      expect(document.querySelector(".drawio-editor-overlay__frame")).not.toBeNull();

      await act(async () => {
        document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__complete")?.click();
        await resultPromise;
      });
      expect(await resultPromise).toBeNull();
      expect(document.querySelector("[data-drawio-editor-host]")).toBeNull();
      expect(document.querySelector(".drawio-editor-overlay__frame")).toBeNull();
    }
  });

  it("旧 host 被外层提前摘除时结算孤儿会话，下一次仍能打开", async () => {
    let orphanPromise!: Promise<unknown>;
    await act(async () => {
      orphanPromise = openDrawioEditor(DEFAULT_DRAWIO_SOURCE, "孤儿会话");
    });
    document.querySelector("[data-drawio-editor-host]")?.remove();

    let nextPromise!: Promise<unknown>;
    await act(async () => {
      nextPromise = openDrawioEditor(DEFAULT_DRAWIO_SOURCE, "恢复会话");
      await orphanPromise;
    });
    expect(await orphanPromise).toBeNull();
    expect(document.querySelector(".drawio-editor-overlay__frame")).not.toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__complete")?.click();
      await nextPromise;
    });
    expect(await nextPromise).toBeNull();
  });
});

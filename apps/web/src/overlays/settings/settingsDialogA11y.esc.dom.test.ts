// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSettingsDialogA11y,
  resetSettingsDialogA11yForTest,
} from "./settingsDialogA11y";
import { resetOverlayDismissStackForTest } from "../../system/overlayDismissStack";

describe("工作区挂载的设置弹层 Esc", () => {
  afterEach(() => {
    resetSettingsDialogA11yForTest();
    resetOverlayDismissStackForTest();
    document.body.replaceChildren();
  });

  it("不经过 HomeSettingsSheet 包装时也会进入关闭栈并由 Esc 关闭", async () => {
    const close = vi.fn();
    const sheet = document.createElement("section");
    sheet.className = "qj-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.innerHTML = '<button type="button" class="qj-sheet-close">关闭</button>';
    sheet.querySelector("button")?.addEventListener("click", () => {
      close();
      sheet.remove();
    });
    document.body.append(sheet);

    ensureSettingsDialogA11y();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(document.body.contains(sheet)).toBe(false);
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SliderQuestionInput } from "./SliderQuestionInput";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("SliderQuestionInput", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  it("渲染填充、跟随气泡和随值点亮的刻度", async () => {
    const onChange = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <SliderQuestionInput
          qid="length"
          slider={{
            min: 200,
            max: 1000,
            step: 200,
            unit: "字",
            marks: [200, 600, 1000],
            aboveLabel: "1000 字以上",
          }}
          value={600}
          onChange={onChange}
        />,
      );
    });

    expect(host.querySelector<HTMLElement>(".aus2-fill")?.style.width).toBe("50%");
    expect(host.querySelector(".aus2-bubble")?.textContent).toBe("600字");
    expect(Array.from(host.querySelectorAll(".aus2-scale span")).map((node) => node.getAttribute("data-hit"))).toEqual([
      "true",
      "true",
      "false",
    ]);

    const input = host.querySelector<HTMLInputElement>(".aus2-input")!;
    await act(async () => {
      setNativeInputValue(input, "1000");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(1000);
  });
});

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

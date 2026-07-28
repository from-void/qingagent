import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateEditorPage } from "./TemplateEditorPage";

describe("TemplateEditorPage AI 起草", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function render(onAiDraft: NonNullable<React.ComponentProps<typeof TemplateEditorPage>["onAiDraft"]>) {
    const onNameChange = vi.fn();
    const onPromptChange = vi.fn();
    function Harness() {
      const [name, setName] = React.useState("已有名称");
      const [prompt, setPrompt] = React.useState("已有提示词");
      return <TemplateEditorPage
        mode="new"
        name={name}
        prompt={prompt}
        placeholders={{ name: "名称", prompt: "提示词" }}
        onNameChange={(value) => { onNameChange(value); setName(value); }}
        onPromptChange={(value) => { onPromptChange(value); setPrompt(value); }}
        onAiDraft={onAiDraft}
        onSave={vi.fn()}
      />;
    }
    act(() => root.render(<Harness />));
    return { onNameChange, onPromptChange };
  }

  it("点击后显示起草中并禁用，成功后覆盖回填名称与提示词", async () => {
    let resolve!: (value: { name: string; prompt: string }) => void;
    const onAiDraft = vi.fn(() => new Promise<{ name: string; prompt: string }>((done) => { resolve = done; }));
    const rendered = render(onAiDraft);
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("AI 起草"))!;
    act(() => button.click());
    expect(button.textContent).toBe("起草中…");
    expect(button.disabled).toBe(true);
    expect(onAiDraft).toHaveBeenCalledWith(
      { name: "已有名称", prompt: "已有提示词" },
      expect.any(AbortSignal),
    );

    await act(async () => resolve({ name: "投资人审查", prompt: "逐项检查市场、壁垒与回报。" }));
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("投资人审查");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("逐项检查市场、壁垒与回报。");
    expect(rendered.onNameChange).toHaveBeenCalledWith("投资人审查");
    expect(rendered.onPromptChange).toHaveBeenCalledWith("逐项检查市场、壁垒与回报。");
  });

  it("等待 AI 起草期间用户改过输入时静默丢弃迟到结果", async () => {
    let resolve!: (value: { name: string; prompt: string }) => void;
    const onAiDraft = vi.fn(() => new Promise<{ name: string; prompt: string }>((done) => { resolve = done; }));
    const rendered = render(onAiDraft);
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("AI 起草"))!;
    act(() => button.click());

    const input = host.querySelector<HTMLInputElement>("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "用户新名称");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("用户新名称");

    await act(async () => resolve({ name: "迟到名称", prompt: "迟到提示词" }));

    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("用户新名称");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("已有提示词");
    expect(rendered.onNameChange).not.toHaveBeenCalledWith("迟到名称");
    expect(rendered.onPromptChange).not.toHaveBeenCalledWith("迟到提示词");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("失败显示既有错误行，卸载会 abort 在途请求", async () => {
    let signal: AbortSignal | undefined;
    const onAiDraft = vi.fn((_intent, abortSignal) => {
      signal = abortSignal;
      return new Promise<{ name: string; prompt: string }>(() => undefined);
    });
    render(onAiDraft);
    act(() => Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("AI 起草"))!.click());
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    root = createRoot(host);

    render(async () => { throw new Error("provider failed"); });
    await act(async () => Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("AI 起草"))!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("AI 起草失败，可以手动填写或重试");
  });
});

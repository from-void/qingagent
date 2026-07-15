import { Button } from "@qingagent/ui-kit";
import type { DraftTemplateIntent, DraftTemplateResult } from "@qingagent/contract-ts";
import { useEffect, useRef, useState } from "react";
import type { TemplateStarterPreset } from "./starterPresets";

export type TemplateEditorMode = "new" | "existing";

export function TemplateEditorPage(props: {
  mode: TemplateEditorMode;
  name: string;
  prompt: string;
  placeholders: {
    name: string;
    prompt: string;
  };
  starters?: readonly TemplateStarterPreset[];
  saving?: boolean;
  deleteDisabled?: boolean;
  onNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onStarterSelect?: (starter: TemplateStarterPreset) => void;
  onAiDraft?: (intent: DraftTemplateIntent, abortSignal: AbortSignal) => Promise<DraftTemplateResult>;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onSave: () => void;
}) {
  const invalid = !props.name.trim() || !props.prompt.trim();
  const [aiDrafting, setAiDrafting] = useState(false);
  const [aiError, setAiError] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => aiAbortRef.current?.abort(), []);

  const runAiDraft = async () => {
    if (!props.onAiDraft || aiDrafting) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiDrafting(true);
    setAiError(false);
    try {
      const draft = await props.onAiDraft({ name: props.name, prompt: props.prompt }, controller.signal);
      if (controller.signal.aborted) return;
      props.onNameChange(draft.name);
      props.onPromptChange(draft.prompt);
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        setAiError(true);
      }
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      if (!controller.signal.aborted) setAiDrafting(false);
    }
  };

  return (
    <div className="ws-launch-editor">
      <label className="ws-launch-field">
        <span>名称</span>
        <input value={props.name} placeholder={props.placeholders.name} onChange={(event) => props.onNameChange(event.currentTarget.value)} />
      </label>
      <label className="ws-launch-field">
        <span>提示词</span>
        <textarea value={props.prompt} placeholder={props.placeholders.prompt} onChange={(event) => props.onPromptChange(event.currentTarget.value)} />
      </label>
      {aiError ? <p className="ws-launch-error" role="alert">AI 起草失败，可以手动填写或重试</p> : null}
      <div className="ws-launch-actions">
        {(props.mode === "new" && props.starters?.length) || props.onAiDraft ? (
          <div className="ws-launch-starters">
            {props.mode === "new" && props.starters?.length ? <span>快速开始：</span> : null}
            {props.mode === "new" ? props.starters?.map((starter) => (
              <button key={starter.name} type="button" onClick={() => props.onStarterSelect?.(starter)}>{starter.name}</button>
            )) : null}
            {props.onAiDraft ? <button type="button" className="ws-launch-ai-draft" disabled={aiDrafting} onClick={() => void runAiDraft()}>{aiDrafting ? "起草中…" : "✦ AI 起草"}</button> : null}
          </div>
        ) : null}
        {props.mode !== "new" ? <Button type="button" variant="ghost" data-danger="true" disabled={props.saving || props.deleteDisabled} title={props.deleteDisabled ? "每类至少保留一个模板" : undefined} onClick={props.onDelete}>删除</Button> : null}
        {props.mode !== "new" ? <Button type="button" disabled={props.saving || invalid} onClick={props.onDuplicate}>另存新模板</Button> : null}
        <Button type="button" variant="primary" disabled={props.saving || invalid} onClick={props.onSave}>保存</Button>
      </div>
    </div>
  );
}

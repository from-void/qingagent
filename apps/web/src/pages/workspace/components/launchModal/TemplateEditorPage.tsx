import { Button } from "@qingagent/ui-kit";
import type { DraftTemplateIntent, DraftTemplateResult } from "@qingagent/contract-ts";
import { useEffect, useId, useRef, useState } from "react";
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
  mutationDisabled?: boolean;
  deleteDisabled?: boolean;
  deleteDisabledReason?: string;
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
  const promptFieldId = useId();
  const aiAbortRef = useRef<AbortController | null>(null);
  const inputRevisionRef = useRef(0);
  const lastInputsRef = useRef({ name: props.name, prompt: props.prompt });

  if (
    lastInputsRef.current.name !== props.name ||
    lastInputsRef.current.prompt !== props.prompt
  ) {
    inputRevisionRef.current += 1;
    lastInputsRef.current = { name: props.name, prompt: props.prompt };
  }

  useEffect(() => () => aiAbortRef.current?.abort(), []);

  const runAiDraft = async () => {
    if (!props.onAiDraft || aiDrafting) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiDrafting(true);
    setAiError(false);
    const inputRevision = inputRevisionRef.current;
    try {
      const draft = await props.onAiDraft({ name: props.name, prompt: props.prompt }, controller.signal);
      if (controller.signal.aborted || inputRevisionRef.current !== inputRevision) return;
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
        <input disabled={props.mutationDisabled} value={props.name} placeholder={props.placeholders.name} onChange={(event) => props.onNameChange(event.currentTarget.value)} />
      </label>
      {/* AI 起草贴在提示词输入框右上角:它是给这个输入框用的,放在底部动作区会被误认成表单级操作 */}
      <div className="ws-launch-field">
        <div className="ws-launch-field-head">
          <label htmlFor={promptFieldId}>提示词</label>
          {props.onAiDraft ? <button type="button" className="ws-launch-ai-draft" disabled={aiDrafting || props.mutationDisabled} onClick={() => void runAiDraft()}>{aiDrafting ? "起草中…" : "✦ AI 起草"}</button> : null}
        </div>
        <textarea disabled={props.mutationDisabled} id={promptFieldId} value={props.prompt} placeholder={props.placeholders.prompt} onChange={(event) => props.onPromptChange(event.currentTarget.value)} />
      </div>
      {aiError ? <p className="ws-launch-error" role="alert">AI 起草失败，可以手动填写或重试</p> : null}
      <div className="ws-launch-actions">
        {props.mode === "new" && props.starters?.length ? (
          <div className="ws-launch-starters">
            <span>快速开始：</span>
            {props.starters.map((starter) => (
              <button key={starter.name} type="button" disabled={props.mutationDisabled} onClick={() => props.onStarterSelect?.(starter)}>{starter.name}</button>
            ))}
          </div>
        ) : null}
        {props.mode !== "new" ? <Button type="button" variant="ghost" data-danger="true" disabled={props.saving || props.deleteDisabled || props.mutationDisabled} title={props.mutationDisabled ? "连接外部后台时暂不支持修改模板" : props.deleteDisabled ? props.deleteDisabledReason ?? "每类至少保留一个模板" : undefined} onClick={props.onDelete}>删除</Button> : null}
        {props.mode !== "new" ? <Button type="button" disabled={props.saving || invalid || props.mutationDisabled} onClick={props.onDuplicate}>另存新模板</Button> : null}
        <Button type="button" variant="primary" disabled={props.saving || invalid || props.mutationDisabled} title={props.mutationDisabled ? "连接外部后台时暂不支持修改模板" : undefined} onClick={props.onSave}>保存</Button>
      </div>
    </div>
  );
}

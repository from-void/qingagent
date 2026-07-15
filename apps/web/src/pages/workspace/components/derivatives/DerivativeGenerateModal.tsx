import { Button } from "@qingagent/ui-kit";
import type { StyleTemplateItem } from "@qingagent/contract-ts";
import { useEffect, useState } from "react";
import { buildTemplateSummary, DERIVATIVE_STARTER_PRESETS, LaunchModalShell, SupplementField, TemplateEditorPage, TemplateGroup, type TemplateEditorMode } from "../launchModal";
import type { ServerStream } from "../../data/serverStream";
import type { DtypeDescriptor } from "./dtypeRegistry";

export interface DerivativeGenerateParams {
  templateId: string;
  writingStyleId: string;
  layoutStyleId: string | null;
  targetLanguages?: string[];
  privatePrompt: string;
}

export const TRANSLATION_LANGUAGES = [
  "英语", "日语", "韩语", "繁体中文", "法语", "德语", "西班牙语", "葡萄牙语", "意大利语", "俄语",
  "阿拉伯语", "泰语", "越南语", "印尼语", "马来语", "印地语", "土耳其语", "荷兰语", "波兰语", "瑞典语",
] as const;
export const MAX_TRANSLATION_LANGUAGES = 5;

type StyleSlot = "layout" | "writing";
type EditorState = { id?: string; slot: StyleSlot; name: string; detail: string; prompt: string };

const DERIVATIVE_LAUNCH_META = {
  gzh: {
    subtitle: "把主文档改写成适合公众号发布的文章",
    supplementPlaceholder: "这篇想怎么写，例如：语气更克制，保留原文案例",
  },
  xhs: {
    subtitle: "把主文档改写成小红书风格的笔记",
    supplementPlaceholder: "这篇想怎么写，例如：语气再活泼一点，多用短句",
  },
  translate: {
    subtitle: "把主文档翻译成其他语言",
    supplementPlaceholder: "这篇翻译要注意什么，例如：产品名保留英文不译",
  },
} as const;

const DERIVATIVE_EDITOR_PLACEHOLDERS = {
  writing: {
    name: "给风格起个名，例如：热点借势评论",
    prompt: "描述这类稿子怎么写：开头怎么起、正文什么结构、语气什么样、结尾怎么收",
  },
  layout: {
    name: "给风格起个名，例如：热点借势评论",
    prompt: "描述排版规则：小标题、段落长度、加粗和分隔的用法",
  },
} as const;

function deleteErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "模板删除失败，请重试";
}

export function DerivativeGenerateModal(props: {
  open: boolean;
  descriptor: DtypeDescriptor;
  sessionId: string;
  stream: ServerStream;
  initial: Pick<DerivativeGenerateParams, "templateId" | "privatePrompt"> & Partial<Pick<DerivativeGenerateParams, "writingStyleId" | "layoutStyleId" | "targetLanguages">>;
  singleTargetLang?: string;
  submitting?: boolean;
  onClose: () => void;
  onGenerate: (params: DerivativeGenerateParams) => void | Promise<void>;
}) {
  const [templates, setTemplates] = useState<StyleTemplateItem[]>([]);
  const [writingStyleId, setWritingStyleId] = useState(props.initial.writingStyleId ?? props.initial.templateId);
  const [layoutStyleId, setLayoutStyleId] = useState<string | null>(props.initial.layoutStyleId ?? null);
  const [privatePrompt, setPrivatePrompt] = useState(props.initial.privatePrompt);
  const [targetLanguages, setTargetLanguages] = useState<string[]>(props.initial.targetLanguages ?? (props.descriptor.dtype === "translate" ? ["英语"] : []));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!props.open) return;
    let current = true;
    setWritingStyleId(props.initial.writingStyleId ?? props.initial.templateId);
    setLayoutStyleId(props.descriptor.dtype === "gzh" ? props.initial.layoutStyleId ?? null : null);
    setPrivatePrompt(props.initial.privatePrompt);
    setTargetLanguages(props.singleTargetLang ? [props.singleTargetLang] : props.initial.targetLanguages ?? (props.descriptor.dtype === "translate" ? ["英语"] : []));
    setEditor(null);
    setError("");
    setLoading(true);
    void props.stream.listStyleTemplates(props.sessionId, props.descriptor.dtype).then((items) => {
      if (!current) return;
      setTemplates(items);
      const writingId = props.initial.writingStyleId ?? props.initial.templateId;
      setWritingStyleId(items.some((item) => item.slot === "writing" && item.id === writingId) ? writingId : items.find((item) => item.slot === "writing")?.id ?? writingId);
      if (props.descriptor.dtype === "gzh") {
        const requested = props.initial.layoutStyleId;
        setLayoutStyleId(requested && items.some((item) => item.slot === "layout" && item.id === requested) ? requested : items.find((item) => item.slot === "layout")?.id ?? null);
      }
    }).catch(() => { if (current) setError("风格模板读取失败，请重试"); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [props.descriptor.dtype, props.initial.layoutStyleId, props.initial.privatePrompt, props.initial.targetLanguages, props.initial.templateId, props.initial.writingStyleId, props.open, props.sessionId, props.singleTargetLang, props.stream]);

  const openTemplate = async (item: StyleTemplateItem) => {
    if (item.slot === "instruction") return;
    setError("");
    try {
      const full = await props.stream.getStyleTemplate(props.sessionId, item.id);
      if (full.slot === "instruction") throw new Error("非衍生稿风格模板");
      setEditor({ id: full.id, slot: full.slot, name: full.name, detail: full.detail, prompt: full.prompt });
    } catch { setError("模板读取失败，请重试"); }
  };

  const saveEditor = async (asNew: boolean) => {
    if (!editor || !editor.name.trim() || !editor.prompt.trim()) { setError("模板名和提示词不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      const saved = await props.stream.saveStyleTemplate(props.sessionId, {
        id: asNew ? undefined : editor.id,
        dtype: props.descriptor.dtype,
        slot: editor.slot,
        name: editor.name.trim(),
        detail: editor.detail.trim(),
        prompt: editor.prompt.trim(),
      });
      setTemplates((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      if (saved.slot === "writing") setWritingStyleId(saved.id); else if (saved.slot === "layout") setLayoutStyleId(saved.id);
      setEditor(null);
    } catch { setError("模板保存失败，请重试"); } finally { setSaving(false); }
  };

  const deleteEditor = async () => {
    if (!editor?.id) return;
    setSaving(true);
    setError("");
    try {
      await props.stream.deleteStyleTemplate(props.sessionId, editor.id);
      const remaining = templates.filter((item) => item.id !== editor.id);
      const fallback = remaining.find((item) => item.slot === editor.slot && item.builtin)
        ?? remaining.find((item) => item.slot === editor.slot);
      setTemplates(remaining);
      if (editor.slot === "writing" && writingStyleId === editor.id) setWritingStyleId(fallback?.id ?? "");
      if (editor.slot === "layout" && layoutStyleId === editor.id) setLayoutStyleId(fallback?.id ?? null);
      setEditor(null);
    } catch (deleteError) { setError(deleteErrorMessage(deleteError)); } finally { setSaving(false); }
  };

  if (!props.open) return null;
  const slots: Array<{ slot: StyleSlot; label: string }> = props.descriptor.dtype === "gzh"
    ? [{ slot: "layout", label: "排版风格" }, { slot: "writing", label: "写作风格" }]
    : [{ slot: "writing", label: props.descriptor.dtype === "translate" ? "翻译风格" : "写作风格" }];
  const selectedId = (slot: StyleSlot) => slot === "writing" ? writingStyleId : layoutStyleId;
  const editorMode: TemplateEditorMode = editor?.id ? "existing" : "new";
  const title = editor
    ? editor.id ? "编辑模板" : "新建模板"
    : props.descriptor.dtype === "translate" ? "翻译文档" : `生成${props.descriptor.tabLabel}`;
  const launchMeta = DERIVATIVE_LAUNCH_META[props.descriptor.dtype];

  return (
    <LaunchModalShell
      title={title}
      subtitle={editor ? undefined : launchMeta.subtitle}
      onBack={editor ? () => { setEditor(null); setError(""); } : undefined}
      onClose={props.onClose}
      closeDisabled={props.submitting || saving}
      dataWf="DerivativeGenerateModal"
    >
      {error ? <p className="ws-launch-error" role="alert">{error}</p> : null}
      {editor ? (
        <TemplateEditorPage
          mode={editorMode}
          name={editor.name}
          prompt={editor.prompt}
          placeholders={DERIVATIVE_EDITOR_PLACEHOLDERS[editor.slot]}
          starters={props.descriptor.dtype === "translate" ? [] : DERIVATIVE_STARTER_PRESETS[props.descriptor.dtype][editor.slot] ?? []}
          saving={saving}
          deleteDisabled={templates.filter((item) => item.slot === editor.slot).length <= 1}
          onNameChange={(name) => setEditor((current) => current ? { ...current, name } : current)}
          onPromptChange={(prompt) => setEditor((current) => current ? { ...current, prompt } : current)}
          onStarterSelect={(starter) => setEditor({
            ...editor,
            name: starter.name,
            prompt: starter.prompt,
          })}
          onAiDraft={(intent, abortSignal) => props.stream.draftTemplate({
            sessionId: props.sessionId,
            scene: {
              kind: "derivative",
              dtype: props.descriptor.dtype,
              slot: editor.slot,
              label: `${props.descriptor.tabLabel}·${editor.slot === "writing" ? "写作风格" : "排版风格"}`,
            },
            intent,
          }, abortSignal)}
          onDelete={() => void deleteEditor()}
          onDuplicate={() => void saveEditor(true)}
          onSave={() => void saveEditor(false)}
        />
      ) : (
        <form className="ws-launch-form" onSubmit={(event) => {
          event.preventDefault();
          if (writingStyleId && (props.descriptor.dtype !== "translate" || targetLanguages.length > 0)) void props.onGenerate({ templateId: writingStyleId, writingStyleId, layoutStyleId, privatePrompt, ...(props.descriptor.dtype === "translate" ? { targetLanguages } : {}) });
        }}>
          {props.descriptor.dtype === "translate" ? <section className="ws-translate-language-group" aria-label="目标语言">
            <h3>目标语言</h3>
            <div className="ws-translate-language-chips" role="group" aria-label="目标语言（最多选择 5 种）">
              {TRANSLATION_LANGUAGES.map((language) => {
                const selected = targetLanguages.includes(language);
                const limitReached = !selected && targetLanguages.length >= MAX_TRANSLATION_LANGUAGES;
                const locked = Boolean(props.singleTargetLang && language !== props.singleTargetLang);
                return <button key={language} type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} disabled={limitReached || locked} title={limitReached ? "最多选择 5 种语言" : undefined} onClick={() => setTargetLanguages((current) => selected ? current.filter((item) => item !== language) : [...current, language])}>{language}</button>;
              })}
            </div>
          </section> : null}
          {loading ? <p className="ws-launch-status">正在读取风格模板…</p> : slots.map(({ slot, label }) => {
            const slotTemplates = templates.filter((item) => item.slot === slot);
            return (
              <TemplateGroup
                key={slot}
                label={label}
                ariaLabel={label}
                items={slotTemplates.map((item) => ({
                  id: item.id,
                  name: item.name,
                  summary: buildTemplateSummary(item.detail, item.prompt),
                }))}
                selectedId={selectedId(slot)}
                onSelect={(id) => slot === "writing" ? setWritingStyleId(id) : setLayoutStyleId(id)}
                onEdit={(item) => {
                  const template = slotTemplates.find((candidate) => candidate.id === item.id);
                  if (template) void openTemplate(template);
                }}
                onCreate={() => { setError(""); setEditor({ slot, name: "", detail: "", prompt: "" }); }}
              />
            );
          })}
          <SupplementField
            value={privatePrompt}
            placeholder={launchMeta.supplementPlaceholder}
            disabled={props.submitting}
            onChange={setPrivatePrompt}
          />
          <div className="ws-launch-actions">
            <Button type="button" variant="ghost" disabled={props.submitting} onClick={props.onClose}>取消</Button>
            <Button type="submit" variant="primary" disabled={props.submitting || loading || !writingStyleId || (props.descriptor.dtype === "translate" && targetLanguages.length === 0)}>{props.submitting ? "创建中" : props.descriptor.dtype === "translate" ? "开始翻译" : "生成"}</Button>
          </div>
        </form>
      )}
    </LaunchModalShell>
  );
}

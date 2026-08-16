import { Button } from "@qingagent/ui-kit";
import { appendReviewIgnoreLines, assembleReviewQuery, splitReviewSupplement } from "@qingagent/contract-ts";
import type { ActionCardData, DraftTemplateIntent, DraftTemplateResult, LexiconEntrySummary, LexiconResourceSummary, ReviewContext, ReviewTemplateItem, ReviewType as ContractReviewType } from "@qingagent/contract-ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../../../system";
import { attachCapabilityEnabled } from "../../../system/backendConnectionStore";
import { CaretIcon } from "./icons";
import { buildTemplateSummary, LaunchModalShell, REVIEW_STARTER_PRESETS, SupplementField, TemplateEditorPage, TemplateGroup, type TemplateEditorMode } from "./launchModal";
import { rankRoleReviewTemplates, roleAvatarKind, rolePosition } from "./roleReview";

export type ReviewType = ContractReviewType;

export const REVIEW_META: Record<ReviewType, { title: string; action: string; subtitle: string; supplementPlaceholder: string }> = {
  sensitive: {
    title: "敏感词审查",
    action: "开始审查",
    subtitle: "按所选词库扫描全文，标记并建议替换",
    supplementPlaceholder: "这次审查要特别注意什么，例如：行业黑话不算敏感词，重点看宣传用语",
  },
  deai: {
    title: "去AI味",
    action: "开始处理",
    subtitle: "识别机器腔，把文字改得更像人写的",
    supplementPlaceholder: "这次处理要特别注意什么，例如：保留第一人称口吻，案例部分别改",
  },
  source: {
    title: "来源核查（仅对照已关联素材）",
    action: "开始核查",
    subtitle: "以当前会话素材为依据，不联网",
    supplementPlaceholder: "这次核查要特别注意什么，例如：重点核对数据和引述，标题不用查",
  },
  consistency: {
    title: "一致性审查",
    action: "开始审查",
    subtitle: "检查全文时间线、数字与称谓是否自洽",
    supplementPlaceholder: "这次审查要特别注意什么，例如：重点核对时间线，产品名以正文第一次出现为准",
  },
  privacy: {
    title: "隐私泄露审查",
    action: "开始审查",
    subtitle: "发布前检查个人与内部信息泄露",
    supplementPlaceholder: "这次审查要特别注意什么，例如：客户名可以保留，内部项目代号要脱敏",
  },
  format: {
    title: "格式规范审查",
    action: "开始审查",
    subtitle: "检查标题层级、标点与数字格式",
    supplementPlaceholder: "这次审查要特别注意什么，例如：数字统一用阿拉伯数字",
  },
  role: {
    title: "角色审查",
    action: "开始审查",
    subtitle: "请一位虚拟角色来审这篇文档",
    supplementPlaceholder: "这次审查要特别注意什么，例如：重点看上线风险和数据口径",
  },
  custom: {
    title: "自定义审查",
    action: "开始审查",
    subtitle: "用你自己的模板定义审查逻辑",
    supplementPlaceholder: "这次审查要特别注意什么",
  },
};

const REVIEW_EDITOR_PLACEHOLDERS = {
  name: "给模板起个名，例如：投资人视角挑刺",
  prompt: "像交代同事一样写：先说以什么身份/立场看稿，再列要逐项检查什么，最后说怎么给修改建议",
} as const;

function deleteErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "模板删除失败，请重试";
}

export interface ReviewLaunchConfig {
  items: ReviewTemplateItem[];
  selectedTemplateId: string | null;
}

export function buildReviewContext(
  type: ReviewType,
  template: Pick<ReviewTemplateItem, "id" | "name">,
): ReviewContext {
  return { type, templateId: template.id, templateName: template.name };
}

interface ReviewLaunchModalProps {
  open: boolean;
  type: ReviewType;
  documentTitle?: string;
  documentText?: string;
  loadTemplates: (type: ReviewType) => Promise<ReviewLaunchConfig>;
  saveTemplate: (input: { id?: string; type: ReviewType; name: string; prompt: string }) => Promise<ReviewTemplateItem>;
  deleteTemplate: (id: string) => Promise<string | null>;
  selectTemplate: (type: ReviewType, templateId: string) => Promise<void>;
  loadSupplement: (type: ReviewType, templateId?: string) => Promise<string>;
  saveSupplement: (type: ReviewType, supplement: string, templateId?: string) => Promise<string>;
  loadLexicons?: () => Promise<LexiconResourceSummary[]>;
  saveLexiconSelection?: (enabledLexiconIds: string[]) => Promise<LexiconResourceSummary[]>;
  loadLexiconEntries?: (resourceId: string) => Promise<LexiconEntrySummary[]>;
  onAiDraft?: (intent: DraftTemplateIntent, abortSignal: AbortSignal) => Promise<DraftTemplateResult>;
  sourceMaterialAvailable?: boolean;
  onAddMaterial?: () => void;
  onClose: () => void;
  onConfirm: (template: ReviewTemplateItem, supplement: string, lexicons: LexiconResourceSummary[]) => void;
}

function oneLine(text: string, max = 52): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildReviewQuery(
  type: ReviewType,
  template: Pick<ReviewTemplateItem, "id" | "name" | "prompt">,
  supplement: string,
  lexicons: Pick<LexiconResourceSummary, "id" | "name">[] = [],
): string {
  return assembleReviewQuery(type, template, supplement, lexicons);
}

export function buildReviewActionCard(
  type: ReviewType,
  templateName: string,
  supplement: string,
): ActionCardData {
  const supplementParts = splitReviewSupplement(supplement);
  const visibleSupplement = supplementParts.hasManagedSection
    ? supplementParts.userText
    : supplement;
  return {
    title: REVIEW_META[type].title,
    lines: [
      { label: "模板", value: templateName },
      ...(visibleSupplement.trim()
        ? [{ label: "补充", value: oneLine(visibleSupplement) }]
        : []),
    ],
    status: "running",
  };
}

type ReviewPage = "launch" | "template" | "lexicons" | "entries";
type ReviewEditor = { source: ReviewTemplateItem | null; name: string; prompt: string };

export function ReviewLaunchModal(props: ReviewLaunchModalProps) {
  const confirm = useConfirm();
  const templateMutationEnabled = attachCapabilityEnabled("templateMutation");
  const lexiconMutationEnabled = attachCapabilityEnabled("lexiconMutation");
  const meta = REVIEW_META[props.type];
  const [templates, setTemplates] = useState<ReviewTemplateItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [supplement, setSupplement] = useState("");
  const [lexicons, setLexicons] = useState<LexiconResourceSummary[]>([]);
  const [selectedLexicons, setSelectedLexicons] = useState<Set<string>>(new Set());
  const [page, setPage] = useState<ReviewPage>("launch");
  const [editor, setEditor] = useState<ReviewEditor | null>(null);
  const [activeLexicon, setActiveLexicon] = useState<LexiconResourceSummary | null>(null);
  const [entries, setEntries] = useState<LexiconEntrySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [supplementLoading, setSupplementLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const templateSelectionEpochRef = useRef(0);
  const confirmedTemplateIdRef = useRef("");
  const loadedSupplementRef = useRef("");

  useEffect(() => {
    if (!props.open) return;
    const requestId = ++requestRef.current;
    templateSelectionEpochRef.current += 1;
    setLoading(true);
    setSupplementLoading(false);
    setError(null);
    loadedSupplementRef.current = "";
    setSupplement("");
    setPage("launch");
    setEditor(null);
    const lexiconTask = props.type === "sensitive" && props.loadLexicons ? props.loadLexicons() : Promise.resolve([]);
    void props.loadTemplates(props.type)
      .then(async (config) => {
        const selected = config.items.some((item) => item.id === config.selectedTemplateId)
          ? config.selectedTemplateId!
          : config.items[0]?.id ?? "";
        const [savedSupplement, availableLexicons] = await Promise.all([
          props.loadSupplement(props.type, selected || undefined),
          lexiconTask,
        ]);
        return { config, selected, savedSupplement, availableLexicons };
      })
      .then(({ config, selected, savedSupplement, availableLexicons }) => {
        if (requestRef.current !== requestId) return;
        setTemplates(config.items);
        confirmedTemplateIdRef.current = selected;
        setSelectedId(selected);
        loadedSupplementRef.current = savedSupplement;
        const supplementParts = splitReviewSupplement(savedSupplement);
        setSupplement(supplementParts.hasManagedSection
          ? supplementParts.userText
          : savedSupplement);
        setLexicons(availableLexicons);
        setSelectedLexicons(new Set(
          availableLexicons.filter((item) => item.enabled !== false).map((item) => item.id),
        ));
      })
      .catch(() => { if (requestRef.current === requestId) setError("审查设置加载失败，请重试"); })
      .finally(() => { if (requestRef.current === requestId) setLoading(false); });
  }, [props.open, props.type, props.loadLexicons, props.loadSupplement, props.loadTemplates]);

  const roleRanking = useMemo(
    () => props.type === "role"
      ? rankRoleReviewTemplates(templates, props.documentTitle ?? "", props.documentText ?? "")
      : [],
    [props.documentText, props.documentTitle, props.type, templates],
  );

  if (!props.open) return null;
  const selected = templates.find((item) => item.id === selectedId) ?? null;
  const editorMode: TemplateEditorMode = editor?.source ? "existing" : "new";
  const sourceBlocked = props.type === "source" && props.sourceMaterialAvailable === false;

  const openTemplate = (template: ReviewTemplateItem) => {
    if (!templateMutationEnabled) return;
    setEditor({ source: template, name: template.name, prompt: template.prompt });
    setPage("template");
    setError(null);
  };
  const openNewTemplate = () => {
    if (!templateMutationEnabled) return;
    setEditor({ source: null, name: "", prompt: "" });
    setPage("template");
    setError(null);
  };
  const chooseTemplate = (id: string) => {
    const selectionEpoch = ++templateSelectionEpochRef.current;
    const previousId = confirmedTemplateIdRef.current;
    const previousSupplement = supplement;
    const previousLoadedSupplement = loadedSupplementRef.current;
    setSelectedId(id);
    setError(null);
    setSupplementLoading(true);
    void Promise.all([
      props.selectTemplate(props.type, id),
      props.loadSupplement(props.type, id),
    ])
      .then(([, savedSupplement]) => {
        if (templateSelectionEpochRef.current !== selectionEpoch) return;
        confirmedTemplateIdRef.current = id;
        loadedSupplementRef.current = savedSupplement;
        const supplementParts = splitReviewSupplement(savedSupplement);
        setSupplement(supplementParts.hasManagedSection
          ? supplementParts.userText
          : savedSupplement);
      })
      .catch(() => {
        if (templateSelectionEpochRef.current !== selectionEpoch) return;
        setSelectedId(previousId);
        setSupplement(previousSupplement);
        loadedSupplementRef.current = previousLoadedSupplement;
        setError("模板选择保存失败，请重试");
      })
      .finally(() => {
        if (templateSelectionEpochRef.current === selectionEpoch) setSupplementLoading(false);
      });
  };
  const storeTemplate = (id?: string) => {
    if (!editor || !templateMutationEnabled) return;
    setSaving(true);
    setError(null);
    void props.saveTemplate({ ...(id ? { id } : {}), type: props.type, name: editor.name.trim(), prompt: editor.prompt.trim() }).then(async (saved) => {
      setTemplates((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      if (!id) {
        setSelectedId(saved.id);
        setEditor({ source: saved, name: saved.name, prompt: saved.prompt });
        const selectionEpoch = ++templateSelectionEpochRef.current;
        try {
          await props.selectTemplate(props.type, saved.id);
          const savedSupplement = await props.loadSupplement(props.type, saved.id);
          confirmedTemplateIdRef.current = saved.id;
          loadedSupplementRef.current = savedSupplement;
          const supplementParts = splitReviewSupplement(savedSupplement);
          setSupplement(supplementParts.hasManagedSection
            ? supplementParts.userText
            : savedSupplement);
        } catch {
          setEditor(null);
          setPage("launch");
          if (templateSelectionEpochRef.current === selectionEpoch) {
            setError("模板已保存，但设为默认失败，请再次选择");
          }
          return;
        }
      }
      setEditor(null);
      setPage("launch");
    }).catch(() => setError(id ? "模板保存失败，请重试" : "模板另存失败，请重试")).finally(() => setSaving(false));
  };
  const removeTemplate = async () => {
    if (!editor?.source || !templateMutationEnabled) return;
    const template = editor.source;
    const confirmed = await confirm({
      title: "删除这个审查模板?",
      subject: template.name,
      message: "删除后不可恢复",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    void props.deleteTemplate(template.id).then(async (nextSelectedId) => {
      const remaining = templates.filter((item) => item.id !== template.id);
      const selectedAfterDelete =
        nextSelectedId ?? remaining.find((item) => item.builtin)?.id ?? remaining[0]?.id ?? "";
      const savedSupplement = await props.loadSupplement(
        props.type,
        selectedAfterDelete || undefined,
      );
      setTemplates(remaining);
      confirmedTemplateIdRef.current = selectedAfterDelete;
      setSelectedId(selectedAfterDelete);
      loadedSupplementRef.current = savedSupplement;
      const supplementParts = splitReviewSupplement(savedSupplement);
      setSupplement(supplementParts.hasManagedSection
        ? supplementParts.userText
        : savedSupplement);
      setEditor(null);
      setPage("launch");
    }).catch((deleteError) => setError(deleteErrorMessage(deleteError))).finally(() => setSaving(false));
  };
  const duplicateTemplate = () => {
    if (!editor) return;
    storeTemplate();
  };
  const showEntries = (lexicon: LexiconResourceSummary) => {
    if (!props.loadLexiconEntries) return;
    const requestId = ++requestRef.current;
    setActiveLexicon(lexicon);
    setEntries([]);
    setError(null);
    setLoading(true);
    setPage("entries");
    void props.loadLexiconEntries(lexicon.id).then((items) => {
      if (requestRef.current === requestId) setEntries(items);
    }).catch(() => {
      if (requestRef.current === requestId) setError("词条加载失败，请重试");
    }).finally(() => {
      if (requestRef.current === requestId) setLoading(false);
    });
  };
  const saveLexiconSelection = () => {
    if (!props.saveLexiconSelection || !lexiconMutationEnabled) {
      setError("词库设置保存失败，请重试");
      return;
    }
    const enabledLexiconIds = lexicons
      .filter((item) => selectedLexicons.has(item.id))
      .map((item) => item.id);
    setSaving(true);
    setError(null);
    void props.saveLexiconSelection(enabledLexiconIds).then((savedLexicons) => {
      setLexicons(savedLexicons);
      setSelectedLexicons(new Set(
        savedLexicons.filter((item) => item.enabled).map((item) => item.id),
      ));
      setPage("launch");
    }).catch(() => setError("词库设置保存失败，请重试")).finally(() => setSaving(false));
  };

  const title = page === "template"
    ? editor?.source ? "编辑模板" : "新建模板"
    : page === "lexicons" ? "管理敏感词词库"
      : page === "entries" ? activeLexicon?.name ?? "词库"
        : meta.title;
  const back = page === "launch" ? undefined : () => {
    setError(null);
    if (page === "entries") setPage("lexicons");
    else {
      if (page === "lexicons") {
        setSelectedLexicons(new Set(
          lexicons.filter((item) => item.enabled !== false).map((item) => item.id),
        ));
      }
      setEditor(null);
      setPage("launch");
    }
  };

  return (
    <LaunchModalShell title={title} subtitle={page === "launch" ? meta.subtitle : undefined} onBack={back} onClose={props.onClose} closeDisabled={saving} dataWf="ReviewLaunchModal">
      {error ? <p className="ws-launch-error" role="alert">{error}</p> : null}
      {page === "launch" ? (
        <div className="ws-launch-content">
          <TemplateGroup
            label={props.type === "role" ? "审查角色" : "审查模板"}
            ariaLabel={props.type === "role" ? "审查角色" : "审查模板"}
            variant={props.type === "role" ? "portrait" : "default"}
            items={(props.type === "role" ? roleRanking : templates.map((template) => ({
              template,
              score: null,
            }))).map(({ template, score }) => ({
              id: template.id,
              name: template.name,
              summary: buildTemplateSummary("", template.prompt),
              portraitDetail: rolePosition(template.id),
              avatarKind: roleAvatarKind(template.id),
              recommended: score?.recommended ?? false,
            }))}
            selectedId={selectedId}
            disabled={loading}
            mutationDisabled={!templateMutationEnabled}
            onSelect={chooseTemplate}
            onEdit={(item) => {
              const template = templates.find((candidate) => candidate.id === item.id);
              if (template) openTemplate(template);
            }}
            onCreate={openNewTemplate}
          />
          {props.type === "sensitive" ? (
            <div className="ws-launch-resource-row">
              <span>已启用 {selectedLexicons.size} 个词库</span>
              <button type="button" className="ws-launch-link" onClick={() => setPage("lexicons")}>管理词库<CaretIcon size={12} direction="right" /></button>
            </div>
          ) : null}
          {sourceBlocked ? (
            <div className="ws-launch-resource-row ws-launch-source-blocked" role="status">
              <span>当前没有可对照素材，请先添加素材</span>
              <button type="button" className="ws-launch-link" onClick={props.onAddMaterial}>添加素材<CaretIcon size={12} direction="right" /></button>
            </div>
          ) : null}
          <SupplementField value={supplement} placeholder={meta.supplementPlaceholder} disabled={loading || supplementLoading} onChange={setSupplement} />
          <div className="ws-launch-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={props.onClose}>取消</Button>
            <Button type="button" variant="primary" disabled={loading || supplementLoading || saving || !selected || sourceBlocked || (props.type === "sensitive" && selectedLexicons.size === 0)} onClick={() => {
              if (!selected) return;
              const loadedParts = splitReviewSupplement(loadedSupplementRef.current);
              const fullSupplement = loadedParts.hasManagedSection
                ? appendReviewIgnoreLines(supplement, loadedParts.ignoreLines)
                : supplement;
              setSaving(true);
              setError(null);
              void Promise.all([
                props.selectTemplate(props.type, selected.id),
                props.saveSupplement(props.type, fullSupplement, selected.id),
              ]).then(([, savedSupplement]) => props.onConfirm(
                selected,
                savedSupplement,
                lexicons.filter((item) => selectedLexicons.has(item.id)),
              ))
                .catch(() => setError("审查设置保存失败，请重试"))
                .finally(() => setSaving(false));
            }}>{saving ? "正在保存…" : meta.action}</Button>
          </div>
        </div>
      ) : null}
      {page === "template" && editor ? (
        <TemplateEditorPage
          mode={editorMode}
          name={editor.name}
          prompt={editor.prompt}
          placeholders={REVIEW_EDITOR_PLACEHOLDERS}
          starters={REVIEW_STARTER_PRESETS[props.type]}
          saving={saving}
          mutationDisabled={!templateMutationEnabled}
          deleteDisabled={templates.length <= 1}
          onNameChange={(name) => setEditor((current) => current ? { ...current, name } : current)}
          onPromptChange={(prompt) => setEditor((current) => current ? { ...current, prompt } : current)}
          onStarterSelect={(starter) => setEditor({ ...editor, name: starter.name, prompt: starter.prompt })}
          onAiDraft={props.onAiDraft ? async (intent, abortSignal) => props.onAiDraft!(intent, abortSignal) : undefined}
          onDelete={removeTemplate}
          onDuplicate={duplicateTemplate}
          onSave={() => storeTemplate(editor.source?.id)}
        />
      ) : null}
      {page === "lexicons" ? (
        <>
          <div className="ws-lexicon-list">
            {lexicons.map((lexicon) => (
              <div className="ws-lexicon-option" key={lexicon.id}>
                <label className="ws-lexicon-check" aria-label={`启用${lexicon.name}`}>
                  <input className="wf-checkbox" type="checkbox" disabled={saving || !lexiconMutationEnabled} checked={selectedLexicons.has(lexicon.id)} onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedLexicons((current) => {
                      const next = new Set(current);
                      if (checked) next.add(lexicon.id); else next.delete(lexicon.id);
                      return next;
                    });
                  }} />
                </label>
                <button type="button" className="ws-lexicon-open" onClick={() => showEntries(lexicon)}>
                  <span className="ws-lexicon-copy"><strong>{lexicon.name}</strong><small>{lexicon.description}</small></span>
                  <small>{lexicon.entryCount} 词</small>
                  <span className="ws-lexicon-chevron"><CaretIcon size={15} direction="right" /></span>
                </button>
              </div>
            ))}
          </div>
          <div className="ws-launch-actions"><Button type="button" variant="primary" disabled={saving || !lexiconMutationEnabled} title={lexiconMutationEnabled ? undefined : "连接外部后台时暂不支持修改词库"} onClick={saveLexiconSelection}>{saving ? "正在保存…" : "完成"}</Button></div>
        </>
      ) : null}
      {page === "entries" ? (
        <div className="ws-lexicon-entry-list" aria-busy={loading}>
          {loading ? <p className="ws-lexicon-empty">正在读取词条…</p> : entries.map((entry, index) => (
            <div className="ws-lexicon-entry" key={`${entry.word}-${index}`} title={entry.note ?? undefined}>
              <span className="ws-lexicon-word">{entry.word}</span>
              {entry.replacement ? <span className="ws-lexicon-replacement">→ {entry.replacement}</span> : <span className="ws-lexicon-mark-only">仅标记</span>}
            </div>
          ))}
        </div>
      ) : null}
    </LaunchModalShell>
  );
}

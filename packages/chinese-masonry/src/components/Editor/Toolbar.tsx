import { useEffect, useMemo, useState } from 'react';
import type { GlobalFontConfig, TemplateDefinition } from '../../templates/types';
import { withTemplateTextCapacity } from '../../templates/capacity';
import { useHistory } from './hooks/useHistory';
import { useEditorStore } from './store';

interface ToolbarProps {
  onSave?: (template: TemplateDefinition) => void;
}

const englishFonts = [
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Times New Roman', value: '"Times New Roman"' },
  { label: 'Inter', value: 'Inter' },
  { label: 'System UI', value: 'system-ui' },
];

const chineseFonts = [
  { label: 'Noto Serif SC', value: '"Noto Serif SC"' },
  { label: 'Noto Sans SC', value: '"Noto Sans SC"' },
  { label: 'LXGW WenKai', value: '"LXGW WenKai"' },
  { label: 'STKaiti / KaiTi', value: 'STKaiti, KaiTi' },
  { label: 'STSong / SimSun', value: 'STSong, SimSun' },
  { label: 'Microsoft YaHei', value: '"Microsoft YaHei"' },
];

function fontFamily(englishFont: string, chineseFont: string, fallback: 'serif' | 'sans-serif') {
  return `${englishFont}, ${chineseFont}, ${fallback}`;
}

function patchFontConfig(config: GlobalFontConfig, patch: Partial<GlobalFontConfig>): Partial<GlobalFontConfig> {
  const next = { ...config, ...patch };
  return {
    ...patch,
    titleFont: fontFamily(next.titleEnglishFont ?? 'Georgia', next.titleChineseFont ?? '"Noto Serif SC"', 'serif'),
    descriptionFont: fontFamily(
      next.descriptionEnglishFont ?? 'Inter',
      next.descriptionChineseFont ?? '"Noto Sans SC"',
      'sans-serif',
    ),
  };
}

export function Toolbar({ onSave }: ToolbarProps) {
  const [fontOpen, setFontOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const template = useEditorStore((state) => state.template);
  const fontConfig = useEditorStore((state) => state.fontConfig);
  const exportedJson = useEditorStore((state) => state.exportedJson);
  const createTemplate = useEditorStore((state) => state.createTemplate);
  const updateCard = useEditorStore((state) => state.updateCard);
  const updateFontConfig = useEditorStore((state) => state.updateFontConfig);
  const exportJson = useEditorStore((state) => state.exportJson);
  const importJson = useEditorStore((state) => state.importJson);
  const { undo, redo, canUndo, canRedo } = useHistory();
  const [heightDraft, setHeightDraft] = useState(String(template.height));
  const [radiusDraft, setRadiusDraft] = useState(template.borderRadius ?? '6px');

  useEffect(() => {
    setHeightDraft(String(template.height));
    setRadiusDraft(template.borderRadius ?? '6px');
  }, [template.height, template.borderRadius]);

  const jsonValue = useMemo(() => exportedJson || JSON.stringify(template, null, 2), [exportedJson, template]);

  const commitHeight = (value: string) => {
    if (!value.trim()) {
      setHeightDraft(String(template.height));
      return;
    }
    const next = Number(value);
    if (Number.isFinite(next)) updateCard({ height: next });
  };

  return (
    <header className="cm-editor-toolbar">
      <button type="button" onClick={createTemplate}>
        新建模板
      </button>
      <button
        type="button"
        onClick={() => {
          commitHeight(heightDraft);
          onSave?.(withTemplateTextCapacity(useEditorStore.getState().template));
        }}
      >
        保存模板
      </button>
      <button type="button" onClick={undo} disabled={!canUndo}>
        撤销
      </button>
      <button type="button" onClick={redo} disabled={!canRedo}>
        重做
      </button>
      <button type="button" onClick={() => setFontOpen((value) => !value)} aria-expanded={fontOpen}>
        全局字体
      </button>
      <label className="cm-editor-toolbar-field">
        <span>卡片高度</span>
        <input
          aria-label="卡片高度"
          type="number"
          min={180}
          max={720}
          value={heightDraft}
          onChange={(event) => {
            const next = event.target.value;
            setHeightDraft(next);
          }}
          onBlur={() => commitHeight(heightDraft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitHeight(heightDraft);
          }}
        />
      </label>
      <label className="cm-editor-toolbar-field">
        <span>圆角</span>
        <input
          aria-label="圆角"
          value={radiusDraft}
          onChange={(event) => {
            setRadiusDraft(event.target.value);
            updateCard({ borderRadius: event.target.value });
          }}
        />
      </label>
      <label className="cm-editor-toolbar-field">
        <span>背景色</span>
        <input
          aria-label="背景色"
          type="color"
          value={template.backgroundColor ?? '#f5f0e8'}
          onChange={(event) => updateCard({ backgroundColor: event.target.value })}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          exportJson();
          setJsonOpen((value) => !value);
        }}
        aria-expanded={jsonOpen}
      >
        JSON
      </button>

      {fontOpen ? (
        <div className="cm-editor-popover" role="dialog" aria-label="全局字体设置">
          <label>
            <span>标题英文字体</span>
            <select
              value={fontConfig.titleEnglishFont ?? 'Georgia'}
              onChange={(event) =>
                updateFontConfig(patchFontConfig(fontConfig, { titleEnglishFont: event.target.value }))
              }
            >
              {englishFonts.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>标题中文字体</span>
            <select
              value={fontConfig.titleChineseFont ?? '"Noto Serif SC"'}
              onChange={(event) =>
                updateFontConfig(patchFontConfig(fontConfig, { titleChineseFont: event.target.value }))
              }
            >
              {chineseFonts.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>描述英文字体</span>
            <select
              value={fontConfig.descriptionEnglishFont ?? 'Inter'}
              onChange={(event) =>
                updateFontConfig(patchFontConfig(fontConfig, { descriptionEnglishFont: event.target.value }))
              }
            >
              {englishFonts.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>描述中文字体</span>
            <select
              value={fontConfig.descriptionChineseFont ?? '"Noto Sans SC"'}
              onChange={(event) =>
                updateFontConfig(patchFontConfig(fontConfig, { descriptionChineseFont: event.target.value }))
              }
            >
              {chineseFonts.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {jsonOpen ? (
        <form
          className="cm-editor-import"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            importJson(String(formData.get('json') ?? ''));
          }}
        >
          <textarea name="json" aria-label="模板 JSON" defaultValue={jsonValue} />
          <div className="cm-editor-json-actions">
            <button type="button" onClick={exportJson}>
              刷新导出
            </button>
            <button type="submit">应用导入</button>
          </div>
        </form>
      ) : null}
    </header>
  );
}

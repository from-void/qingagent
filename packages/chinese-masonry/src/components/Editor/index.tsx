import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ArticleData, TemplateDefinition } from '../../templates/types';
import { withTemplateTextCapacity } from '../../templates/capacity';
import { Canvas } from './Canvas';
import { ElementControls } from './ElementControls';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { defaultSampleArticle, useEditorStore } from './store';
import './editor.css';

export interface TemplateEditorProps {
  initialTemplate: TemplateDefinition;
  sampleArticle?: ArticleData;
  onSave?: (template: TemplateDefinition) => void;
  onChange?: (template: TemplateDefinition) => void;
  className?: string;
  style?: CSSProperties;
}

export function TemplateEditor({
  initialTemplate,
  sampleArticle = defaultSampleArticle,
  onSave,
  onChange,
  className,
  style,
}: TemplateEditorProps) {
  const loadTemplate = useEditorStore((state) => state.loadTemplate);
  const template = useEditorStore((state) => state.template);
  const [selectionChromeHidden, setSelectionChromeHidden] = useState(false);
  const selectionChromeTimer = useRef<number | null>(null);

  useEffect(() => {
    loadTemplate(initialTemplate, sampleArticle);
  }, [initialTemplate, loadTemplate, sampleArticle]);

  useEffect(() => {
    onChange?.(withTemplateTextCapacity(template));
  }, [onChange, template]);

  useEffect(() => {
    const hideSelectionChromeTemporarily = () => {
      setSelectionChromeHidden(true);
      if (selectionChromeTimer.current !== null) {
        window.clearTimeout(selectionChromeTimer.current);
      }
      selectionChromeTimer.current = window.setTimeout(() => {
        setSelectionChromeHidden(false);
        selectionChromeTimer.current = null;
      }, 700);
    };

    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          useEditorStore.getState().redo();
        } else {
          useEditorStore.getState().undo();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        useEditorStore.getState().redo();
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return;
      const deltaByKey: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      const delta = deltaByKey[event.key];
      if (!delta) return;
      const { selectedId, recordHistory, nudgeElement } = useEditorStore.getState();
      if (!selectedId) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      recordHistory();
      nudgeElement(selectedId, delta[0] * step, delta[1] * step);
      hideSelectionChromeTemporarily();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (selectionChromeTimer.current !== null) {
        window.clearTimeout(selectionChromeTimer.current);
      }
    };
  }, []);

  return (
    <div className={`cm-template-editor ${className ?? ''}`} style={style}>
      <Toolbar onSave={onSave} />
      <div className="cm-editor-body">
        <ElementControls />
        <Canvas selectionChromeHidden={selectionChromeHidden} />
        <PropertiesPanel />
      </div>
      <footer className="cm-editor-status">
        <span>模板: {template.id}</span>
        <span>
          {template.width} x {template.height}px
        </span>
      </footer>
    </div>
  );
}

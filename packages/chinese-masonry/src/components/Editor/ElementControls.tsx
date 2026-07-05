import type { ImageElement, TemplateElement, TextElement } from '../../templates/types';
import { useEditorStore } from './store';

function hasElement(elements: TemplateElement[], role: 'hero' | 'title' | 'description' | 'stamp') {
  if (role === 'hero') return elements.some((element) => element.type === 'image' && element.source === 'dynamic');
  if (role === 'stamp') return elements.some((element) => element.type === 'image' && element.role === 'stamp');
  return elements.some((element) => element.type === 'text' && element.role === role);
}

function getDecorationLabel(element: TextElement, index: number) {
  if (element.content === '\u201c') return `左引号-${index + 1}`;
  return `文字装饰-${index + 1}`;
}

export function ElementControls() {
  const template = useEditorStore((state) => state.template);
  const selectedId = useEditorStore((state) => state.selectedId);
  const selectElement = useEditorStore((state) => state.selectElement);
  const toggleContentElement = useEditorStore((state) => state.toggleContentElement);
  const addBackgroundImage = useEditorStore((state) => state.addBackgroundImage);
  const addLine = useEditorStore((state) => state.addLine);
  const deleteElement = useEditorStore((state) => state.deleteElement);

  const backgroundImages = template.elements.filter(
    (element): element is ImageElement =>
      element.type === 'image' && element.source === 'static' && element.role !== 'stamp',
  );
  const decorations = template.elements.filter(
    (element): element is TextElement => element.type === 'text' && element.role === 'decoration',
  );
  const lines = template.elements.filter((element) => element.type === 'line');

  return (
    <aside className="cm-editor-left" aria-label="元素控制面板">
      <h3>内容元素</h3>
      {[
        ['hero', '首图', '图'],
        ['title', '标题', 'T'],
        ['description', '摘要', 'T'],
        ['stamp', '印章', '印'],
      ].map(([role, label, icon]) => (
        <label key={role} className="cm-editor-check-row">
          <input
            type="checkbox"
            aria-label={`显示${label}`}
            checked={hasElement(template.elements, role as 'hero' | 'title' | 'description' | 'stamp')}
            onChange={(event) =>
              toggleContentElement(role as 'hero' | 'title' | 'description' | 'stamp', event.target.checked)
            }
          />
          <span className="cm-editor-icon">{icon}</span>
          <span className="cm-editor-check-label">{label}</span>
        </label>
      ))}

      <div className="cm-editor-panel-section">
        <div className="cm-editor-section-title">背景图片</div>
        {backgroundImages.map((element, index) => (
          <div
            key={element.id}
            className={`cm-editor-list-row ${selectedId === element.id ? 'active' : ''}`}
            onClick={() => selectElement(element.id)}
          >
            <span>背景图-{index + 1}</span>
            <button
              type="button"
              aria-label={`删除背景图-${index + 1}`}
              onClick={(event) => {
                event.stopPropagation();
                deleteElement(element.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="cm-editor-secondary" onClick={addBackgroundImage}>
          添加图片
        </button>
      </div>

      {decorations.length ? (
        <div className="cm-editor-panel-section">
          <div className="cm-editor-section-title">文字装饰</div>
          {decorations.map((element, index) => (
            <div
              key={element.id}
              className={`cm-editor-list-row ${selectedId === element.id ? 'active' : ''}`}
              onClick={() => selectElement(element.id)}
            >
              <span>{getDecorationLabel(element, index)}</span>
              <button
                type="button"
                aria-label={`删除${getDecorationLabel(element, index)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteElement(element.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="cm-editor-panel-section">
        <div className="cm-editor-section-title">装饰线条</div>
        {lines.map((element, index) => (
          <div
            key={element.id}
            className={`cm-editor-list-row ${selectedId === element.id ? 'active' : ''}`}
            onClick={() => selectElement(element.id)}
          >
            <span>{element.direction === 'horizontal' ? '横线' : '竖线'}-{index + 1}</span>
            <button
              type="button"
              aria-label={`删除线条-${index + 1}`}
              onClick={(event) => {
                event.stopPropagation();
                deleteElement(element.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="cm-editor-secondary" onClick={addLine}>
          添加线条
        </button>
      </div>
    </aside>
  );
}

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateEditor } from './index';
import { defaultTemplates } from '../../templates/defaults';
import { useEditorStore } from './store';
import type { TemplateDefinition } from '../../templates/types';

describe('TemplateEditor', () => {
  it('toggles content elements, edits selected properties and saves template', async () => {
    const handleSave = vi.fn();

    render(<TemplateEditor initialTemplate={defaultTemplates[0]} onSave={handleSave} />);

    expect(screen.getByText('春江花月夜')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('显示标题'));
    expect(screen.queryByText('春江花月夜')).not.toBeInTheDocument();

    const addButtons = document.querySelectorAll<HTMLButtonElement>('.cm-editor-secondary');
    fireEvent.click(addButtons[1]);
    const thicknessInput = screen.getByLabelText('粗细');
    expect(thicknessInput).toHaveValue(0.5);
    fireEvent.change(thicknessInput, { target: { value: '4' } });
    expect(thicknessInput).toHaveValue(4);

    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    expect(handleSave).toHaveBeenCalledTimes(1);
    expect(handleSave.mock.calls[0][0].elements.some((element: any) => element.type === 'line')).toBe(true);
    expect(handleSave.mock.calls[0][0].meta.textCapacity.description.maxCharacters).toBeGreaterThan(0);
  });

  it('allows direct card height typing and radius editing', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    const heightInput = screen.getByLabelText('卡片高度');
    fireEvent.change(heightInput, { target: { value: '' } });
    expect(heightInput).toHaveValue(null);
    fireEvent.change(heightInput, { target: { value: '512' } });
    expect(heightInput).toHaveValue(512);

    const radiusInput = screen.getByLabelText('圆角');
    fireEvent.change(radiusInput, { target: { value: '18px' } });
    expect(radiusInput).toHaveValue('18px');
  });

  it('shows live title and description capacity in the editor', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    const panel = within(screen.getByLabelText('属性面板'));
    expect(panel.getByLabelText('容量参数')).toHaveTextContent('标题');
    expect(panel.getByLabelText('容量参数')).toHaveTextContent('横排 · 最多 10 字 · 5 字/行 × 2 行');
    expect(panel.getByLabelText('容量参数')).toHaveTextContent('摘要');
    expect(panel.getByLabelText('容量参数')).toHaveTextContent('横排 · 最多 45 字 · 9 字/行 × 5 行');

    fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '240' } });
    expect(panel.getByLabelText('容量参数')).toHaveTextContent('横排 · 最多 20 字 · 10 字/行 × 2 行');
  });

  it('lets image elements switch to a supplied static image URL', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    fireEvent.click(screen.getByTestId('cm-image-background'));
    expect((screen.getByLabelText('生成提示词') as HTMLTextAreaElement).value).toContain('中国风');

    fireEvent.change(screen.getByLabelText('生成提示词'), {
      target: { value: '自定义图片提示词' },
    });
    expect(screen.getByLabelText('生成提示词')).toHaveValue('自定义图片提示词');

    fireEvent.change(screen.getByLabelText('图片 URL'), {
      target: { value: 'https://example.com/custom.png' },
    });

    expect(screen.getByRole('button', { name: '固定图片' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('图片 URL')).toHaveValue('https://example.com/custom.png');
  });

  it('only exposes the editable text axis for each writing direction', () => {
    const horizontalTemplate = defaultTemplates.find((template) => template.id === 'curated-shanshui-blank');
    if (!horizontalTemplate) throw new Error('Missing horizontal generated template');

    const { unmount } = render(<TemplateEditor initialTemplate={horizontalTemplate} />);
    let panel = within(screen.getByLabelText('属性面板'));
    expect(panel.getByLabelText('宽度')).toBeInTheDocument();
    expect(panel.queryByLabelText('高度')).not.toBeInTheDocument();
    unmount();

    const verticalTemplate = defaultTemplates.find((template) => template.id === 'curated-cuiniao-vertical');
    if (!verticalTemplate) throw new Error('Missing vertical generated template');

    render(<TemplateEditor initialTemplate={verticalTemplate} />);
    panel = within(screen.getByLabelText('属性面板'));
    expect(panel.queryByLabelText('宽度')).not.toBeInTheDocument();
    expect(panel.getByLabelText('高度')).toBeInTheDocument();
  });
  it('supports Ctrl+Z and Ctrl+Shift+Z for property edits', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    const before = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    if (!before) throw new Error('Missing title element');

    act(() => {
      useEditorStore.getState().updateElement('title', { x: 64 });
    });
    expect(screen.getByLabelText('X')).toHaveValue(64);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.getByLabelText('X')).toHaveValue(before.x);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText('X')).toHaveValue(64);
  });

  it('records drag moves as a single undoable operation', () => {
    useEditorStore.getState().loadTemplate(defaultTemplates[0]);
    const before = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    if (!before) throw new Error('Missing title element');

    useEditorStore.getState().recordHistory();
    useEditorStore.getState().moveElement('title', 32, 16);
    const moved = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    expect(moved?.x).not.toBe(before.x);

    useEditorStore.getState().undo();
    const undone = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    expect(undone?.x).toBe(before.x);

    useEditorStore.getState().redo();
    const redone = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    expect(redone?.x).toBe(moved?.x);
  });

  it('supports text block alignment controls for horizontal and vertical text', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    fireEvent.click(within(screen.getByRole('group', { name: '纵向对齐' })).getByRole('button', { name: '下对齐' }));
    expect(useEditorStore.getState().template.elements.find((element) => element.id === 'title')).toMatchObject({
      blockAlign: 'end',
    });

    fireEvent.click(within(screen.getByRole('group', { name: '排版方向' })).getByRole('button', { name: '竖排' }));
    fireEvent.click(within(screen.getByRole('group', { name: '横向对齐' })).getByRole('button', { name: '右对齐' }));
    expect(useEditorStore.getState().template.elements.find((element) => element.id === 'title')).toMatchObject({
      direction: 'vertical',
      blockAlign: 'start',
    });
  });

  it('supports horizontal text alignment controls', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    fireEvent.click(within(screen.getByRole('group', { name: '文字对齐' })).getByRole('button', { name: '居中' }));

    expect(useEditorStore.getState().template.elements.find((element) => element.id === 'title')).toMatchObject({
      textAlign: 'center',
    });
  });

  it('supports slider controls for text tuning', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    fireEvent.change(screen.getByLabelText('字号滑条'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('最大行数滑条'), { target: { value: '3' } });

    expect(useEditorStore.getState().template.elements.find((element) => element.id === 'title')).toMatchObject({
      fontSize: 30,
      maxLines: 3,
    });
  });

  it('nudges the selected element with arrow keys', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    const before = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    if (!before) throw new Error('Missing title element');

    expect(screen.getByLabelText('X')).toHaveValue(before.x);
    expect(screen.getByLabelText('Y')).toHaveValue(before.y);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByLabelText('X')).toHaveValue(before.x + 1);

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByLabelText('Y')).toHaveValue(before.y + 10);
  });

  it('hides selection chrome while nudging with arrow keys', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    expect(document.querySelector('.cm-editor-resize-handle')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect((screen.getByTestId('cm-text-title') as HTMLElement).style.outline).toBe('');
    expect(document.querySelector('.cm-editor-resize-handle')).not.toBeInTheDocument();
  });

  it('shows alignment guides and snaps dragged elements to nearby edges', () => {
    const snapTemplate: TemplateDefinition = {
      id: 'snap-test',
      name: 'Snap Test',
      version: 1,
      width: 290,
      height: 220,
      backgroundColor: '#fffaf3',
      elements: [
        {
          id: 'title',
          type: 'text',
          role: 'title',
          x: 37,
          y: 24,
          width: 40,
          height: 40,
          fontSize: 18,
          color: '#111111',
          direction: 'horizontal',
          maxLines: 1,
        },
        {
          id: 'desc',
          type: 'text',
          role: 'description',
          x: 80,
          y: 90,
          width: 100,
          height: 60,
          fontSize: 14,
          color: '#333333',
          direction: 'horizontal',
          maxLines: 2,
        },
      ],
      meta: { category: 'test', tags: [], requiresImage: false, preferVerticalText: false, weight: 1 },
    };

    render(<TemplateEditor initialTemplate={snapTemplate} />);
    fireEvent.pointerDown(screen.getByTestId('cm-text-title'), { clientX: 0, clientY: 0 });
    const moveEvent = new Event('pointermove') as PointerEvent;
    Object.defineProperties(moveEvent, {
      clientX: { value: 4 },
      clientY: { value: 0 },
    });
    act(() => {
      window.dispatchEvent(moveEvent);
    });

    expect(useEditorStore.getState().template.elements.find((element) => element.id === 'title')).toMatchObject({
      x: 40,
    });
    expect(document.querySelector('.cm-editor-guide-vertical')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(document.querySelector('.cm-editor-guide-vertical')).not.toBeInTheDocument();
  });

  it('allows text elements to move outside the card bounds', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);

    act(() => {
      useEditorStore.getState().nudgeElement('title', -240, -160);
    });

    const moved = useEditorStore.getState().template.elements.find((element) => element.id === 'title');
    expect(moved?.x).toBeLessThan(0);
    expect(moved?.y).toBeLessThan(0);
  });

  it('exposes quote decorations and the seal stamp from the left panel', () => {
    const quoteTemplate = defaultTemplates.find((template) => template.id === 'curated-wide-mountain-quote');
    if (!quoteTemplate) throw new Error('Missing quote template');

    const { unmount } = render(<TemplateEditor initialTemplate={quoteTemplate} />);
    fireEvent.click(screen.getByText('左引号-1'));
    expect(screen.getByText('quote')).toBeInTheDocument();
    unmount();

    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);
    expect(screen.getByLabelText('显示印章')).toBeChecked();
    fireEvent.click(screen.getByTestId('cm-image-seal'));
    expect((screen.getByLabelText('生成提示词') as HTMLTextAreaElement).value).toContain('空生妙有');
  });

  it('resizes the card height from the canvas bottom handle', () => {
    render(<TemplateEditor initialTemplate={defaultTemplates[0]} />);
    const before = useEditorStore.getState().template.height;

    fireEvent.pointerDown(screen.getByRole('button', { name: '调整画布高度' }), {
      clientX: 0,
      clientY: 100,
    });
    const moveEvent = new Event('pointermove') as PointerEvent;
    Object.defineProperties(moveEvent, {
      clientX: { value: 0 },
      clientY: { value: 32 },
    });
    act(() => {
      window.dispatchEvent(moveEvent);
      window.dispatchEvent(new Event('pointerup'));
    });

    expect(useEditorStore.getState().template.height).toBe(before + 32);
  });
});
